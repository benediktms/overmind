import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import {
  MessageKind,
  NeuralLinkAdapter,
  normalizeNeuralLinkBase,
} from "./adapter.ts";

// ── normalizeNeuralLinkBase ────────────────────────────────────────────────
// Defensive strip of the legacy `/mcp` suffix and trailing slashes. Mirrors
// the same helper in cli/mcp_server.ts. Existing configs (including the
// shipped overmind.toml prior to this change) bake `/mcp` into http_url —
// without this normalize the adapter probes `${url}/mcp/health` which 404s.

Deno.test("normalizeNeuralLinkBase strips a trailing /mcp", () => {
  assertEquals(
    normalizeNeuralLinkBase("http://localhost:9961/mcp"),
    "http://localhost:9961",
  );
});

Deno.test("normalizeNeuralLinkBase strips trailing slashes", () => {
  assertEquals(
    normalizeNeuralLinkBase("http://localhost:9961/"),
    "http://localhost:9961",
  );
  assertEquals(
    normalizeNeuralLinkBase("http://localhost:9961/mcp/"),
    "http://localhost:9961",
  );
});

Deno.test("normalizeNeuralLinkBase leaves a clean base URL alone", () => {
  assertEquals(
    normalizeNeuralLinkBase("http://localhost:9961"),
    "http://localhost:9961",
  );
});

Deno.test("normalizeNeuralLinkBase does NOT strip /mcp mid-path", () => {
  // Only a literal trailing /mcp is the legacy compat shape; preserve
  // user-deliberate prefix paths.
  assertEquals(
    normalizeNeuralLinkBase("https://gw.example.com/api/mcp"),
    "https://gw.example.com/api",
  );
  assertEquals(
    normalizeNeuralLinkBase("https://example.com/mcpserver"),
    "https://example.com/mcpserver",
  );
});

Deno.test("connect tolerates a legacy /mcp-suffixed httpUrl", async () => {
  const stub = await startStub();
  try {
    const adapter = new NeuralLinkAdapter();
    // Pass the legacy shape — adapter must still find /health and /mcp.
    await adapter.connect({
      enabled: true,
      httpUrl: `${stub.url}/mcp`,
      roomTtlSeconds: 3600,
    });
    assert(
      adapter.isConnected(),
      "adapter should normalize trailing /mcp and connect",
    );
  } finally {
    await stub.shutdown();
  }
});

// ── Stub /mcp server ───────────────────────────────────────────────────────
// Drives the adapter against a controllable JSON-RPC handler so tests can
// assert the wire payload and simulate session expiry, transport errors, etc.

interface RecordedCall {
  method: string;
  toolName?: string;
  args?: Record<string, unknown>;
  hadSessionId: boolean;
  sessionIdSent: string | null;
}

interface StubBehavior {
  /** Override per-tool responses. Returns the JSON-RPC `result` payload. */
  toolResponse?: (
    toolName: string,
    args: Record<string, unknown>,
  ) => unknown;
  /** When true, the next tools/call returns 401 (one-shot — auto-clears). */
  failNextWith401?: boolean;
  /**
   * Number of consecutive tools/call requests to answer with 401 before
   * accepting. Used to test concurrent re-init coalescing (N1).
   */
  failNextN401?: number;
}

interface StubServer {
  url: string;
  calls: RecordedCall[];
  /** The mcp-session-id this server most recently handed out on initialize. */
  currentSessionId: string;
  behavior: StubBehavior;
  shutdown: () => Promise<void>;
}

async function startStub(initial: StubBehavior = {}): Promise<StubServer> {
  const calls: RecordedCall[] = [];
  let sessionCounter = 0;
  const handles: { sessionId: string; behavior: StubBehavior } = {
    sessionId: "",
    behavior: { ...initial },
  };

  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return new Response('{"status":"ok"}', {
          headers: { "content-type": "application/json" },
        });
      }

      if (req.method !== "POST" || url.pathname !== "/mcp") {
        return new Response('{"error":"Not found"}', { status: 404 });
      }

      const body = await req.json() as {
        jsonrpc: "2.0";
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      const sentSessionId = req.headers.get("mcp-session-id");

      if (body.method === "initialize") {
        sessionCounter += 1;
        handles.sessionId = `stub-session-${sessionCounter}`;
        calls.push({
          method: "initialize",
          hadSessionId: sentSessionId !== null,
          sessionIdSent: sentSessionId,
        });
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "stub", version: "0.0.0" },
            },
          }),
          {
            headers: {
              "content-type": "application/json",
              "mcp-session-id": handles.sessionId,
            },
          },
        );
      }

      if (sentSessionId === null) {
        return new Response('{"error":"Missing Mcp-Session-Id header"}', {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      if (sentSessionId !== handles.sessionId) {
        return new Response('{"error":"Invalid session"}', {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }

      if (body.method === "tools/call") {
        const params = body.params ?? {};
        const toolName = params.name as string;
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        calls.push({
          method: "tools/call",
          toolName,
          args,
          hadSessionId: true,
          sessionIdSent: sentSessionId,
        });

        if (handles.behavior.failNextWith401) {
          handles.behavior.failNextWith401 = false;
          return new Response('{"error":"Invalid session"}', {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }

        if (
          handles.behavior.failNextN401 !== undefined &&
          handles.behavior.failNextN401 > 0
        ) {
          handles.behavior.failNextN401 -= 1;
          return new Response('{"error":"Invalid session"}', {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }

        const handlerResult = handles.behavior.toolResponse?.(toolName, args) ??
          defaultToolResponse(toolName, args);
        // neural_link wraps every tool response in MCP's standard envelope:
        //   {content: [{type: "text", text: "<JSON-encoded handler result>"}],
        //    isError?: bool}
        // The stub mirrors that exactly so the adapter's unwrap logic gets
        // exercised for real.
        const envelope = isToolErrorEnvelope(handlerResult)
          ? {
            content: [{ type: "text", text: handlerResult.errorText }],
            isError: true,
          }
          : {
            content: [{ type: "text", text: JSON.stringify(handlerResult) }],
          };
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: envelope,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "Method not found" },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const addr = server.addr as Deno.NetAddr;
  const url = `http://${addr.hostname}:${addr.port}`;
  return {
    url,
    calls,
    get currentSessionId() {
      return handles.sessionId;
    },
    get behavior() {
      return handles.behavior;
    },
    shutdown: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

/**
 * Marker shape: a stub `toolResponse` that returns this object signals
 * that the response should be wrapped with `isError: true` and the
 * given text instead of the structured success envelope.
 */
interface ToolErrorEnvelope {
  __isToolError: true;
  errorText: string;
}

function toolError(errorText: string): ToolErrorEnvelope {
  return { __isToolError: true, errorText };
}

function isToolErrorEnvelope(value: unknown): value is ToolErrorEnvelope {
  return (
    value !== null && typeof value === "object" &&
    (value as { __isToolError?: unknown }).__isToolError === true
  );
}

/**
 * Default stub responses shaped to match real neural_link handler outputs.
 * Shapes are sourced from handlers.gleam:
 *   - room_leave:   line ~572 region
 *   - room_close:   line ~907 region
 *   - message_send: line ~644 region
 */
function defaultToolResponse(
  toolName: string,
  args: Record<string, unknown>,
): unknown {
  switch (toolName) {
    case "room_open":
      // participant_id is always a string when created fresh; null only on
      // already_existed: true paths. The default stub always creates fresh.
      return {
        room_id: args.id ?? "room_0123456789abcdef",
        title: args.title ?? "stub",
        status: "open",
        participant_id: String(args.participant_id ?? "lead"),
        role: "lead",
        already_existed: false,
      };
    case "room_join":
      return {
        room_id: args.room_id,
        participant_id: args.participant_id,
        joined: true,
        interaction_mode: null,
      };
    case "room_leave":
      // Real handler emits status:"departed" + drain_completed (handlers.gleam:572)
      return {
        room_id: args.room_id,
        participant_id: args.participant_id,
        status: "departed",
        drain_completed: true,
      };
    case "room_close":
      // Real handler emits status:"closed" + extraction fields (handlers.gleam:907)
      return {
        room_id: args.room_id,
        status: "closed",
        message_count: 0,
        participant_ids: [],
        decisions: [],
        open_questions: [],
        unresolved_blockers: [],
        artifact_record_id: null,
      };
    case "message_send":
      // Real handler emits message_id as the success signal (handlers.gleam:644)
      return {
        message_id: "msg_test",
        room_id: args.room_id,
        sequence: 1,
        _inbox_pending: 0,
      };
    case "message_ack":
      return { acked: true };
    case "inbox_read":
      return [];
    case "wait_for":
      return {
        message_id: "msg_a",
        from: "x",
        kind: "finding",
        summary: "s",
        sequence: 1,
      };
    case "thread_summarize":
      return {
        decisions: [],
        open_questions: [],
        blockers: [],
        participant_count: 1,
        message_count: 0,
      };
    default:
      return null;
  }
}

async function makeAdapter(stub: StubServer): Promise<NeuralLinkAdapter> {
  const adapter = new NeuralLinkAdapter();
  await adapter.connect({
    enabled: true,
    httpUrl: stub.url,
    roomTtlSeconds: 3600,
  });
  return adapter;
}

// ── Connect / handshake ────────────────────────────────────────────────────

Deno.test("connect performs initialize handshake and stores session id", async () => {
  const stub = await startStub();
  try {
    const adapter = await makeAdapter(stub);
    assert(
      adapter.isConnected(),
      "adapter should be connected after handshake",
    );
    assertEquals(adapter.getSessionId(), stub.currentSessionId);
    // Exactly one initialize call recorded — no double handshake.
    assertEquals(
      stub.calls.filter((c) => c.method === "initialize").length,
      1,
    );
  } finally {
    await stub.shutdown();
  }
});

Deno.test("connect stays disconnected when /health is unreachable", async () => {
  const adapter = new NeuralLinkAdapter();
  // Port 1 is reserved/unbound — connection refuses fast.
  await adapter.connect({
    enabled: true,
    httpUrl: "http://127.0.0.1:1",
    roomTtlSeconds: 3600,
  });
  assertFalse(adapter.isConnected());
});

// ── Per-tool wire format ───────────────────────────────────────────────────

Deno.test("roomOpen emits tools/call with snake_case args and the session id", async () => {
  const stub = await startStub();
  try {
    const adapter = await makeAdapter(stub);
    const roomId = await adapter.roomOpen({
      title: "test room",
      participantId: "lead-a",
      displayName: "Lead",
      purpose: "x",
    });
    assertEquals(roomId, "room_0123456789abcdef");

    const toolCall = stub.calls.find((c) => c.method === "tools/call");
    assert(toolCall, "expected a tools/call");
    assertEquals(toolCall.toolName, "room_open");
    assertEquals(toolCall.args, {
      title: "test room",
      participant_id: "lead-a",
      display_name: "Lead",
      purpose: "x",
    });
    assertEquals(toolCall.sessionIdSent, stub.currentSessionId);
  } finally {
    await stub.shutdown();
  }
});

Deno.test("roomOpen forwards a caller-supplied id verbatim (deterministic id)", async () => {
  const stub = await startStub();
  try {
    const adapter = await makeAdapter(stub);
    const desiredId = "room_aaaa0000bbbb1111";
    const roomId = await adapter.roomOpen({
      id: desiredId,
      title: "deterministic",
      participantId: "p",
      displayName: "P",
    });
    // The stub echoes back args.id when present.
    assertEquals(roomId, desiredId);

    const toolCall = stub.calls.find((c) => c.method === "tools/call");
    assert(toolCall);
    assertEquals(toolCall.args?.id, desiredId);
  } finally {
    await stub.shutdown();
  }
});

Deno.test("roomJoin returns true when the server reports joined: true", async () => {
  const stub = await startStub();
  try {
    const adapter = await makeAdapter(stub);
    const ok = await adapter.roomJoin(
      "room_aaaa0000bbbb1111",
      "p",
      "P",
      "observer",
    );
    assert(ok);

    const toolCall = stub.calls.find((c) => c.method === "tools/call");
    assert(toolCall);
    assertEquals(toolCall.toolName, "room_join");
    assertEquals(toolCall.args, {
      room_id: "room_aaaa0000bbbb1111",
      participant_id: "p",
      display_name: "P",
      role: "observer",
    });
  } finally {
    await stub.shutdown();
  }
});

Deno.test("messageAck encodes message_ids as a comma-separated string", async () => {
  const stub = await startStub();
  try {
    const adapter = await makeAdapter(stub);
    const ok = await adapter.messageAck("room_x", "p", [
      "msg_a",
      "msg_b",
      "msg_c",
    ]);
    assert(ok);
    const toolCall = stub.calls.find((c) => c.method === "tools/call");
    assert(toolCall);
    assertEquals(toolCall.args?.message_ids, "msg_a,msg_b,msg_c");
  } finally {
    await stub.shutdown();
  }
});

Deno.test("messageSend forwards optional fields only when present", async () => {
  const stub = await startStub();
  try {
    const adapter = await makeAdapter(stub);
    await adapter.messageSend({
      roomId: "r",
      from: "p",
      kind: MessageKind.Finding,
      summary: "s",
      // body / to / threadId / persistHint omitted on purpose
    });
    const toolCall = stub.calls.find((c) => c.method === "tools/call");
    assert(toolCall);
    assertEquals(Object.keys(toolCall.args!).sort(), [
      "from",
      "kind",
      "room_id",
      "summary",
    ]);
  } finally {
    await stub.shutdown();
  }
});

Deno.test("messageSend returns true when server emits message_id (real handler contract)", async () => {
  // Confirms the N2 success contract: messageSend pins to message_id presence,
  // not `sent: true`. The default stub now returns the real handler shape.
  const stub = await startStub();
  try {
    const adapter = await makeAdapter(stub);
    const ok = await adapter.messageSend({
      roomId: "room_0123456789abcdef",
      from: "p",
      kind: MessageKind.Finding,
      summary: "finding",
    });
    assert(ok, "messageSend should return true when message_id is present");
  } finally {
    await stub.shutdown();
  }
});

Deno.test("roomLeave returns true when server emits status:departed (real handler contract)", async () => {
  // Confirms the N2 success contract: roomLeave pins to status:"departed",
  // not a bare null-check. The default stub now returns the real handler shape.
  const stub = await startStub();
  try {
    const adapter = await makeAdapter(stub);
    const ok = await adapter.roomLeave(
      "room_0123456789abcdef",
      "p",
    );
    assert(ok, "roomLeave should return true when status is departed");
  } finally {
    await stub.shutdown();
  }
});

Deno.test("roomClose returns true when server emits status:closed (real handler contract)", async () => {
  // Confirms the N2 success contract: roomClose pins to status:"closed",
  // not a bare null-check. The default stub now returns the real handler shape.
  const stub = await startStub();
  try {
    const adapter = await makeAdapter(stub);
    const ok = await adapter.roomClose(
      "room_0123456789abcdef",
      "completed",
    );
    assert(ok, "roomClose should return true when status is closed");
  } finally {
    await stub.shutdown();
  }
});

Deno.test("inboxRead returns the raw array result (not wrapped in {messages})", async () => {
  const stub = await startStub({
    toolResponse: (name) => {
      if (name === "inbox_read") {
        return [
          {
            message_id: "msg_a",
            from: "x",
            kind: "finding",
            summary: "s",
            sequence: 1,
            created_at: "2026-04-29T00:00:00Z",
          },
          {
            message_id: "msg_b",
            from: "y",
            kind: "answer",
            summary: "t",
            sequence: 2,
            created_at: "2026-04-29T00:00:01Z",
          },
        ];
      }
      return null;
    },
  });
  try {
    const adapter = await makeAdapter(stub);
    const messages = await adapter.inboxRead("r", "p");
    assertEquals(messages.length, 2);
    assertEquals(messages[0].message_id, "msg_a");
  } finally {
    await stub.shutdown();
  }
});

// ── Session expiry / re-init ───────────────────────────────────────────────

Deno.test("on 401 the adapter re-initializes once and retries the call", async () => {
  const stub = await startStub({ failNextWith401: true });
  try {
    const adapter = await makeAdapter(stub);
    const initialSessionId = adapter.getSessionId();
    const ok = await adapter.roomJoin("room_aaaa0000bbbb1111", "p", "P");
    assert(ok, "roomJoin should succeed after the auto re-init");
    // Session id must have rotated — we expect a *new* mcp-session-id
    // after the re-handshake.
    assert(adapter.getSessionId() !== initialSessionId);

    const initializeCalls = stub.calls.filter((c) => c.method === "initialize");
    assertEquals(
      initializeCalls.length,
      2,
      "expected one initial + one re-init",
    );
    const toolCalls = stub.calls.filter((c) => c.method === "tools/call");
    assertEquals(toolCalls.length, 2, "expected the failed call + the retry");
    // The retry must have carried the *new* session id.
    assertEquals(toolCalls[1].sessionIdSent, adapter.getSessionId());
  } finally {
    await stub.shutdown();
  }
});

Deno.test("concurrent re-inits coalesce to a single initialize call (N1)", async () => {
  // The stub answers the first 3 tools/call requests with 401, then accepts.
  // Three concurrent roomJoin calls all hit 401, all try to re-init — but
  // ensureFreshSession() coalesces them behind a single Promise<void>.
  // Assert that exactly ONE re-init round-trip hit the server (not three).
  const stub = await startStub({ failNextN401: 3 });
  try {
    const adapter = await makeAdapter(stub);

    // Launch 3 concurrent calls. Each will see a 401 and trigger re-init,
    // but the coalescing lock means only one initialize() goes out.
    const [ok1, ok2, ok3] = await Promise.all([
      adapter.roomJoin("room_aaaa0000bbbb1111", "p1", "P1"),
      adapter.roomJoin("room_aaaa0000bbbb1111", "p2", "P2"),
      adapter.roomJoin("room_aaaa0000bbbb1111", "p3", "P3"),
    ]);

    const initializeCalls = stub.calls.filter((c) => c.method === "initialize");
    assertEquals(
      initializeCalls.length,
      2, // one initial connect + exactly one re-init (not 1+3)
      `expected 1 initial + 1 re-init, got ${initializeCalls.length} initialize calls`,
    );

    // At least one of the three calls should have succeeded after the
    // single re-init. (Others may have gotten a 401 on their retry if the
    // stub's counter ran out before them — that is acceptable; the key
    // invariant is only ONE re-init occurred.)
    assert(
      ok1 || ok2 || ok3,
      "at least one concurrent call should succeed after re-init",
    );
  } finally {
    await stub.shutdown();
  }
});

Deno.test("tool-error envelope (isError: true) yields null/false without throwing", async () => {
  // Pins the unwrap of MCP's standard tool-level error envelope:
  //   {content: [{type: "text", text: "<msg>"}], isError: true}
  // Distinct from a JSON-RPC protocol error — neural_link uses isError for
  // handler-rejected calls (e.g. invalid id format on room_open).
  const stub = await startStub({
    toolResponse: () => toolError("invalid id: room_id must match …"),
  });
  try {
    const adapter = await makeAdapter(stub);
    const ok = await adapter.roomJoin("room_aaaa0000bbbb1111", "p", "P");
    assertFalse(ok);
  } finally {
    await stub.shutdown();
  }
});

Deno.test("tool-error path is distinct from parse-error: warn message contains 'tool error:' prefix (B3)", async () => {
  // Mutation test confirmed: removing the isError check makes JSON.parse
  // throw (the error text is not valid JSON), which falls through to the
  // parse-error branch. This test pins the *semantic* distinction — the
  // warn message must carry the 'tool error:' prefix that warnFailure emits
  // for kind:"tool-error", not the 'malformed JSON-RPC response:' prefix
  // that the parse-error branch would emit.
  const stub = await startStub({
    toolResponse: () => toolError("invalid id: room_id must match …"),
  });

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  try {
    const adapter = await makeAdapter(stub);
    const ok = await adapter.roomJoin("room_aaaa0000bbbb1111", "p", "P");
    assertFalse(ok);

    assertEquals(warnings.length, 1, "expected exactly one console.warn call");
    assertStringIncludes(
      warnings[0],
      "tool error:",
      "warn message must carry the 'tool error:' prefix, not 'malformed JSON-RPC response:'",
    );
  } finally {
    console.warn = originalWarn;
    await stub.shutdown();
  }
});

Deno.test("non-JSON 200 response returns null and warns with 'malformed JSON-RPC response' (N6)", async () => {
  // Drives a 200 response with a non-JSON body (raw HTML) through callToolOnce
  // and asserts the adapter returns null AND console.warn was called with
  // the parse-error prefix.
  const stub = await startStubWithRawBody(
    200,
    "<html><body>Bad gateway</body></html>",
    "text/html",
  );

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  try {
    const adapter = await makeAdapter(stub);
    const result = await adapter.roomJoin("room_x", "p", "P");
    assertFalse(result, "should return false/null on non-JSON response");

    assert(warnings.length > 0, "expected at least one console.warn call");
    assertStringIncludes(
      warnings[0],
      "malformed JSON-RPC response",
      "warn message must contain 'malformed JSON-RPC response'",
    );
  } finally {
    console.warn = originalWarn;
    await stub.shutdown();
  }
});

Deno.test("room_open unwraps the MCP envelope and returns the inner room_id", async () => {
  // Direct regression for the bug we shipped on the first cut: the
  // adapter previously assumed `result` was the unwrapped handler shape,
  // but neural_link's tools/call always wraps it in `{content:[{text}]}`.
  // The default stub response now exercises that envelope end-to-end —
  // this test asserts the inner room_id is extracted from the text JSON
  // string rather than read off the (non-existent) top-level field.
  const stub = await startStub({
    toolResponse: (name, args) => {
      if (name !== "room_open") return null;
      return {
        room_id: args.id ?? "room_deadbeefdeadbeef",
        title: args.title,
        status: "open",
        participant_id: args.participant_id,
        role: "lead",
        already_existed: false,
      };
    },
  });
  try {
    const adapter = await makeAdapter(stub);
    const roomId = await adapter.roomOpen({
      id: "room_cafef00dcafef00d",
      title: "envelope round-trip",
      participantId: "lead",
      displayName: "Lead",
    });
    assertEquals(roomId, "room_cafef00dcafef00d");
  } finally {
    await stub.shutdown();
  }
});

Deno.test("rpc errors return the adapter's null/false sentinel without throwing", async () => {
  const stub = await startStub({
    toolResponse: () => {
      throw new Error("unreachable — overridden below");
    },
  });
  // Override the response handler to emit a JSON-RPC error envelope.
  // We do this by re-using the stub with a custom behavior.
  await stub.shutdown();
  const stub2 = await startStubWithError(-32602, "missing param");
  try {
    const adapter = await makeAdapter(stub2);
    const result = await adapter.roomJoin("room_x", "p", "P");
    assertFalse(result);
  } finally {
    await stub2.shutdown();
  }
});

// Variant of startStub that always returns a JSON-RPC error response on
// tools/call. Used for the "rpc error → null sentinel" test.
async function startStubWithError(
  code: number,
  message: string,
): Promise<StubServer> {
  const calls: RecordedCall[] = [];
  let sessionCounter = 0;
  const handles: { sessionId: string; behavior: StubBehavior } = {
    sessionId: "",
    behavior: {},
  };
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return new Response('{"status":"ok"}');
      }
      const body = await req.json() as { id: number; method: string };
      if (body.method === "initialize") {
        sessionCounter += 1;
        handles.sessionId = `stub-session-${sessionCounter}`;
        calls.push({
          method: "initialize",
          hadSessionId: false,
          sessionIdSent: null,
        });
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }),
          { headers: { "mcp-session-id": handles.sessionId } },
        );
      }
      // tools/call → JSON-RPC error response.
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code, message },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );
  const addr = server.addr as Deno.NetAddr;
  return {
    url: `http://${addr.hostname}:${addr.port}`,
    calls,
    get currentSessionId() {
      return handles.sessionId;
    },
    get behavior() {
      return handles.behavior;
    },
    shutdown: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

/**
 * Stub variant that returns a raw non-JSON body on tools/call requests.
 * Used for the parse-error path test (N6).
 */
async function startStubWithRawBody(
  status: number,
  body: string,
  contentType: string,
): Promise<StubServer> {
  const calls: RecordedCall[] = [];
  let sessionCounter = 0;
  const handles: { sessionId: string; behavior: StubBehavior } = {
    sessionId: "",
    behavior: {},
  };
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return new Response('{"status":"ok"}');
      }
      const reqBody = await req.json() as { id: number; method: string };
      if (reqBody.method === "initialize") {
        sessionCounter += 1;
        handles.sessionId = `stub-session-${sessionCounter}`;
        calls.push({
          method: "initialize",
          hadSessionId: false,
          sessionIdSent: null,
        });
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: reqBody.id, result: {} }),
          { headers: { "mcp-session-id": handles.sessionId } },
        );
      }
      // tools/call → raw non-JSON body.
      return new Response(body, {
        status,
        headers: { "content-type": contentType },
      });
    },
  );
  const addr = server.addr as Deno.NetAddr;
  return {
    url: `http://${addr.hostname}:${addr.port}`,
    calls,
    get currentSessionId() {
      return handles.sessionId;
    },
    get behavior() {
      return handles.behavior;
    },
    shutdown: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

import { assert, assertEquals, assertFalse } from "@std/assert";
import { MessageKind, NeuralLinkAdapter } from "./adapter.ts";

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

        const result = handles.behavior.toolResponse?.(toolName, args) ??
          defaultToolResponse(toolName, args);
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result,
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

function defaultToolResponse(
  toolName: string,
  args: Record<string, unknown>,
): unknown {
  switch (toolName) {
    case "room_open":
      return {
        room_id: args.id ?? "room_0123456789abcdef",
        title: args.title ?? "stub",
        status: "open",
        participant_id: args.participant_id ?? null,
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
      return { left: true };
    case "room_close":
      return { closed: true };
    case "message_send":
      return { sent: true };
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

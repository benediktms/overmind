import { assertEquals } from "@std/assert";

import { type DelegateSink, MCPServer, type MCPWriter, normalizeNeuralLinkBase } from "./mcp_server.ts";
import type { SocketRequest, SocketResponse } from "../kernel/types.ts";

// ── Test harness ────────────────────────────────────────────────────────────
// Drives MCPServer.feed() with synthetic input and captures every emitted
// response into a buffer for assertion. No stdin/stdout, no network, no
// daemon — fully hermetic.

interface Captured {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface RecordedDelegate {
  request: SocketRequest;
  baseDir: string;
}

function makeServer(opts: {
  delegateResponse?: SocketResponse;
  delegateThrows?: Error;
} = {}): {
  server: MCPServer;
  out: Captured[];
  delegateCalls: RecordedDelegate[];
} {
  const out: Captured[] = [];
  const delegateCalls: RecordedDelegate[] = [];
  const writer: MCPWriter = (msg) => {
    out.push(msg as Captured);
  };
  const sink: DelegateSink = (request, baseDir) => {
    delegateCalls.push({ request, baseDir });
    if (opts.delegateThrows) return Promise.reject(opts.delegateThrows);
    return Promise.resolve(opts.delegateResponse ?? {
      status: "accepted",
      run_id: request.type === "mode_request" ? request.run_id : "test-run",
      error: null,
    });
  };
  const server = new MCPServer(
    {
      neuralLinkBase: "http://invalid.test",
      kernelHttpUrl: "http://invalid.test",
      baseDir: "/tmp/test-overmind",
      roomId: "",
      participantId: "test",
    },
    writer,
    sink,
  );
  return { server, out, delegateCalls };
}

async function callTool(
  server: MCPServer,
  name: string,
  args: Record<string, unknown>,
  id = 42,
): Promise<void> {
  await server.feed(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }) + "\n",
    "",
  );
}

function parseToolText(captured: Captured): unknown {
  const result = captured.result as { content: { text: string }[] } | undefined;
  if (!result?.content?.[0]?.text) {
    throw new Error(`tool result missing content.text: ${JSON.stringify(captured)}`);
  }
  return JSON.parse(result.content[0].text);
}

// The historical default for OVERMIND_NEURAL_LINK_URL was
// http://localhost:9961/mcp — i.e. with the `/mcp` JSON-RPC path baked in.
// Newer config treats the env var as the SERVER BASE URL so the same value
// can serve `${base}/health` (liveness) and `${base}/mcp` (JSON-RPC). The
// normalize helper accepts both shapes for backward compat. These tests
// pin that contract.

Deno.test("normalizeNeuralLinkBase strips the legacy /mcp suffix", () => {
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
    normalizeNeuralLinkBase("http://localhost:9961///"),
    "http://localhost:9961",
  );
});

Deno.test("normalizeNeuralLinkBase strips trailing slash + /mcp combos", () => {
  assertEquals(
    normalizeNeuralLinkBase("http://localhost:9961/mcp/"),
    "http://localhost:9961",
  );
});

Deno.test("normalizeNeuralLinkBase leaves a bare base URL alone", () => {
  assertEquals(
    normalizeNeuralLinkBase("http://localhost:9961"),
    "http://localhost:9961",
  );
});

Deno.test("normalizeNeuralLinkBase preserves non-default hosts and ports", () => {
  assertEquals(
    normalizeNeuralLinkBase("https://nl.example.com:8443/mcp"),
    "https://nl.example.com:8443",
  );
});

Deno.test("normalizeNeuralLinkBase does NOT strip /mcp when it is mid-path", () => {
  // Prefix-paths like /api/mcp are user-deliberate; only a literal /mcp at
  // the END is the legacy compat case.
  assertEquals(
    normalizeNeuralLinkBase("https://gateway.example.com/api/mcp"),
    "https://gateway.example.com/api",
  );
  // But /mcpsomething is not /mcp, so leave it.
  assertEquals(
    normalizeNeuralLinkBase("https://example.com/mcpserver"),
    "https://example.com/mcpserver",
  );
});

// ── JSON-RPC dispatch / framing ────────────────────────────────────────────

Deno.test("feed handles a valid initialize request with id", async () => {
  const { server, out } = makeServer();
  const remainder = await server.feed(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n",
    "",
  );
  assertEquals(remainder, "");
  assertEquals(out.length, 1);
  assertEquals(out[0].id, 1);
  assertEquals(typeof out[0].result, "object");
});

Deno.test("feed buffers a partial line until newline arrives", async () => {
  const { server, out } = makeServer();
  const msg = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} });
  // Send the message in two halves with no newline in the first.
  let buf = await server.feed(msg.slice(0, 20), "");
  assertEquals(out.length, 0);
  buf = await server.feed(msg.slice(20) + "\n", buf);
  assertEquals(buf, "");
  assertEquals(out.length, 1);
  assertEquals(out[0].id, 7);
});

// ── DoS guard: oversized line ──────────────────────────────────────────────

Deno.test("feed rejects an unterminated line larger than MAX_LINE_SIZE with a parse error and resets the buffer", async () => {
  const { server, out } = makeServer();
  // Build a 1MB+1 byte payload with no newline.
  const big = "x".repeat((1 << 20) + 1);
  const buf = await server.feed(big, "");
  assertEquals(buf, "", "buffer must be reset to prevent unbounded growth");
  assertEquals(out.length, 1);
  assertEquals(out[0].id, null, "parse errors must use id null per JSON-RPC spec");
  assertEquals(out[0].error?.code, -32700);
  // After the reset, a normal message must still be processed.
  await server.feed(
    JSON.stringify({ jsonrpc: "2.0", id: 99, method: "initialize", params: {} }) + "\n",
    buf,
  );
  assertEquals(out.length, 2);
  assertEquals(out[1].id, 99);
});

Deno.test("feed does NOT reject large input that contains newlines (legitimate batch)", async () => {
  const { server, out } = makeServer();
  // A long stream of small messages totaling > MAX_LINE_SIZE is legitimate
  // and must not trip the guard — the guard only triggers when a SINGLE
  // line exceeds the cap.
  const oneMsg =
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n";
  const lots = oneMsg.repeat(10000); // ~700KB+, all newline-terminated
  const buf = await server.feed(lots, "");
  assertEquals(buf, "");
  // No parse-error response in the output stream.
  const parseErrors = out.filter((m) => m.error?.code === -32700);
  assertEquals(parseErrors.length, 0);
});

// ── JSON-RPC error responses ───────────────────────────────────────────────

Deno.test("feed responds with id null on malformed JSON (parse error)", async () => {
  const { server, out } = makeServer();
  await server.feed("{this is not valid json}\n", "");
  assertEquals(out.length, 1);
  assertEquals(out[0].id, null);
  assertEquals(out[0].error?.code, -32700);
});

Deno.test("feed responds with id null on non-object JSON (invalid request)", async () => {
  const { server, out } = makeServer();
  // Valid JSON but not a JSON-RPC request object — spec says respond with
  // -32600 Invalid Request, id null.
  await server.feed("[1,2,3]\n", "");
  assertEquals(out.length, 1);
  assertEquals(out[0].id, null);
  assertEquals(out[0].error?.code, -32600);
});

Deno.test("feed silently ignores notifications (method, no id)", async () => {
  const { server, out } = makeServer();
  // notifications/initialized has no id and per spec must NOT produce a
  // response.
  await server.feed(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    "",
  );
  assertEquals(out.length, 0);
});

Deno.test("feed responds with id null when method-not-found arrives without an id", async () => {
  // Clients shouldn't send tools/call without an id, but if they do, our
  // historical code dropped the response silently. Verify we now emit one
  // (per the security review's concern).
  const { server, out } = makeServer();
  // Method-not-found typed as a request with id but a bogus method.
  await server.feed(
    JSON.stringify({ jsonrpc: "2.0", id: 5, method: "no/such/method" }) + "\n",
    "",
  );
  assertEquals(out.length, 1);
  assertEquals(out[0].id, 5);
  assertEquals(out[0].error?.code, -32601);
});

Deno.test("feed handles multiple newline-delimited messages in one chunk", async () => {
  const { server, out } = makeServer();
  const a = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const b = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await server.feed(a + "\n" + b + "\n", "");
  assertEquals(out.length, 2);
  assertEquals(out[0].id, 1);
  assertEquals(out[1].id, 2);
});

Deno.test("feed skips blank lines between messages", async () => {
  const { server, out } = makeServer();
  await server.feed(
    "\n" + JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n\n",
    "",
  );
  assertEquals(out.length, 1);
});

// ── overmind_delegate forwards via the daemon socket ───────────────────────
// The delegate path used to hit non-existent /objective and /room/open
// endpoints. It now goes through the same `mode_request` envelope the CLI
// uses. These tests pin the wire format and the success/error contracts
// without touching a real daemon.

Deno.test("overmind_delegate forwards a mode_request through the delegate sink", async () => {
  const { server, out, delegateCalls } = makeServer();
  await callTool(server, "overmind_delegate", {
    objective: "refactor the auth middleware",
    mode: "relay",
    priority: 2,
  });
  assertEquals(delegateCalls.length, 1);
  const req = delegateCalls[0].request;
  assertEquals(req.type, "mode_request");
  if (req.type === "mode_request") {
    assertEquals(req.objective, "refactor the auth middleware");
    assertEquals(req.mode, "relay");
    assertEquals(req.config_override?.max_fix_cycles, 3);
    assertEquals(req.run_id.startsWith("run-"), true);
  }
  assertEquals(delegateCalls[0].baseDir, "/tmp/test-overmind");

  const payload = parseToolText(out[0]) as { success: boolean; mode: string };
  assertEquals(payload.success, true);
  assertEquals(payload.mode, "relay");
});

Deno.test("overmind_delegate uses 0 fix cycles for scout mode", async () => {
  const { server, delegateCalls } = makeServer();
  await callTool(server, "overmind_delegate", { objective: "research X", mode: "scout" });
  const req = delegateCalls[0].request;
  if (req.type === "mode_request") {
    assertEquals(req.config_override?.max_fix_cycles, 0);
  }
});

Deno.test("overmind_delegate rejects an empty objective without contacting the daemon", async () => {
  const { server, out, delegateCalls } = makeServer();
  await callTool(server, "overmind_delegate", { objective: "   ", mode: "scout" });
  assertEquals(delegateCalls.length, 0, "delegate sink must not be called for empty objective");
  const payload = parseToolText(out[0]) as { success: boolean; error: string };
  assertEquals(payload.success, false);
  assertEquals(payload.error, "objective is required");
});

Deno.test("overmind_delegate rejects an unknown mode", async () => {
  const { server, out, delegateCalls } = makeServer();
  await callTool(server, "overmind_delegate", { objective: "do thing", mode: "ludicrous" });
  assertEquals(delegateCalls.length, 0);
  const payload = parseToolText(out[0]) as { success: boolean; error: string };
  assertEquals(payload.success, false);
  assertEquals(payload.error.includes("invalid mode"), true);
});

Deno.test("overmind_delegate surfaces a daemon error response", async () => {
  const { server, out } = makeServer({
    delegateResponse: { status: "error", run_id: "run-x", error: "kernel busy" },
  });
  await callTool(server, "overmind_delegate", { objective: "do thing", mode: "swarm" });
  const payload = parseToolText(out[0]) as { success: boolean; error: string };
  assertEquals(payload.success, false);
  assertEquals(payload.error, "kernel busy");
});

Deno.test("overmind_delegate surfaces a thrown error from the sink as a failure result", async () => {
  const { server, out } = makeServer({
    delegateThrows: new Error("daemon socket refused"),
  });
  await callTool(server, "overmind_delegate", { objective: "do thing", mode: "scout" });
  const payload = parseToolText(out[0]) as { success: boolean; error: string };
  assertEquals(payload.success, false);
  assertEquals(payload.error, "daemon socket refused");
});

Deno.test("overmind_cancel returns a clear not-yet-implemented error (was a broken neural_link REST call)", async () => {
  const { server, out, delegateCalls } = makeServer();
  await callTool(server, "overmind_cancel", { objective_id: "run-foo" });
  assertEquals(delegateCalls.length, 0);
  const payload = parseToolText(out[0]) as { success: boolean; error: string };
  assertEquals(payload.success, false);
  assertEquals(payload.error.includes("not yet implemented"), true);
});

Deno.test("overmind_room_join returns a clear not-yet-supported error (was a broken neural_link REST call)", async () => {
  const { server, out, delegateCalls } = makeServer();
  await callTool(server, "overmind_room_join", { room_id: "room-1" });
  assertEquals(delegateCalls.length, 0);
  const payload = parseToolText(out[0]) as { success: boolean; error: string };
  assertEquals(payload.success, false);
  assertEquals(payload.error.includes("not yet supported"), true);
});

import { assertEquals } from "@std/assert";

import { normalizeNeuralLinkBase } from "./mcp_server.ts";

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

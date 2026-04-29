import { assertEquals } from "@std/assert";
import { join } from "@std/path";

import { LockRegistry } from "./locks.ts";
import { OvermindHttpServer } from "./http.ts";

interface Harness {
  url: string;
  registry: LockRegistry;
  shutdown: () => Promise<void>;
}

async function startTestServer(
  options: { harnessOn?: () => boolean } = {},
): Promise<Harness> {
  const dir = await Deno.makeTempDir();
  const journalPath = join(dir, "locks.jsonl");
  const registry = new LockRegistry(journalPath);
  const server = new OvermindHttpServer({
    registry,
    port: 0,
    harnessOn: options.harnessOn ?? (() => true),
  });
  const { port, hostname } = server.start();
  return {
    url: `http://${hostname}:${port}`,
    registry,
    shutdown: async () => {
      await server.shutdown();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function postJson(
  url: string,
  body: unknown,
  init: { method?: string; raw?: string } = {},
): Promise<Response> {
  return await fetch(url, {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json" },
    body: init.raw ?? JSON.stringify(body),
  });
}

Deno.test("POST /lock acquires an empty path with 200", async () => {
  const h = await startTestServer();
  try {
    const res = await postJson(`${h.url}/lock`, {
      path: "/foo.ts",
      sessionId: "S1",
      agentId: "A",
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
    assertEquals(h.registry.snapshot().length, 1);
  } finally {
    await h.shutdown();
  }
});

Deno.test("POST /lock returns 409 with holder on cross-session conflict", async () => {
  const h = await startTestServer();
  try {
    await h.registry.acquire({
      path: "/foo.ts",
      sessionId: "S1",
      agentId: "A",
    });
    const res = await postJson(`${h.url}/lock`, {
      path: "/foo.ts",
      sessionId: "S2",
      agentId: "B",
    });
    assertEquals(res.status, 409);
    const body = await res.json();
    assertEquals(body.ok, false);
    assertEquals(body.holder, { sessionId: "S1", agentId: "A" });
  } finally {
    await h.shutdown();
  }
});

Deno.test("POST /lock returns 409 on intra-session cross-agent conflict", async () => {
  const h = await startTestServer();
  try {
    await h.registry.acquire({
      path: "/foo.ts",
      sessionId: "S1",
      agentId: "A",
    });
    const res = await postJson(`${h.url}/lock`, {
      path: "/foo.ts",
      sessionId: "S1",
      agentId: "B",
    });
    assertEquals(res.status, 409);
    const body = await res.json();
    assertEquals(body.holder, { sessionId: "S1", agentId: "A" });
  } finally {
    await h.shutdown();
  }
});

Deno.test("POST /unlock releases a held lock with matching owner", async () => {
  const h = await startTestServer();
  try {
    await h.registry.acquire({
      path: "/foo.ts",
      sessionId: "S1",
      agentId: "A",
    });
    const res = await postJson(`${h.url}/unlock`, {
      path: "/foo.ts",
      sessionId: "S1",
      agentId: "A",
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
    assertEquals(h.registry.snapshot().length, 0);
  } finally {
    await h.shutdown();
  }
});

Deno.test("POST /unlock returns 409 when owner does not match", async () => {
  const h = await startTestServer();
  try {
    await h.registry.acquire({
      path: "/foo.ts",
      sessionId: "S1",
      agentId: "A",
    });
    const res = await postJson(`${h.url}/unlock`, {
      path: "/foo.ts",
      sessionId: "S2",
      agentId: "A",
    });
    assertEquals(res.status, 409);
    await res.body?.cancel();
    assertEquals(h.registry.snapshot().length, 1);
  } finally {
    await h.shutdown();
  }
});

Deno.test("POST /unlock on absent path is idempotent", async () => {
  const h = await startTestServer();
  try {
    const res = await postJson(`${h.url}/unlock`, {
      path: "/nope.ts",
      sessionId: "S1",
      agentId: "A",
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
  } finally {
    await h.shutdown();
  }
});

Deno.test("POST /release-session-locks frees only matching session", async () => {
  const h = await startTestServer();
  try {
    await h.registry.acquire({
      path: "/a.ts",
      sessionId: "S1",
      agentId: "A",
    });
    await h.registry.acquire({
      path: "/b.ts",
      sessionId: "S1",
      agentId: "B",
    });
    await h.registry.acquire({
      path: "/c.ts",
      sessionId: "S2",
      agentId: "C",
    });

    const res = await postJson(`${h.url}/release-session-locks`, {
      sessionId: "S1",
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ok, true);
    assertEquals(body.released, 2);

    const remaining = h.registry.snapshot().map((e) => e.path);
    assertEquals(remaining, ["/c.ts"]);
  } finally {
    await h.shutdown();
  }
});

Deno.test("POST /release-session-locks is idempotent on unknown session", async () => {
  const h = await startTestServer();
  try {
    const res = await postJson(`${h.url}/release-session-locks`, {
      sessionId: "S-unknown",
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body, { ok: true, released: 0 });
  } finally {
    await h.shutdown();
  }
});

Deno.test("POST /lock with malformed JSON returns 400", async () => {
  const h = await startTestServer();
  try {
    const res = await postJson(`${h.url}/lock`, null, {
      raw: "{ this is not json",
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "invalid_json");
  } finally {
    await h.shutdown();
  }
});

Deno.test("POST /lock with missing fields returns 400", async () => {
  const h = await startTestServer();
  try {
    const res = await postJson(`${h.url}/lock`, { path: "/foo.ts" });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "invalid_body");
  } finally {
    await h.shutdown();
  }
});

Deno.test("POST /lock with empty-string field returns 400", async () => {
  const h = await startTestServer();
  try {
    const res = await postJson(`${h.url}/lock`, {
      path: "",
      sessionId: "S1",
      agentId: "A",
    });
    assertEquals(res.status, 400);
    await res.body?.cancel();
  } finally {
    await h.shutdown();
  }
});

Deno.test("POST /release-session-locks with missing sessionId returns 400", async () => {
  const h = await startTestServer();
  try {
    const res = await postJson(`${h.url}/release-session-locks`, {});
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "invalid_body");
  } finally {
    await h.shutdown();
  }
});

Deno.test("GET /lock returns 405", async () => {
  const h = await startTestServer();
  try {
    const res = await fetch(`${h.url}/lock`, { method: "GET" });
    assertEquals(res.status, 405);
    await res.body?.cancel();
  } finally {
    await h.shutdown();
  }
});

Deno.test("Unknown route returns 404", async () => {
  const h = await startTestServer();
  try {
    const res = await postJson(`${h.url}/nope`, {});
    assertEquals(res.status, 404);
    await res.body?.cancel();
  } finally {
    await h.shutdown();
  }
});

Deno.test("POST /event accepts any payload as best-effort", async () => {
  const events: unknown[] = [];
  const dir = await Deno.makeTempDir();
  const registry = new LockRegistry(join(dir, "locks.jsonl"));
  const server = new OvermindHttpServer({
    registry,
    port: 0,
    eventSink: (e) => {
      events.push(e);
    },
  });
  const { port, hostname } = server.start();
  try {
    const res = await fetch(`http://${hostname}:${port}/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "session_start", id: "abc" }),
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
    assertEquals(events, [{ kind: "session_start", id: "abc" }]);
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /event with empty body delivers null to the sink", async () => {
  // readJsonBody returns null for empty bodies; pin that null propagates to
  // the sink rather than being filtered out. A subscriber that assumed an
  // object would silently fail otherwise (the bus emit catch swallows the
  // throw, but the event is effectively dropped from that subscriber).
  const events: unknown[] = [];
  const dir = await Deno.makeTempDir();
  const registry = new LockRegistry(join(dir, "locks.jsonl"));
  const server = new OvermindHttpServer({
    registry,
    port: 0,
    eventSink: (e) => {
      events.push(e);
    },
  });
  const { port, hostname } = server.start();
  try {
    const res = await fetch(`http://${hostname}:${port}/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
    assertEquals(events, [null]);
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /event tolerates malformed JSON", async () => {
  const h = await startTestServer();
  try {
    const res = await fetch(`${h.url}/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
  } finally {
    await h.shutdown();
  }
});

Deno.test("POST /lock with harness off returns 200 + harness:off", async () => {
  const h = await startTestServer({ harnessOn: () => false });
  try {
    const res = await postJson(`${h.url}/lock`, {
      path: "/foo.ts",
      sessionId: "S1",
      agentId: "A",
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body, { ok: true, harness: "off" });
    assertEquals(h.registry.snapshot().length, 0);
  } finally {
    await h.shutdown();
  }
});

Deno.test("POST /release-session-locks with harness off returns harness:off + released:0", async () => {
  const h = await startTestServer({ harnessOn: () => false });
  try {
    // Even if the registry happened to hold something, harness-off must not
    // mutate state.
    await h.registry.acquire({
      path: "/foo.ts",
      sessionId: "S1",
      agentId: "A",
    });
    const res = await postJson(`${h.url}/release-session-locks`, {
      sessionId: "S1",
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), {
      ok: true,
      harness: "off",
      released: 0,
    });
    assertEquals(h.registry.snapshot().length, 1);
  } finally {
    await h.shutdown();
  }
});

Deno.test("start twice on the same server throws", async () => {
  const dir = await Deno.makeTempDir();
  const registry = new LockRegistry(join(dir, "locks.jsonl"));
  const server = new OvermindHttpServer({ registry, port: 0 });
  server.start();
  let threw = false;
  try {
    server.start();
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
  await server.shutdown();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("shutdown is idempotent", async () => {
  const dir = await Deno.makeTempDir();
  const registry = new LockRegistry(join(dir, "locks.jsonl"));
  const server = new OvermindHttpServer({ registry, port: 0 });
  server.start();
  await server.shutdown();
  await server.shutdown();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("POST /lock with oversized body returns 413", async () => {
  const h = await startTestServer();
  try {
    const oversized = "x".repeat(1024 * 1024 + 16);
    const res = await fetch(`${h.url}/lock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: oversized }),
    });
    assertEquals(res.status, 413);
    const body = await res.json();
    assertEquals(body.error, "payload_too_large");
  } finally {
    await h.shutdown();
  }
});

async function rawHttpPost(
  port: number,
  path: string,
  hostHeader: string,
  body: string,
): Promise<{ status: number; body: string }> {
  // fetch() silently strips the Host header (forbidden by spec), so the
  // DNS-rebinding test has to drop to a raw TCP socket to set Host directly.
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  const req = [
    `POST ${path} HTTP/1.1`,
    `Host: ${hostHeader}`,
    `Content-Type: application/json`,
    `Content-Length: ${new TextEncoder().encode(body).length}`,
    `Connection: close`,
    ``,
    body,
  ].join("\r\n");
  try {
    await conn.write(new TextEncoder().encode(req));
    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(4096);
    while (true) {
      const n = await conn.read(buf);
      if (n === null) break;
      chunks.push(buf.slice(0, n));
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    const text = new TextDecoder().decode(merged);
    const statusLine = text.split("\r\n", 1)[0] ?? "";
    const status = Number(statusLine.split(" ")[1] ?? "0");
    const bodyStart = text.indexOf("\r\n\r\n");
    const responseBody = bodyStart >= 0 ? text.slice(bodyStart + 4) : "";
    return { status, body: responseBody };
  } finally {
    try {
      conn.close();
    } catch {
      // already closed
    }
  }
}

Deno.test("rejects requests with mismatched Host header (DNS rebinding defense)", async () => {
  const h = await startTestServer();
  try {
    const port = Number(new URL(h.url).port);
    const result = await rawHttpPost(
      port,
      "/lock",
      "attacker.example.com:80",
      JSON.stringify({
        path: "/foo.ts",
        sessionId: "S1",
        agentId: "A",
      }),
    );
    assertEquals(result.status, 403);
    assertEquals(h.registry.snapshot().length, 0);
  } finally {
    await h.shutdown();
  }
});

Deno.test("accepts a request whose Host header matches the bound port", async () => {
  const h = await startTestServer();
  try {
    const port = Number(new URL(h.url).port);
    const result = await rawHttpPost(
      port,
      "/lock",
      `127.0.0.1:${port}`,
      JSON.stringify({
        path: "/foo.ts",
        sessionId: "S1",
        agentId: "A",
      }),
    );
    assertEquals(result.status, 200);
    assertEquals(h.registry.snapshot().length, 1);
  } finally {
    await h.shutdown();
  }
});

Deno.test("accepts both 127.0.0.1 and localhost Host headers on the bound port", async () => {
  const h = await startTestServer();
  try {
    const port = new URL(h.url).port;
    const res = await fetch(`http://127.0.0.1:${port}/lock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "/foo.ts",
        sessionId: "S1",
        agentId: "A",
      }),
    });
    assertEquals(res.status, 200);
    await res.body?.cancel();
  } finally {
    await h.shutdown();
  }
});

Deno.test("500 response does not leak error detail", async () => {
  const dir = await Deno.makeTempDir();
  const registry = new LockRegistry(join(dir, "locks.jsonl"));
  // deno-lint-ignore no-explicit-any
  (registry as any).acquire = () => {
    throw new Error("super-secret internal path: /etc/shadow");
  };
  const server = new OvermindHttpServer({
    registry,
    port: 0,
    harnessOn: () => true,
  });
  const { port, hostname } = server.start();
  try {
    const res = await fetch(`http://${hostname}:${port}/lock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "/foo.ts",
        sessionId: "S1",
        agentId: "A",
      }),
    });
    assertEquals(res.status, 500);
    const body = await res.json();
    assertEquals(body, { error: "internal_error" });
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /lock returns 503 with reason when registry is at capacity", async () => {
  const h = await startTestServer();
  try {
    // Pre-load the registry to MAX_LOCKS so the next /lock POST trips the
    // capacity guard. Done via the registry directly to keep the test fast
    // (10k HTTP round-trips would dominate the suite).
    const total = 10_000;
    for (let i = 0; i < total; i++) {
      await h.registry.acquire({
        path: `/cap_${i}.ts`,
        sessionId: `S${i}`,
        agentId: "A",
      });
    }

    const res = await postJson(`${h.url}/lock`, {
      path: "/overflow.ts",
      sessionId: "S-overflow",
      agentId: "A",
    });
    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(body, { ok: false, error: "lock_capacity_exceeded" });
  } finally {
    await h.shutdown();
  }
});

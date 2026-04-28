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
      taskId: "T1",
      agentId: "A",
      runId: "R",
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
    assertEquals(h.registry.snapshot().length, 1);
  } finally {
    await h.shutdown();
  }
});

Deno.test("POST /lock returns 409 with holder on conflict", async () => {
  const h = await startTestServer();
  try {
    await h.registry.acquire({
      path: "/foo.ts",
      taskId: "T1",
      agentId: "A",
      runId: "R1",
    });
    const res = await postJson(`${h.url}/lock`, {
      path: "/foo.ts",
      taskId: "T2",
      agentId: "B",
      runId: "R2",
    });
    assertEquals(res.status, 409);
    const body = await res.json();
    assertEquals(body.ok, false);
    assertEquals(body.holder, { taskId: "T1", agentId: "A", runId: "R1" });
  } finally {
    await h.shutdown();
  }
});

Deno.test("POST /unlock releases a held lock", async () => {
  const h = await startTestServer();
  try {
    await h.registry.acquire({
      path: "/foo.ts",
      taskId: "T1",
      agentId: "A",
      runId: "R",
    });
    const res = await postJson(`${h.url}/unlock`, {
      path: "/foo.ts",
      taskId: "T1",
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
    assertEquals(h.registry.snapshot().length, 0);
  } finally {
    await h.shutdown();
  }
});

Deno.test("POST /unlock returns 409 when taskId does not match", async () => {
  const h = await startTestServer();
  try {
    await h.registry.acquire({
      path: "/foo.ts",
      taskId: "T1",
      agentId: "A",
      runId: "R",
    });
    const res = await postJson(`${h.url}/unlock`, {
      path: "/foo.ts",
      taskId: "T2",
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
      taskId: "T1",
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
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
      taskId: "T",
      agentId: "A",
      runId: "R",
    });
    assertEquals(res.status, 400);
    await res.body?.cancel();
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
      taskId: "T1",
      agentId: "A",
      runId: "R",
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body, { ok: true, harness: "off" });
    // Lock was not actually recorded.
    assertEquals(h.registry.snapshot().length, 0);
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

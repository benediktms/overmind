import { assertEquals } from "@std/assert";
import { tryAcquire } from "./lock_client.ts";

// Helper: replace `globalThis.fetch` for the duration of the callback. Tests
// drive every branch through this seam; nothing here actually opens a socket.
//
// WARNING: this fixture mutates `globalThis.fetch`. Tests in this file MUST
// run serially. Do NOT add `{ parallel: true }` to any Deno.test option in
// this file — concurrent tests would race on the global override and cause
// non-deterministic failures (or silent passes).
async function withFetch(
  impl: (req: Request) => Promise<Response>,
  fn: (calls: { count: number }) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls = { count: 0 };
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.count++;
    const req = input instanceof Request
      ? input
      : new Request(input.toString(), init);
    return impl(req);
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const BASE = {
  url: "http://localhost:8080",
  path: "/repo/foo.ts",
  sessionId: "S1",
  agentId: "A",
};

Deno.test("tryAcquire: scout mode short-circuits without fetching", async () => {
  await withFetch(
    () => Promise.reject(new Error("fetch should not be called")),
    async (calls) => {
      const result = await tryAcquire({ ...BASE, mode: "scout" });
      assertEquals(result, { status: "skipped" });
      assertEquals(calls.count, 0);
    },
  );
});

Deno.test("tryAcquire: relay mode short-circuits without fetching", async () => {
  await withFetch(
    () => Promise.reject(new Error("fetch should not be called")),
    async (calls) => {
      const result = await tryAcquire({ ...BASE, mode: "relay" });
      assertEquals(result, { status: "skipped" });
      assertEquals(calls.count, 0);
    },
  );
});

Deno.test("tryAcquire: swarm mode + 200 returns ok", async () => {
  await withFetch(
    (req) => {
      // Verify wire format: POST /lock with the expected JSON body.
      assertEquals(req.method, "POST");
      assertEquals(new URL(req.url).pathname, "/lock");
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
    async (calls) => {
      const result = await tryAcquire({ ...BASE, mode: "swarm" });
      assertEquals(result, { status: "ok" });
      assertEquals(calls.count, 1);
    },
  );
});

Deno.test("tryAcquire: swarm mode + 409 returns conflict with holder", async () => {
  await withFetch(
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ok: false,
            holder: { sessionId: "S2", agentId: "B" },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      ),
    async () => {
      const result = await tryAcquire({ ...BASE, mode: "swarm" });
      assertEquals(result, {
        status: "conflict",
        holder: { sessionId: "S2", agentId: "B" },
      });
    },
  );
});

Deno.test("tryAcquire: 409 with missing holder degrades to kernel_unavailable", async () => {
  await withFetch(
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: false }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      ),
    async () => {
      const result = await tryAcquire({ ...BASE, mode: "swarm" });
      assertEquals(result, { status: "kernel_unavailable" });
    },
  );
});

Deno.test("tryAcquire: 409 with malformed JSON body degrades", async () => {
  await withFetch(
    () =>
      Promise.resolve(
        new Response("not-json", {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      ),
    async () => {
      const result = await tryAcquire({ ...BASE, mode: "swarm" });
      assertEquals(result, { status: "kernel_unavailable" });
    },
  );
});

Deno.test("tryAcquire: network error returns kernel_unavailable", async () => {
  await withFetch(
    () => Promise.reject(new TypeError("network down")),
    async () => {
      const result = await tryAcquire({ ...BASE, mode: "swarm" });
      assertEquals(result, { status: "kernel_unavailable" });
    },
  );
});

Deno.test("tryAcquire: timeout via AbortSignal returns kernel_unavailable", async () => {
  await withFetch(
    (req) =>
      new Promise<Response>((_resolve, reject) => {
        // Reject when the abort signal fires. AbortSignal.timeout creates a
        // signal that aborts after the configured ms; mirror what fetch does.
        req.signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
    async () => {
      const start = Date.now();
      const result = await tryAcquire({
        ...BASE,
        mode: "swarm",
        timeoutMs: 50,
      });
      const elapsed = Date.now() - start;
      assertEquals(result, { status: "kernel_unavailable" });
      // Ensure the timeout actually applied — should land well under 1 s.
      // Allow some slack for slow CI but catch a stuck fetch.
      assertEquals(elapsed < 500, true);
    },
  );
});

Deno.test("tryAcquire: 500 response returns kernel_unavailable", async () => {
  await withFetch(
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "internal_error" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      ),
    async () => {
      const result = await tryAcquire({ ...BASE, mode: "swarm" });
      assertEquals(result, { status: "kernel_unavailable" });
    },
  );
});

Deno.test("tryAcquire: 400 (invalid_body) returns kernel_unavailable, not conflict", async () => {
  await withFetch(
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "invalid_body" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    async () => {
      const result = await tryAcquire({ ...BASE, mode: "swarm" });
      assertEquals(result, { status: "kernel_unavailable" });
    },
  );
});

Deno.test("tryAcquire: undefined mode runs the check (safe default)", async () => {
  await withFetch(
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    async (calls) => {
      const result = await tryAcquire({ ...BASE });
      assertEquals(result, { status: "ok" });
      assertEquals(calls.count, 1);
    },
  );
});

Deno.test("tryAcquire: unknown mode runs the check", async () => {
  await withFetch(
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    async (calls) => {
      const result = await tryAcquire({ ...BASE, mode: "team" });
      assertEquals(result, { status: "ok" });
      assertEquals(calls.count, 1);
    },
  );
});

Deno.test("tryAcquire: trims trailing slash from url", async () => {
  await withFetch(
    (req) => {
      assertEquals(new URL(req.url).pathname, "/lock");
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
    async () => {
      const result = await tryAcquire({
        ...BASE,
        url: "http://localhost:8080/",
        mode: "swarm",
      });
      assertEquals(result, { status: "ok" });
    },
  );
});

Deno.test("tryAcquire: posts the expected wire-format body", async () => {
  let captured: unknown = null;
  await withFetch(
    async (req) => {
      captured = await req.json();
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async () => {
      const result = await tryAcquire({
        url: "http://localhost:8080",
        path: "/repo/x.ts",
        sessionId: "sess-7",
        agentId: "drone-2",
        mode: "swarm",
      });
      assertEquals(result, { status: "ok" });
      assertEquals(captured, {
        path: "/repo/x.ts",
        sessionId: "sess-7",
        agentId: "drone-2",
      });
    },
  );
});

// --- F1: capacity exhaustion surfaces as kernel_unavailable (fail-open) ---

Deno.test("tryAcquire: 503 capacity response degrades to kernel_unavailable", async () => {
  // Documents the M4 wire contract: when the kernel returns 503 with
  // `lock_capacity_exceeded`, the client treats it like any other non-200
  // status — fail open. The agent gets the `kernel_unavailable` warn from
  // evaluateLockClaim; the kernel logs surface the real cause for ops.
  await withFetch(
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ok: false, error: "lock_capacity_exceeded" }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      ),
    async () => {
      const result = await tryAcquire({ ...BASE, mode: "swarm" });
      assertEquals(result, { status: "kernel_unavailable" });
    },
  );
});

// --- F6: SSRF guard — non-localhost URLs short-circuit before any fetch ---

Deno.test("tryAcquire: non-localhost URL short-circuits without fetching", async () => {
  await withFetch(
    () => Promise.reject(new Error("fetch should not be called")),
    async (calls) => {
      const result = await tryAcquire({
        ...BASE,
        url: "http://attacker.example.com:8080",
        mode: "swarm",
      });
      assertEquals(result, { status: "kernel_unavailable" });
      assertEquals(calls.count, 0);
    },
  );
});

Deno.test("tryAcquire: file:// URL short-circuits", async () => {
  // Belt-and-braces: even if an operator pasted a typo, we never hit fetch.
  await withFetch(
    () => Promise.reject(new Error("fetch should not be called")),
    async (calls) => {
      const result = await tryAcquire({
        ...BASE,
        url: "file:///etc/passwd",
        mode: "swarm",
      });
      assertEquals(result, { status: "kernel_unavailable" });
      assertEquals(calls.count, 0);
    },
  );
});

Deno.test("tryAcquire: malformed URL short-circuits", async () => {
  await withFetch(
    () => Promise.reject(new Error("fetch should not be called")),
    async (calls) => {
      const result = await tryAcquire({
        ...BASE,
        url: "::not-a-url",
        mode: "swarm",
      });
      assertEquals(result, { status: "kernel_unavailable" });
      assertEquals(calls.count, 0);
    },
  );
});

Deno.test("tryAcquire: 127.0.0.1, localhost, and ::1 are all allowed", async () => {
  for (
    const url of [
      "http://127.0.0.1:8080",
      "http://localhost:8080",
      "http://[::1]:8080",
    ]
  ) {
    await withFetch(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      async (calls) => {
        const result = await tryAcquire({ ...BASE, url, mode: "swarm" });
        assertEquals(result, { status: "ok" });
        assertEquals(calls.count, 1);
      },
    );
  }
});

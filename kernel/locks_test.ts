import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";

import { LockRegistry } from "./locks.ts";

async function withTempJournal<T>(
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir();
  try {
    return await fn(join(dir, "locks.jsonl"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("acquire on empty path returns ok and records the entry", async () => {
  await withTempJournal(async (journalPath) => {
    const registry = new LockRegistry(journalPath);
    const result = await registry.acquire({
      path: "/foo.ts",
      sessionId: "S1",
      agentId: "A",
    });
    assertEquals(result.ok, true);
    const snapshot = registry.snapshot();
    assertEquals(snapshot.length, 1);
    assertEquals(snapshot[0].path, "/foo.ts");
    assertEquals(snapshot[0].sessionId, "S1");
    assertEquals(snapshot[0].agentId, "A");
  });
});

Deno.test("acquire with same (sessionId, agentId) is re-entrant and refreshes acquiredAt", async () => {
  await withTempJournal(async (journalPath) => {
    const registry = new LockRegistry(journalPath);
    await registry.acquire({
      path: "/foo.ts",
      sessionId: "S1",
      agentId: "A",
    });
    const firstAt = registry.snapshot()[0].acquiredAt;
    await new Promise((r) => setTimeout(r, 5));
    const second = await registry.acquire({
      path: "/foo.ts",
      sessionId: "S1",
      agentId: "A",
    });
    assertEquals(second.ok, true);
    const secondAt = registry.snapshot()[0].acquiredAt;
    assert(
      secondAt > firstAt,
      `expected ${secondAt} > ${firstAt} (refresh)`,
    );
  });
});

Deno.test("acquire conflicts when sessionId differs", async () => {
  await withTempJournal(async (journalPath) => {
    const registry = new LockRegistry(journalPath);
    await registry.acquire({
      path: "/foo.ts",
      sessionId: "S1",
      agentId: "A",
    });
    const result = await registry.acquire({
      path: "/foo.ts",
      sessionId: "S2",
      agentId: "A",
    });
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.holder, { sessionId: "S1", agentId: "A" });
    }
  });
});

Deno.test("acquire conflicts when agentId differs (same session)", async () => {
  // Two agents within the same CC session race on the same file —
  // intra-session race detection.
  await withTempJournal(async (journalPath) => {
    const registry = new LockRegistry(journalPath);
    await registry.acquire({
      path: "/foo.ts",
      sessionId: "S1",
      agentId: "A",
    });
    const result = await registry.acquire({
      path: "/foo.ts",
      sessionId: "S1",
      agentId: "B",
    });
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.holder, { sessionId: "S1", agentId: "A" });
    }
  });
});

Deno.test("release with matching owner frees the lock", async () => {
  await withTempJournal(async (journalPath) => {
    const registry = new LockRegistry(journalPath);
    await registry.acquire({
      path: "/foo.ts",
      sessionId: "S1",
      agentId: "A",
    });
    const ok = await registry.release("/foo.ts", "S1", "A");
    assertEquals(ok, true);
    assertEquals(registry.snapshot().length, 0);
  });
});

Deno.test("release with mismatched sessionId refuses to steal", async () => {
  await withTempJournal(async (journalPath) => {
    const registry = new LockRegistry(journalPath);
    await registry.acquire({
      path: "/foo.ts",
      sessionId: "S1",
      agentId: "A",
    });
    const ok = await registry.release("/foo.ts", "S2", "A");
    assertEquals(ok, false);
    assertEquals(registry.snapshot().length, 1);
  });
});

Deno.test("release with mismatched agentId refuses to steal", async () => {
  await withTempJournal(async (journalPath) => {
    const registry = new LockRegistry(journalPath);
    await registry.acquire({
      path: "/foo.ts",
      sessionId: "S1",
      agentId: "A",
    });
    const ok = await registry.release("/foo.ts", "S1", "B");
    assertEquals(ok, false);
    assertEquals(registry.snapshot().length, 1);
  });
});

Deno.test("release on absent path is idempotent", async () => {
  await withTempJournal(async (journalPath) => {
    const registry = new LockRegistry(journalPath);
    const ok = await registry.release("/nope.ts", "S1", "A");
    assertEquals(ok, true);
  });
});

Deno.test("releaseAllForSession frees every lock owned by the session", async () => {
  await withTempJournal(async (journalPath) => {
    const registry = new LockRegistry(journalPath);
    await registry.acquire({ path: "/a.ts", sessionId: "S1", agentId: "A" });
    await registry.acquire({ path: "/b.ts", sessionId: "S1", agentId: "B" });
    await registry.acquire({ path: "/c.ts", sessionId: "S2", agentId: "C" });

    const freed = await registry.releaseAllForSession("S1");
    assertEquals(freed, 2);
    const remaining = registry.snapshot();
    assertEquals(remaining.length, 1);
    assertEquals(remaining[0].path, "/c.ts");
    assertEquals(remaining[0].sessionId, "S2");
  });
});

Deno.test("releaseAllForSession returns 0 when the session holds no locks", async () => {
  await withTempJournal(async (journalPath) => {
    const registry = new LockRegistry(journalPath);
    await registry.acquire({ path: "/a.ts", sessionId: "S1", agentId: "A" });
    const freed = await registry.releaseAllForSession("S-unknown");
    assertEquals(freed, 0);
    assertEquals(registry.snapshot().length, 1);
  });
});

Deno.test("load rebuilds state — released entries do not reappear", async () => {
  await withTempJournal(async (journalPath) => {
    const writer = new LockRegistry(journalPath);
    await writer.acquire({ path: "/a.ts", sessionId: "S1", agentId: "A" });
    await writer.acquire({ path: "/b.ts", sessionId: "S2", agentId: "B" });
    await writer.release("/a.ts", "S1", "A");

    const reader = new LockRegistry(journalPath);
    await reader.load();
    const paths = reader.snapshot().map((e) => e.path).sort();
    assertEquals(paths, ["/b.ts"]);
  });
});

Deno.test("load on a missing journal yields an empty registry", async () => {
  await withTempJournal(async (journalPath) => {
    const registry = new LockRegistry(journalPath);
    await registry.load();
    assertEquals(registry.snapshot().length, 0);
  });
});

Deno.test("load tolerates a malformed journal line", async () => {
  await withTempJournal(async (journalPath) => {
    const writer = new LockRegistry(journalPath);
    await writer.acquire({ path: "/a.ts", sessionId: "S1", agentId: "A" });
    await Deno.writeTextFile(
      journalPath,
      "{ this is not json\n",
      { append: true },
    );
    await writer.acquire({ path: "/b.ts", sessionId: "S1", agentId: "B" });

    const reader = new LockRegistry(journalPath);
    await reader.load();
    const paths = reader.snapshot().map((e) => e.path).sort();
    assertEquals(paths, ["/a.ts", "/b.ts"]);
  });
});

Deno.test("load skips entries missing required identity fields", async () => {
  await withTempJournal(async (journalPath) => {
    // Hand-craft a journal containing a legacy-shape entry (with taskId/runId
    // but no sessionId). The new replay must skip it rather than crash.
    const lines = [
      JSON.stringify({
        ts: "2026-01-01T00:00:00Z",
        kind: "acquired",
        entry: {
          path: "/legacy.ts",
          taskId: "T1",
          agentId: "A",
          runId: "R",
          acquiredAt: "2026-01-01T00:00:00Z",
        },
      }),
      JSON.stringify({
        ts: "2026-01-01T00:00:01Z",
        kind: "acquired",
        entry: {
          path: "/new.ts",
          sessionId: "S1",
          agentId: "A",
          acquiredAt: "2026-01-01T00:00:01Z",
        },
      }),
      "",
    ].join("\n");
    await Deno.writeTextFile(journalPath, lines);

    const reader = new LockRegistry(journalPath);
    await reader.load();
    const paths = reader.snapshot().map((e) => e.path);
    assertEquals(paths, ["/new.ts"]);
  });
});

Deno.test("load reflects a re-entrant acquire by replacing acquiredAt", async () => {
  await withTempJournal(async (journalPath) => {
    const writer = new LockRegistry(journalPath);
    await writer.acquire({ path: "/a.ts", sessionId: "S1", agentId: "A" });
    await new Promise((r) => setTimeout(r, 5));
    await writer.acquire({ path: "/a.ts", sessionId: "S1", agentId: "A" });
    const expected = writer.snapshot()[0].acquiredAt;

    const reader = new LockRegistry(journalPath);
    await reader.load();
    assertEquals(reader.snapshot()[0].acquiredAt, expected);
  });
});

Deno.test("acquire refuses new entries past the 10k cap (OOM defense)", async () => {
  await withTempJournal(async (journalPath) => {
    const registry = new LockRegistry(journalPath);
    const total = 10_000;
    for (let i = 0; i < total; i++) {
      const result = await registry.acquire({
        path: `/file_${i}.ts`,
        sessionId: `S${i}`,
        agentId: "A",
      });
      assertEquals(result.ok, true);
    }
    assertEquals(registry.snapshot().length, total);

    const overflow = await registry.acquire({
      path: "/overflow.ts",
      sessionId: "S-overflow",
      agentId: "A",
    });
    assertEquals(overflow.ok, false);
    // Capacity refusal carries a distinct reason so the HTTP layer can
    // surface 503 instead of a holderless 409 (which the hook client would
    // misread as "kernel unavailable").
    if (!overflow.ok) {
      assertEquals(overflow.holder, undefined);
      assertEquals(overflow.reason, "capacity");
    }

    // Re-entrant acquire on an existing path still succeeds even at the cap
    // (no new map entry created).
    const reentrant = await registry.acquire({
      path: "/file_0.ts",
      sessionId: "S0",
      agentId: "A",
    });
    assertEquals(reentrant.ok, true);
    assertEquals(registry.snapshot().length, total);
  });
});

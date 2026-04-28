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
      taskId: "T1",
      agentId: "A",
      runId: "R",
    });
    assertEquals(result.ok, true);
    assertEquals(result.holder, undefined);
    const snapshot = registry.snapshot();
    assertEquals(snapshot.length, 1);
    assertEquals(snapshot[0].path, "/foo.ts");
    assertEquals(snapshot[0].taskId, "T1");
  });
});

Deno.test("acquire with same taskId is re-entrant and refreshes acquiredAt", async () => {
  await withTempJournal(async (journalPath) => {
    const registry = new LockRegistry(journalPath);
    const first = await registry.acquire({
      path: "/foo.ts",
      taskId: "T1",
      agentId: "A",
      runId: "R",
    });
    const firstAt = registry.snapshot()[0].acquiredAt;
    // Allow the wall clock to advance so acquiredAt is observably newer.
    await new Promise((r) => setTimeout(r, 5));
    const second = await registry.acquire({
      path: "/foo.ts",
      taskId: "T1",
      agentId: "A",
      runId: "R",
    });
    assertEquals(first.ok, true);
    assertEquals(second.ok, true);
    const secondAt = registry.snapshot()[0].acquiredAt;
    assert(
      secondAt > firstAt,
      `expected ${secondAt} > ${firstAt} (refresh)`,
    );
  });
});

Deno.test("acquire with different taskId returns conflict with holder details", async () => {
  await withTempJournal(async (journalPath) => {
    const registry = new LockRegistry(journalPath);
    await registry.acquire({
      path: "/foo.ts",
      taskId: "T1",
      agentId: "A",
      runId: "R1",
    });
    const result = await registry.acquire({
      path: "/foo.ts",
      taskId: "T2",
      agentId: "B",
      runId: "R2",
    });
    assertEquals(result.ok, false);
    assertEquals(result.holder, { taskId: "T1", agentId: "A", runId: "R1" });
  });
});

Deno.test("release with matching taskId frees the lock", async () => {
  await withTempJournal(async (journalPath) => {
    const registry = new LockRegistry(journalPath);
    await registry.acquire({
      path: "/foo.ts",
      taskId: "T1",
      agentId: "A",
      runId: "R",
    });
    const ok = await registry.release("/foo.ts", "T1");
    assertEquals(ok, true);
    assertEquals(registry.snapshot().length, 0);
  });
});

Deno.test("release with mismatching taskId refuses to steal the lock", async () => {
  await withTempJournal(async (journalPath) => {
    const registry = new LockRegistry(journalPath);
    await registry.acquire({
      path: "/foo.ts",
      taskId: "T1",
      agentId: "A",
      runId: "R",
    });
    const ok = await registry.release("/foo.ts", "T2");
    assertEquals(ok, false);
    assertEquals(registry.snapshot().length, 1);
  });
});

Deno.test("release on absent path is idempotent", async () => {
  await withTempJournal(async (journalPath) => {
    const registry = new LockRegistry(journalPath);
    const ok = await registry.release("/nope.ts", "T1");
    assertEquals(ok, true);
  });
});

Deno.test("releaseAllForRun frees only entries owned by the run", async () => {
  await withTempJournal(async (journalPath) => {
    const registry = new LockRegistry(journalPath);
    await registry.acquire({
      path: "/a.ts",
      taskId: "T1",
      agentId: "A",
      runId: "R1",
    });
    await registry.acquire({
      path: "/b.ts",
      taskId: "T2",
      agentId: "B",
      runId: "R1",
    });
    await registry.acquire({
      path: "/c.ts",
      taskId: "T3",
      agentId: "C",
      runId: "R2",
    });
    const freed = await registry.releaseAllForRun("R1");
    assertEquals(freed, 2);
    const remaining = registry.snapshot();
    assertEquals(remaining.length, 1);
    assertEquals(remaining[0].path, "/c.ts");
  });
});

Deno.test("releaseAllForRun returns 0 when the run holds no locks", async () => {
  await withTempJournal(async (journalPath) => {
    const registry = new LockRegistry(journalPath);
    await registry.acquire({
      path: "/a.ts",
      taskId: "T1",
      agentId: "A",
      runId: "R1",
    });
    const freed = await registry.releaseAllForRun("R-unknown");
    assertEquals(freed, 0);
    assertEquals(registry.snapshot().length, 1);
  });
});

Deno.test("load rebuilds state — released entries do not reappear", async () => {
  await withTempJournal(async (journalPath) => {
    const writer = new LockRegistry(journalPath);
    await writer.acquire({
      path: "/a.ts",
      taskId: "T1",
      agentId: "A",
      runId: "R",
    });
    await writer.acquire({
      path: "/b.ts",
      taskId: "T2",
      agentId: "B",
      runId: "R",
    });
    await writer.release("/a.ts", "T1");

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
    await writer.acquire({
      path: "/a.ts",
      taskId: "T1",
      agentId: "A",
      runId: "R",
    });
    await Deno.writeTextFile(
      journalPath,
      "{ this is not json\n",
      { append: true },
    );
    await writer.acquire({
      path: "/b.ts",
      taskId: "T2",
      agentId: "B",
      runId: "R",
    });

    const reader = new LockRegistry(journalPath);
    await reader.load();
    const paths = reader.snapshot().map((e) => e.path).sort();
    assertEquals(paths, ["/a.ts", "/b.ts"]);
  });
});

Deno.test("load reflects a re-entrant acquire by replacing acquiredAt", async () => {
  await withTempJournal(async (journalPath) => {
    const writer = new LockRegistry(journalPath);
    await writer.acquire({
      path: "/a.ts",
      taskId: "T1",
      agentId: "A",
      runId: "R",
    });
    await new Promise((r) => setTimeout(r, 5));
    await writer.acquire({
      path: "/a.ts",
      taskId: "T1",
      agentId: "A",
      runId: "R",
    });
    const expected = writer.snapshot()[0].acquiredAt;

    const reader = new LockRegistry(journalPath);
    await reader.load();
    assertEquals(reader.snapshot()[0].acquiredAt, expected);
  });
});

Deno.test("acquire refuses new entries past the 10k cap (OOM defense)", async () => {
  await withTempJournal(async (journalPath) => {
    const registry = new LockRegistry(journalPath);
    // Fill to the cap. Fast — pure in-memory work, journal append serialized.
    const total = 10_000;
    for (let i = 0; i < total; i++) {
      const result = await registry.acquire({
        path: `/file_${i}.ts`,
        taskId: `T${i}`,
        agentId: "A",
        runId: "R",
      });
      assertEquals(result.ok, true);
    }
    assertEquals(registry.snapshot().length, total);

    // The next new path should be rejected.
    const overflow = await registry.acquire({
      path: "/overflow.ts",
      taskId: "T-overflow",
      agentId: "A",
      runId: "R",
    });
    assertEquals(overflow.ok, false);
    assertEquals(overflow.holder, undefined);

    // Re-entrant acquire on an existing path still succeeds even at the cap
    // (no new map entry created).
    const reentrant = await registry.acquire({
      path: "/file_0.ts",
      taskId: "T0",
      agentId: "A",
      runId: "R",
    });
    assertEquals(reentrant.ok, true);
    assertEquals(registry.snapshot().length, total);
  });
});

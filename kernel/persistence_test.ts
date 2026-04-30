import { assert, assertEquals } from "@std/assert";

import {
  PersistenceCoordinator,
  readActiveModeState,
  readCapabilities,
  resolveModeStatePath,
  resolveRunStatePath,
} from "./persistence.ts";
import { Mode, type RunContext, RunState } from "./types.ts";
import { MockBrainAdapter } from "./test_helpers/mock_brain.ts";

function buildRunContext(overrides: Partial<RunContext> = {}): RunContext {
  return {
    run_id: "run-test-1",
    mode: Mode.Scout,
    objective: "Investigate persistence",
    workspace: "/tmp/workspace",
    state: RunState.Running,
    brain_task_id: "BRN-123",
    room_id: "room-123",
    iteration: 0,
    max_iterations: 3,
    created_at: "2026-03-29T00:00:00.000Z",
    isVerifying: false,
    ...overrides,
  };
}

Deno.test("PersistenceCoordinator writes local state and capabilities", async () => {
  const tempDir = await Deno.makeTempDir();
  const brain = new MockBrainAdapter();
  brain.connected = true;
  const coordinator = new PersistenceCoordinator(tempDir, brain);

  try {
    const ctx = buildRunContext({ workspace: tempDir });
    await coordinator.startRun(ctx);

    const state = await readActiveModeState(tempDir);
    const capabilities = await readCapabilities(tempDir);

    assert(state);
    assertEquals(state.run_id, ctx.run_id);
    assertEquals(state.mode, Mode.Scout);
    assertEquals(state.active, true);
    assertEquals(state.persistence.brain.available, true);

    assert(capabilities);
    assertEquals(capabilities.brain.available, true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("readActiveModeState filters by session_id when provided", async () => {
  const tempDir = await Deno.makeTempDir();
  const brain = new MockBrainAdapter();
  brain.connected = true;
  const coordinator = new PersistenceCoordinator(tempDir, brain);

  try {
    // Two runs in different modes (so they hit different state files),
    // owned by different sessions. SessionStart hooks must only see
    // their own session's state.
    const sessionA = "session-aaa";
    const sessionB = "session-bbb";
    await coordinator.startRun(
      buildRunContext({
        run_id: "run-A",
        mode: Mode.Scout,
        workspace: tempDir,
        session_id: sessionA,
      }),
    );
    await coordinator.startRun(
      buildRunContext({
        run_id: "run-B",
        mode: Mode.Relay,
        workspace: tempDir,
        session_id: sessionB,
      }),
    );

    const seenByA = await readActiveModeState(tempDir, sessionA);
    const seenByB = await readActiveModeState(tempDir, sessionB);
    const seenByC = await readActiveModeState(tempDir, "session-other");

    assert(seenByA);
    assertEquals(seenByA.run_id, "run-A");
    assert(seenByB);
    assertEquals(seenByB.run_id, "run-B");
    // A session that owns nothing in this workspace gets nothing.
    assertEquals(seenByC, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test(
  "PersistenceCoordinator round-trips session_id through both run-state and mode-state files",
  async () => {
    const tempDir = await Deno.makeTempDir();
    const brain = new MockBrainAdapter();
    brain.connected = true;
    const coordinator = new PersistenceCoordinator(tempDir, brain);

    const sessionId = "session-abc";

    try {
      const ctx = buildRunContext({
        run_id: "run-session-roundtrip",
        mode: Mode.Scout,
        workspace: tempDir,
        session_id: sessionId,
      });
      await coordinator.startRun(ctx);

      // Read the per-run state file directly from disk — bypasses all
      // in-process readers so dropping session_id from createSnapshot
      // would be caught here even if the filter tests stayed green.
      const rawJson = await Deno.readTextFile(
        resolveRunStatePath(tempDir, ctx.run_id),
      );
      const persisted = JSON.parse(rawJson);
      assertEquals(persisted.session_id, sessionId);

      // Read the per-mode state file directly from disk — this is the
      // file that readActiveModeState actually consumes.
      const modeRaw = await Deno.readTextFile(
        resolveModeStatePath(tempDir, ctx.mode),
      );
      const modePersisted = JSON.parse(modeRaw);
      assertEquals(modePersisted.session_id, sessionId);
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "readActiveModeState treats missing session_id as global match (backwards compat)",
  async () => {
    const tempDir = await Deno.makeTempDir();
    const brain = new MockBrainAdapter();
    brain.connected = true;
    const coordinator = new PersistenceCoordinator(tempDir, brain);

    try {
      // Run started before the session_id field existed (or by a caller
      // that doesn't carry one). Pre-existing runs should not silently
      // black out resurrect in upgraded sessions.
      await coordinator.startRun(
        buildRunContext({
          run_id: "run-legacy",
          mode: Mode.Swarm,
          workspace: tempDir,
          // session_id intentionally omitted
        }),
      );

      const seenWithFilter = await readActiveModeState(tempDir, "session-X");
      assert(seenWithFilter);
      assertEquals(seenWithFilter.run_id, "run-legacy");

      const seenWithoutFilter = await readActiveModeState(tempDir);
      assert(seenWithoutFilter);
      assertEquals(seenWithoutFilter.run_id, "run-legacy");
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test("PersistenceCoordinator marks run inactive on completion", async () => {
  const tempDir = await Deno.makeTempDir();
  const brain = new MockBrainAdapter();
  brain.connected = false;
  const coordinator = new PersistenceCoordinator(tempDir, brain);

  try {
    const ctx = buildRunContext({ workspace: tempDir, brain_task_id: "" });
    await coordinator.startRun(ctx);
    await coordinator.completeRun(
      { ...ctx, state: RunState.Completed },
      "done",
    );

    const state = await readActiveModeState(tempDir);
    assertEquals(state, null);

    const capabilities = await readCapabilities(tempDir);
    assert(capabilities);
    assertEquals(capabilities.brain.available, false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

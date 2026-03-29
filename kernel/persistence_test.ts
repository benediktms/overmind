import { assert, assertEquals } from "@std/assert";

import { PersistenceCoordinator, readActiveModeState, readCapabilities } from "./persistence.ts";
import { Mode, RunState, type RunContext } from "./types.ts";
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

Deno.test("PersistenceCoordinator marks run inactive on completion", async () => {
  const tempDir = await Deno.makeTempDir();
  const brain = new MockBrainAdapter();
  brain.connected = false;
  const coordinator = new PersistenceCoordinator(tempDir, brain);

  try {
    const ctx = buildRunContext({ workspace: tempDir, brain_task_id: "" });
    await coordinator.startRun(ctx);
    await coordinator.completeRun({ ...ctx, state: RunState.Completed }, "done");

    const state = await readActiveModeState(tempDir);
    assertEquals(state, null);

    const capabilities = await readCapabilities(tempDir);
    assert(capabilities);
    assertEquals(capabilities.brain.available, false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

import { MessageKind } from "../../adapters/neural_link/adapter.ts";
import { Mode, RunState, type RunContext, type SwarmTask } from "../types.ts";
import {
  createRunContext,
  recordFailure,
  recordStepCompletion,
  recordVerifyResult,
  shouldRetry,
  transitionState,
} from "./shared.ts";
import type { PersistenceCoordinator } from "../persistence.ts";

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const LEAD_PARTICIPANT_ID = "overmind-swarm-lead";
const LEAD_DISPLAY_NAME = "Overmind Swarm Lead";

interface BrainSwarmAdapter {
  taskCreate(params: { title: string }): Promise<string | null>;
  taskAddExternalId(taskId: string, externalId: string): Promise<boolean>;
  taskComplete(taskId: string): Promise<boolean>;
  taskComment(taskId: string, comment: string): Promise<boolean>;
  taskSetPriority(taskId: string, priority: number): Promise<boolean>;
  memoryEpisode(params: {
    goal: string;
    actions: string;
    outcome: string;
    tags?: string[];
    importance?: number;
  }): Promise<boolean>;
  memorySearch(query: string, options?: { k?: number; tags?: string[] }): Promise<Array<{ goal: string; actions: string; outcome: string }>>;
}

interface NeuralLinkSwarmAdapter {
  roomOpen(params: {
    title: string;
    participantId: string;
    displayName: string;
    purpose?: string;
    externalRef?: string;
  }): Promise<string | null>;
  messageSend(params: {
    roomId: string;
    from: string;
    kind: MessageKind;
    summary: string;
    to?: string;
    body?: string;
    threadId?: string;
    persistHint?: string;
  }): Promise<boolean>;
  waitFor(
    roomId: string,
    participantId: string,
    timeoutMs: number,
    kinds?: string[],
    from?: string[],
  ): Promise<unknown | null>;
  roomClose(roomId: string, resolution: string): Promise<boolean>;
}

interface VerifyResult {
  passed: boolean;
  details: string;
  failedTasks: string[];
}

const NOOP_PERSISTENCE: Pick<
  PersistenceCoordinator,
  "updateRun" | "completeRun" | "failRun"
> = {
  updateRun: async () => {},
  completeRun: async () => {},
  failRun: async () => {},
};

export async function executeSwarm(
  ctx: RunContext,
  brain: BrainSwarmAdapter,
  neuralLink: NeuralLinkSwarmAdapter,
  persistence: Pick<PersistenceCoordinator, "updateRun" | "completeRun" | "failRun"> = NOOP_PERSISTENCE,
): Promise<RunContext> {
  const objectiveSummary = summarizeObjective(ctx.objective);

  const taskId = await brain.taskCreate({
    title: `[overmind:swarm] ${objectiveSummary}`,
  }) ?? "";

  let runCtx = createRunContext({
    run_id: ctx.run_id,
    mode: Mode.Swarm,
    objective: ctx.objective,
    workspace: ctx.workspace,
    brain_task_id: taskId,
    room_id: ctx.room_id,
    max_iterations: ctx.max_iterations,
    created_at: ctx.created_at,
  });

  await persistence.updateRun(runCtx, {
    checkpointSummary: taskId ? "Created swarm brain task" : "Running swarm without Brain task",
  });

  if (taskId) {
    await brain.taskAddExternalId(taskId, `overmind_run_id:${ctx.run_id}`);
  }

  runCtx = transitionState(runCtx, RunState.Running);
  await persistence.updateRun(runCtx, {
    checkpointSummary: "Swarm run entered running state",
  });

  const roomId = await neuralLink.roomOpen({
    title: `[overmind:swarm:${ctx.run_id}] parallel execution`,
    participantId: LEAD_PARTICIPANT_ID,
    displayName: LEAD_DISPLAY_NAME,
    purpose: ctx.objective,
    externalRef: ctx.run_id,
  });

  if (!roomId) {
    await persistence.failRun({ ...runCtx, state: RunState.Failed }, "Failed to open swarm coordination room");
    throw new Error("Failed to open swarm coordination room");
  }

  runCtx = {
    ...runCtx,
    room_id: roomId,
  };
  await persistence.updateRun(runCtx, {
    checkpointSummary: `Opened swarm coordination room ${roomId}`,
  });

  const swarmTasks = getSwarmTasks(objectiveSummary);

  await dispatchTasks(neuralLink, roomId, ctx.objective, swarmTasks);
  await recordStepCompletion(brain, runCtx, "dispatch", `Dispatched ${swarmTasks.length} swarm tasks`);

  const initialHandoffs = await collectHandoffs(neuralLink, roomId, swarmTasks.length);
  await recordStepCompletion(
    brain,
    runCtx,
    "wait",
    `Received ${initialHandoffs.length}/${swarmTasks.length} handoffs from initial wave`,
  );

  while (true) {
    runCtx = transitionState(runCtx, RunState.Verifying);
    await persistence.updateRun(runCtx, {
      checkpointSummary: "Verifying swarm wave",
    });
    const verifyResult = await verifyWave(neuralLink, roomId, ctx.objective);
    await recordVerifyResult(brain, runCtx, verifyResult.passed, verifyResult.details);

    if (verifyResult.passed) {
      await neuralLink.roomClose(roomId, "completed");

      const actions = swarmTasks.map((t) => t.title).join("; ");
      const outcome = `Swarm completed all ${swarmTasks.length} tasks successfully after ${runCtx.iteration + 1} wave(s)`;

      await brain.memoryEpisode({
        goal: `Swarm objective (${ctx.run_id}): ${objectiveSummary}`,
        actions,
        outcome,
        tags: ["overmind", "swarm", "orchestration"],
        importance: 2,
      });

      if (taskId) {
        await brain.taskComplete(taskId);
      }
      runCtx = transitionState(runCtx, RunState.Completed);
      await persistence.completeRun(runCtx, outcome);
      return runCtx;
    }

    if (!shouldRetry(runCtx)) {
      runCtx = transitionState(runCtx, RunState.Failed);
      await recordFailure(brain, runCtx, `Swarm verification failed: ${verifyResult.details}`);
      await neuralLink.roomClose(roomId, "failed");

      const actions = swarmTasks.map((t) => t.title).join("; ");
      await brain.memoryEpisode({
        goal: `Swarm objective (${ctx.run_id}): ${objectiveSummary}`,
        actions,
        outcome: `Failed after ${runCtx.iteration + 1} fix attempts: ${verifyResult.details}`,
        tags: ["overmind", "swarm", "failure"],
        importance: 3,
      });

      await persistence.failRun(runCtx, `Swarm verification failed: ${verifyResult.details}`);
      return runCtx;
    }

    runCtx = {
      ...transitionState(runCtx, RunState.Fixing),
      iteration: runCtx.iteration + 1,
    };
    await persistence.updateRun(runCtx, {
      checkpointSummary: `Fixing swarm tasks after verification failure`,
    });

    const fixTasks = selectFixTasks(swarmTasks, verifyResult.failedTasks);
    await dispatchFixTasks(neuralLink, roomId, runCtx, fixTasks, verifyResult.details);
    await recordStepCompletion(
      brain,
      runCtx,
      `fix_dispatch_${runCtx.iteration}`,
      `Dispatched ${fixTasks.length} fix tasks`,
    );

    const fixHandoffs = await collectHandoffs(neuralLink, roomId, fixTasks.length);
    await recordStepCompletion(
      brain,
      runCtx,
      `fix_wait_${runCtx.iteration}`,
      `Received ${fixHandoffs.length}/${fixTasks.length} fix handoffs`,
    );
  }
}

async function dispatchTasks(
  neuralLink: NeuralLinkSwarmAdapter,
  roomId: string,
  objective: string,
  tasks: SwarmTask[],
): Promise<void> {
  await Promise.all(
    tasks.map((task) => {
      return neuralLink.messageSend({
        roomId,
        from: LEAD_PARTICIPANT_ID,
        kind: MessageKind.Finding,
        summary: `Execute ${task.title}`,
        to: task.agentRole,
        body: `${task.description}\nObjective: ${objective}`,
      });
    }),
  );
}

async function dispatchFixTasks(
  neuralLink: NeuralLinkSwarmAdapter,
  roomId: string,
  runCtx: RunContext,
  tasks: SwarmTask[],
  verifyDetails: string,
): Promise<void> {
  await Promise.all(
    tasks.map((task) => {
      return neuralLink.messageSend({
        roomId,
        from: LEAD_PARTICIPANT_ID,
        kind: MessageKind.Finding,
        summary: `Fix ${task.title} (attempt ${runCtx.iteration})`,
        to: task.agentRole,
        body: `Address verification failure: ${verifyDetails}`,
      });
    }),
  );
}

async function collectHandoffs(
  neuralLink: NeuralLinkSwarmAdapter,
  roomId: string,
  expectedCount: number,
): Promise<unknown[]> {
  const handoffs: unknown[] = [];

  for (let index = 0; index < expectedCount; index += 1) {
    const message = await neuralLink.waitFor(
      roomId,
      LEAD_PARTICIPANT_ID,
      DEFAULT_WAIT_TIMEOUT_MS,
      [MessageKind.Handoff],
    );

    if (message !== null) {
      handoffs.push(message);
    }
  }

  return handoffs;
}

async function verifyWave(
  neuralLink: NeuralLinkSwarmAdapter,
  roomId: string,
  objective: string,
): Promise<VerifyResult> {
  await neuralLink.messageSend({
    roomId,
    from: LEAD_PARTICIPANT_ID,
    kind: MessageKind.ReviewRequest,
    summary: "Verify swarm integration",
    to: "verifier",
    body: `Validate integrated swarm output for objective: ${objective}`,
  });

  const verifyMessage = await neuralLink.waitFor(
    roomId,
    LEAD_PARTICIPANT_ID,
    DEFAULT_WAIT_TIMEOUT_MS,
    [MessageKind.ReviewResult],
  );

  return parseVerifyResult(verifyMessage);
}

function parseVerifyResult(value: unknown): VerifyResult {
  if (!isObject(value)) {
    return {
      passed: false,
      details: "swarm verification result missing",
      failedTasks: [],
    };
  }

  const passed = value.passed === true;
  const details = typeof value.details === "string" && value.details.trim().length > 0
    ? value.details
    : `swarm verification ${passed ? "passed" : "failed"}`;
  const failedTasks = Array.isArray(value.failedTasks)
    ? value.failedTasks.filter((item): item is string => typeof item === "string")
    : [];

  return { passed, details, failedTasks };
}

function selectFixTasks(allTasks: SwarmTask[], failedTaskTitles: string[]): SwarmTask[] {
  if (failedTaskTitles.length === 0) {
    return allTasks;
  }

  const selected = allTasks.filter((task) => failedTaskTitles.includes(task.title));
  if (selected.length === 0) {
    return allTasks;
  }

  return selected;
}

function summarizeObjective(objective: string): string {
  const cleaned = objective.trim().replace(/\s+/g, " ");
  if (cleaned.length <= 96) {
    return cleaned;
  }

  return `${cleaned.slice(0, 93)}...`;
}

function getSwarmTasks(objectiveSummary: string): SwarmTask[] {
  return [
    {
      title: "Task 1",
      description: `Map architecture impacts for ${objectiveSummary}`,
      agentRole: "cortex",
      dependencies: [],
    },
    {
      title: "Task 2",
      description: `Implement core orchestration changes for ${objectiveSummary}`,
      agentRole: "probe",
      dependencies: ["Task 1"],
    },
    {
      title: "Task 3",
      description: `Prepare integration tests for ${objectiveSummary}`,
      agentRole: "liaison",
      dependencies: ["Task 1"],
    },
    {
      title: "Task 4",
      description: `Harden error handling paths for ${objectiveSummary}`,
      agentRole: "probe-2",
      dependencies: ["Task 2"],
    },
    {
      title: "Task 5",
      description: `Assemble completion evidence for ${objectiveSummary}`,
      agentRole: "cortex-2",
      dependencies: ["Task 2", "Task 3", "Task 4"],
    },
  ];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

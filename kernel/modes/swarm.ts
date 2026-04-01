import { MessageKind, type NeuralLinkPort } from "../types.ts";
import { Mode, RunState, type RunContext, type SwarmTask, type WaitForMessage } from "../types.ts";
import { drainInbox, waitAndProcessInbox } from "../coordination.ts";
import {
  createRunContext,
  recordFailure,
  recordStepCompletion,
  recordVerifyResult,
  shouldRetry,
  transitionState,
} from "./shared.ts";
import type { PersistenceCoordinator } from "../persistence.ts";
import type { VerificationOutcome, VerificationResult, VerificationStrategy } from "../verification/types.ts";
import { VerificationPipeline, createVerificationPipeline } from "../verification/pipeline.ts";
import type { LspAdapter, BashAdapter } from "../verification/strategies.ts";

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


interface VerifyResult {
  outcome: VerificationOutcome;
  details: string;
  failedTasks: string[];
  failedFiles: string[];
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
  neuralLink: NeuralLinkPort,
  persistence: Pick<PersistenceCoordinator, "updateRun" | "completeRun" | "failRun"> = NOOP_PERSISTENCE,
  verificationStrategies?: VerificationStrategy[],
  lsp?: LspAdapter,
  bash?: BashAdapter,
  retryMode: "in-context" | "fresh-context" = "in-context",
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
    interactionMode: "informative",
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
    await drainInbox(neuralLink, roomId, LEAD_PARTICIPANT_ID, async (_msg) => {
      // Drain any late-arriving messages before starting verification
    });

    runCtx = transitionState(runCtx, RunState.Verifying);
    await persistence.updateRun(runCtx, {
      checkpointSummary: "Verifying swarm wave",
    });
    const verifyResult = await verifyWave(
      neuralLink,
      roomId,
      ctx.objective,
      verificationStrategies,
      lsp,
      bash,
      ctx.workspace,
      ctx.run_id,
    );
    await recordVerifyResult(brain, runCtx, verifyResult.outcome, verifyResult.details);

    if (verifyResult.outcome === "passed") {
      await neuralLink.roomClose(roomId, "completed");

      const actions = swarmTasks.map((t) => t.title).join("; ");
      const outcome = `Swarm completed all ${swarmTasks.length} tasks successfully after ${runCtx.iteration + 1} wave(s)`;

      await brain.memoryEpisode({
        goal: `Swarm objective (${ctx.run_id}): ${objectiveSummary}`,
        actions,
        outcome,
        tags: ["overmind", "swarm", "orchestration"],
        importance: 1.0,
      });

      if (taskId) {
        await brain.taskComplete(taskId);
      }
      runCtx = transitionState(runCtx, RunState.Completed);
      await persistence.completeRun(runCtx, outcome);
      return runCtx;
    }

    // Skip fix-loop on stuck/timeout — retrying won't help
    if (verifyResult.outcome === "stuck" || verifyResult.outcome === "timeout") {
      runCtx = transitionState(runCtx, RunState.Failed);
      const reason = `Swarm verification ${verifyResult.outcome}: ${verifyResult.details}`;
      await recordFailure(brain, runCtx, reason);
      await neuralLink.roomClose(roomId, "failed");

      const actions = swarmTasks.map((t) => t.title).join("; ");
      await brain.memoryEpisode({
        goal: `Swarm objective (${ctx.run_id}): ${objectiveSummary}`,
        actions,
        outcome: `${verifyResult.outcome} after ${runCtx.iteration + 1} wave(s): ${verifyResult.details}`,
        tags: ["overmind", "swarm", verifyResult.outcome],
        importance: 1.0,
      });

      await persistence.failRun(runCtx, reason);
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
        importance: 1.0,
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
    await dispatchFixTasks(neuralLink, roomId, runCtx, fixTasks, verifyResult.details, ctx.objective, verifyResult.failedFiles, retryMode);
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
  neuralLink: NeuralLinkPort,
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
        threadId: task.agentRole,
      });
    }),
  );
}

async function dispatchFixTasks(
  neuralLink: NeuralLinkPort,
  roomId: string,
  runCtx: RunContext,
  tasks: SwarmTask[],
  verifyDetails: string,
  objective: string,
  failedFiles: string[],
  retryMode: "in-context" | "fresh-context",
): Promise<void> {
  const body = retryMode === "fresh-context"
    ? buildFreshContextBody(objective, verifyDetails, failedFiles, runCtx.iteration)
    : `Address verification failure: ${verifyDetails}`;

  await Promise.all(
    tasks.map((task) => {
      return neuralLink.messageSend({
        roomId,
        from: LEAD_PARTICIPANT_ID,
        kind: MessageKind.Finding,
        summary: `Fix ${task.title} (attempt ${runCtx.iteration})`,
        to: task.agentRole,
        body,
        threadId: task.agentRole,
      });
    }),
  );
}

function buildFreshContextBody(
  objective: string,
  failureSummary: string,
  failedFiles: string[],
  attemptNumber: number,
): string {
  const brief = failureSummary.length > 500
    ? failureSummary.slice(0, 497) + "..."
    : failureSummary;
  const files = failedFiles.length > 0
    ? `\nFiles to examine: ${failedFiles.join(", ")}`
    : "";
  return `Objective: ${objective}\nPrevious attempt ${attemptNumber} failed: ${brief}${files}`;
}

async function collectHandoffs(
  neuralLink: NeuralLinkPort,
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

    await drainInbox(neuralLink, roomId, LEAD_PARTICIPANT_ID, async (_msg) => {
      // Catch interleaved messages during handoff collection
    });
  }

  return handoffs;
}

async function verifyWave(
  neuralLink: NeuralLinkPort,
  roomId: string,
  objective: string,
  verificationStrategies?: VerificationStrategy[],
  lsp?: LspAdapter,
  bash?: BashAdapter,
  workspace?: string,
  runId?: string,
): Promise<VerifyResult> {
  if (verificationStrategies && verificationStrategies.length > 0) {
    return await verifyWithPipeline(neuralLink, roomId, objective, verificationStrategies, lsp, bash, workspace, runId);
  }

  return await verifyWithAgent(neuralLink, roomId, objective);
}

async function verifyWithAgent(
  neuralLink: NeuralLinkPort,
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

async function verifyWithPipeline(
  neuralLink: NeuralLinkPort,
  roomId: string,
  objective: string,
  verificationStrategies: VerificationStrategy[],
  lsp?: LspAdapter,
  bash?: BashAdapter,
  workspace?: string,
  runId?: string,
): Promise<VerifyResult> {
  const pipeline = createVerificationPipeline(
    verificationStrategies,
    { workspace: workspace ?? "", objective, runId: runId ?? "" },
    {
      lsp,
      bash,
      neuralLink: {
        messageSend: async (params: { roomId: string; from: string; kind: string; summary: string; to?: string; body?: string }) => {
          return await neuralLink.messageSend({
            roomId: params.roomId,
            from: params.from,
            kind: params.kind as MessageKind,
            summary: params.summary,
            to: params.to,
            body: params.body,
          });
        },
        waitFor: async (roomId: string, participantId: string, timeoutMs: number, kinds?: string[]) => {
          return await neuralLink.waitFor(roomId, participantId, timeoutMs, kinds);
        },
      },
      roomId,
      participantId: LEAD_PARTICIPANT_ID,
      timeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
    },
  );

  const result = await pipeline.verify();

  return {
    outcome: result.outcome,
    details: result.details,
    failedTasks: result.failedTasks.map((ft) => ft.taskId),
    failedFiles: extractFailedFiles(result),
  };
}

function parseVerifyResult(value: unknown): VerifyResult {
  if (!isObject(value)) {
    return {
      outcome: "failed",
      details: "swarm verification result missing",
      failedTasks: [],
      failedFiles: [],
    };
  }

  const passed = value.passed === true;
  const details = typeof value.details === "string" && value.details.trim().length > 0
    ? value.details
    : `swarm verification ${passed ? "passed" : "failed"}`;
  const failedTasks = Array.isArray(value.failedTasks)
    ? value.failedTasks.filter((item): item is string => typeof item === "string")
    : [];

  // Agent-based verification does not return file paths — failedFiles only populated via pipeline strategies
  return { outcome: passed ? "passed" : "failed", details, failedTasks, failedFiles: [] };
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

function extractFailedFiles(result: VerificationResult): string[] {
  const files = new Set<string>();
  for (const ft of result.failedTasks) {
    for (const e of ft.evidence) {
      if (e.path) files.add(e.path);
    }
  }
  for (const d of result.evidence.diagnostics) {
    if (d.file) files.add(d.file);
  }
  return [...files];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

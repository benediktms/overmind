import { MessageKind, type NeuralLinkPort } from "../types.ts";
import { Mode, RunState, type RelayStep, type RunContext, type WaitForMessage } from "../types.ts";
import { drainInbox } from "../coordination.ts";
import type { VerificationOutcome } from "../verification/types.ts";
import {
  createRunContext,
  recordFailure,
  recordStepCompletion,
  recordVerifyResult,
  shouldRetry,
  summarizeObjective,
  transitionState,
} from "./shared.ts";
import { isObject } from "../utils.ts";
import type { PersistenceCoordinator } from "../persistence.ts";
import { topologicalSort, type TaskGraph, type TaskNode } from "../planner/planner.ts";
import { safeDispatch, type AgentDispatcher } from "../agent_dispatcher.ts";
import { CancellationError, throwIfAborted } from "../cancellation.ts";

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const LEAD_PARTICIPANT_ID = "overmind-relay-lead";
const LEAD_DISPLAY_NAME = "Overmind Relay Lead";

interface BrainRelayAdapter {
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
}

const NOOP_PERSISTENCE: Pick<
  PersistenceCoordinator,
  "updateRun" | "completeRun" | "failRun" | "cancelRun"
> = {
  updateRun: async () => {},
  completeRun: async () => {},
  failRun: async () => {},
  cancelRun: async () => {},
};

export async function executeRelay(
  ctx: RunContext,
  brain: BrainRelayAdapter,
  neuralLink: NeuralLinkPort,
  persistence: Pick<PersistenceCoordinator, "updateRun" | "completeRun" | "failRun" | "cancelRun"> = NOOP_PERSISTENCE,
  graph?: TaskGraph,
  dispatcher?: AgentDispatcher,
): Promise<RunContext> {
  let roomIdForCleanup: string | null = null;
  let runCtxForCleanup: RunContext | null = null;
  try {
  const objectiveSummary = summarizeObjective(ctx.objective);

  let runCtx = createRunContext({
    run_id: ctx.run_id,
    mode: Mode.Relay,
    objective: ctx.objective,
    workspace: ctx.workspace,
    brain_task_id: "",
    room_id: ctx.room_id,
    max_iterations: ctx.max_iterations,
    created_at: ctx.created_at,
  });
  runCtxForCleanup = runCtx;
  throwIfAborted(ctx.signal);

  const taskId = await brain.taskCreate({
    title: `[overmind:relay] ${objectiveSummary}`,
  }) ?? "";

  runCtx = { ...runCtx, brain_task_id: taskId };
  runCtxForCleanup = runCtx;

  await persistence.updateRun(runCtx, {
    checkpointSummary: taskId ? "Created relay brain task" : "Running relay without Brain task",
  });

  if (taskId) {
    await brain.taskAddExternalId(taskId, `overmind_run_id:${ctx.run_id}`);
  }

  runCtx = transitionState(runCtx, RunState.Running);
  await persistence.updateRun(runCtx, {
    checkpointSummary: "Relay run entered running state",
  });

  const roomId = await neuralLink.roomOpen({
    title: `[overmind:relay:${ctx.run_id}] sequential pipeline`,
    participantId: LEAD_PARTICIPANT_ID,
    displayName: LEAD_DISPLAY_NAME,
    purpose: ctx.objective,
    externalRef: ctx.run_id,
    interactionMode: "supervisory",
  });

  if (!roomId) {
    await persistence.failRun({ ...runCtx, state: RunState.Failed }, "Failed to open relay coordination room");
    throw new Error("Failed to open relay coordination room");
  }

  runCtx = {
    ...runCtx,
    room_id: roomId,
  };
  roomIdForCleanup = roomId;
  runCtxForCleanup = runCtx;
  await persistence.updateRun(runCtx, {
    checkpointSummary: `Opened relay coordination room ${roomId}`,
  });

  const steps = graph
    ? topologicalSort(graph).map((node): RelayStep => ({
        title: node.title,
        description: node.description,
        agentRole: node.agentRole,
      }))
    : getRelaySteps(objectiveSummary);

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
    throwIfAborted(ctx.signal);
    runCtxForCleanup = runCtx;
    const step = steps[stepIndex];
    const stepParticipantId = `${step.agentRole}-step-${stepIndex}`;

    await neuralLink.messageSend({
      roomId,
      from: LEAD_PARTICIPANT_ID,
      kind: MessageKind.Finding,
      summary: `Execute ${step.title}: ${step.description}`,
      to: stepParticipantId,
      body: `Objective: ${ctx.objective}`,
      threadId: `step-${stepIndex}`,
    });

    if (dispatcher?.isAvailable()) {
      await safeDispatch(dispatcher, {
        agentId: `${ctx.run_id}-${step.agentRole}-step-${stepIndex}`,
        role: step.agentRole,
        prompt: `${step.title}: ${step.description}`,
        roomId,
        participantId: stepParticipantId,
        workspace: ctx.workspace,
      });
    }

    const handoff = await neuralLink.waitFor(
      roomId,
      LEAD_PARTICIPANT_ID,
      DEFAULT_WAIT_TIMEOUT_MS,
      [MessageKind.Handoff],
    );
    throwIfAborted(ctx.signal);

    await drainInbox(neuralLink, roomId, LEAD_PARTICIPANT_ID, async (_msg) => {
      // Log interleaved messages; no action needed in supervisory mode
    });

    await recordStepCompletion(
      brain,
      runCtx,
      `relay_${stepIndex + 1}`,
      summarizeHandoff(handoff, `${step.title} handoff received`),
    );

    let verifyPassed = false;

    while (!verifyPassed) {
      throwIfAborted(ctx.signal);
      runCtxForCleanup = runCtx;
      runCtx = transitionState(runCtx, RunState.Verifying);
      await persistence.updateRun(runCtx, {
        checkpointSummary: `Verifying ${step.title}`,
      });

      const verifierParticipantId = `verifier-step-${stepIndex}-iter-${runCtx.iteration}`;
      await neuralLink.messageSend({
        roomId,
        from: LEAD_PARTICIPANT_ID,
        kind: MessageKind.ReviewRequest,
        summary: `Verify ${step.title}`,
        to: verifierParticipantId,
        body: `Validate output for ${step.title} in objective: ${ctx.objective}`,
        threadId: `step-${stepIndex}`,
      });

      if (dispatcher?.isAvailable()) {
        await safeDispatch(dispatcher, {
          agentId: `${ctx.run_id}-verifier-step-${stepIndex}-iter-${runCtx.iteration}`,
          role: "verifier",
          prompt: `Verify ${step.title}`,
          roomId,
          participantId: verifierParticipantId,
          workspace: ctx.workspace,
        });
      }

      const verifyMessage = await neuralLink.waitFor(
        roomId,
        LEAD_PARTICIPANT_ID,
        DEFAULT_WAIT_TIMEOUT_MS,
        [MessageKind.ReviewResult],
      );

      const verifyResult = parseVerifyResult(verifyMessage, step.title);
      await recordVerifyResult(brain, runCtx, verifyResult.outcome, verifyResult.details);

      if (verifyResult.outcome === "passed") {
        verifyPassed = true;
        continue;
      }

      // Skip fix-loop on stuck/timeout — retrying won't help
      if (verifyResult.outcome === "stuck" || verifyResult.outcome === "timeout") {
        runCtx = transitionState(runCtx, RunState.Failed);
        const reason = `Relay verification ${verifyResult.outcome} for ${step.title}: ${verifyResult.details}`;
        await recordFailure(brain, runCtx, reason);
        await neuralLink.roomClose(roomId, "failed");

        const actions = steps.slice(0, stepIndex + 1).map((s) => s.title).join("; ");
        await brain.memoryEpisode({
          goal: `Relay objective (${ctx.run_id}): ${objectiveSummary}`,
          actions,
          outcome: `${verifyResult.outcome} at ${step.title}: ${verifyResult.details}`,
          tags: ["overmind", "relay", verifyResult.outcome],
          importance: 3,
        });

        await persistence.failRun(runCtx, reason);
        return runCtx;
      }

      if (!shouldRetry(runCtx)) {
        runCtx = transitionState(runCtx, RunState.Failed);
        await recordFailure(brain, runCtx, `Verification failed for ${step.title}: ${verifyResult.details}`);
        await neuralLink.roomClose(roomId, "failed");

        const actions = steps.slice(0, stepIndex + 1).map((s) => s.title).join("; ");
        await brain.memoryEpisode({
          goal: `Relay objective (${ctx.run_id}): ${objectiveSummary}`,
          actions,
          outcome: `Failed at ${step.title}: ${verifyResult.details}`,
          tags: ["overmind", "relay", "failure"],
          importance: 3,
        });

        await persistence.failRun(runCtx, `Verification failed for ${step.title}: ${verifyResult.details}`);
        return runCtx;
      }

      runCtx = {
        ...transitionState(runCtx, RunState.Fixing),
        iteration: runCtx.iteration + 1,
      };
      await persistence.updateRun(runCtx, {
        checkpointSummary: `Fixing ${step.title} after verification failure`,
      });

      const fixParticipantId = `${step.agentRole}-step-${stepIndex}-fix-${runCtx.iteration}`;
      await neuralLink.messageSend({
        roomId,
        from: LEAD_PARTICIPANT_ID,
        kind: MessageKind.Finding,
        summary: `Fix ${step.title} (attempt ${runCtx.iteration})`,
        to: fixParticipantId,
        body: `Address verify failure: ${verifyResult.details}`,
        threadId: `step-${stepIndex}`,
      });

      if (dispatcher?.isAvailable()) {
        await safeDispatch(dispatcher, {
          agentId: `${ctx.run_id}-${step.agentRole}-step-${stepIndex}-fix-${runCtx.iteration}`,
          role: step.agentRole,
          prompt: `Fix ${step.title}: ${verifyResult.details}`,
          roomId,
          participantId: fixParticipantId,
          workspace: ctx.workspace,
        });
      }

      const fixHandoff = await neuralLink.waitFor(
        roomId,
        LEAD_PARTICIPANT_ID,
        DEFAULT_WAIT_TIMEOUT_MS,
        [MessageKind.Handoff],
      );

      await recordStepCompletion(
        brain,
        runCtx,
        `relay_${stepIndex + 1}_fix_${runCtx.iteration}`,
        summarizeHandoff(fixHandoff, `${step.title} fix handoff received`),
      );
    }
  }

  await neuralLink.roomClose(roomId, "completed");

  const actions = steps.map((s, i) => `${s.title}: ${s.agentRole}`).join("; ");
  const outcome = `Relay completed all ${steps.length} steps successfully`;

  await brain.memoryEpisode({
    goal: `Relay objective (${ctx.run_id}): ${objectiveSummary}`,
    actions,
    outcome,
    tags: ["overmind", "relay", "orchestration"],
    importance: 2,
  });

  if (taskId) {
    await brain.taskComplete(taskId);
  }
  runCtx = transitionState(runCtx, RunState.Completed);
  await persistence.completeRun(runCtx, outcome);
  return runCtx;
  } catch (err) {
    if (!(err instanceof CancellationError)) throw err;
    return await finalizeCancelledRelay(runCtxForCleanup, roomIdForCleanup, neuralLink, persistence);
  }
}

async function finalizeCancelledRelay(
  runCtx: RunContext | null,
  roomId: string | null,
  neuralLink: NeuralLinkPort,
  persistence: Pick<PersistenceCoordinator, "cancelRun">,
): Promise<RunContext> {
  if (!runCtx) {
    throw new CancellationError();
  }
  const cancelledCtx = transitionState(runCtx, RunState.Cancelled);
  if (roomId) {
    try { await neuralLink.roomClose(roomId, "cancelled"); } catch { /* best-effort */ }
  }
  await persistence.cancelRun(cancelledCtx);
  return cancelledCtx;
}

function getRelaySteps(objectiveSummary: string): RelayStep[] {
  return [
    {
      title: "Step 1 - Plan",
      description: `Define implementation plan for ${objectiveSummary}`,
      agentRole: "cortex",
    },
    {
      title: "Step 2 - Execute",
      description: `Implement core changes for ${objectiveSummary}`,
      agentRole: "probe",
    },
    {
      title: "Step 3 - Validate",
      description: `Prepare completion evidence for ${objectiveSummary}`,
      agentRole: "liaison",
    },
  ];
}

function summarizeHandoff(value: unknown, fallback: string): string {
  if (!isObject(value)) {
    return fallback;
  }

  const summary = value.summary;
  if (typeof summary === "string" && summary.trim().length > 0) {
    return summary;
  }

  return fallback;
}

function parseVerifyResult(value: unknown, stepTitle: string): VerifyResult {
  if (!isObject(value)) {
    return {
      outcome: "failed",
      details: `${stepTitle} verify result missing`,
    };
  }

  const passed = value.passed === true;
  const details = typeof value.details === "string" && value.details.trim().length > 0
    ? value.details
    : `${stepTitle} verification ${passed ? "passed" : "failed"}`;

  return { outcome: passed ? "passed" : "failed", details };
}

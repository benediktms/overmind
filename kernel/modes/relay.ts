import { MessageKind } from "../../adapters/neural_link/adapter.ts";
import { Mode, RunState, type RelayStep, type RunContext } from "../types.ts";
import {
  createRunContext,
  recordFailure,
  recordStepCompletion,
  recordVerifyResult,
  shouldRetry,
  transitionState,
} from "./shared.ts";

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const LEAD_PARTICIPANT_ID = "overmind-relay-lead";
const LEAD_DISPLAY_NAME = "Overmind Relay Lead";

interface BrainRelayAdapter {
  taskCreate(params: { title: string }): Promise<string | null>;
  taskAddExternalId(taskId: string, externalId: string): Promise<boolean>;
  taskComplete(taskId: string): Promise<boolean>;
  taskComment(taskId: string, comment: string): Promise<boolean>;
  taskSetPriority(taskId: string, priority: number): Promise<boolean>;
}

interface NeuralLinkRelayAdapter {
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
}

export async function executeRelay(
  ctx: RunContext,
  brain: BrainRelayAdapter,
  neuralLink: NeuralLinkRelayAdapter,
): Promise<RunContext> {
  const objectiveSummary = summarizeObjective(ctx.objective);

  const taskId = await brain.taskCreate({
    title: `[overmind:relay] ${objectiveSummary}`,
  });

  if (!taskId) {
    throw new Error("Failed to create relay brain task");
  }

  let runCtx = createRunContext({
    run_id: ctx.run_id,
    mode: Mode.Relay,
    objective: ctx.objective,
    workspace: ctx.workspace,
    brain_task_id: taskId,
    room_id: ctx.room_id,
    max_iterations: ctx.max_iterations,
    created_at: ctx.created_at,
  });

  await brain.taskAddExternalId(taskId, `overmind_run_id:${ctx.run_id}`);

  runCtx = transitionState(runCtx, RunState.Running);

  const roomId = await neuralLink.roomOpen({
    title: `[overmind:relay:${ctx.run_id}] sequential pipeline`,
    participantId: LEAD_PARTICIPANT_ID,
    displayName: LEAD_DISPLAY_NAME,
    purpose: ctx.objective,
    externalRef: ctx.run_id,
  });

  if (!roomId) {
    throw new Error("Failed to open relay coordination room");
  }

  runCtx = {
    ...runCtx,
    room_id: roomId,
  };

  const steps = getRelaySteps(objectiveSummary);

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
    const step = steps[stepIndex];

    await neuralLink.messageSend({
      roomId,
      from: LEAD_PARTICIPANT_ID,
      kind: MessageKind.Finding,
      summary: `Execute ${step.title}: ${step.description}`,
      to: step.agentRole,
      body: `Objective: ${ctx.objective}`,
    });

    const handoff = await neuralLink.waitFor(
      roomId,
      LEAD_PARTICIPANT_ID,
      DEFAULT_WAIT_TIMEOUT_MS,
      [MessageKind.Handoff],
    );

    await recordStepCompletion(
      brain,
      runCtx,
      `relay_${stepIndex + 1}`,
      summarizeHandoff(handoff, `${step.title} handoff received`),
    );

    let verifyPassed = false;

    while (!verifyPassed) {
      runCtx = transitionState(runCtx, RunState.Verifying);

      await neuralLink.messageSend({
        roomId,
        from: LEAD_PARTICIPANT_ID,
        kind: MessageKind.ReviewRequest,
        summary: `Verify ${step.title}`,
        to: "verifier",
        body: `Validate output for ${step.title} in objective: ${ctx.objective}`,
      });

      const verifyMessage = await neuralLink.waitFor(
        roomId,
        LEAD_PARTICIPANT_ID,
        DEFAULT_WAIT_TIMEOUT_MS,
        [MessageKind.ReviewResult],
      );

      const verifyResult = parseVerifyResult(verifyMessage, step.title);
      await recordVerifyResult(brain, runCtx, verifyResult.passed, verifyResult.details);

      if (verifyResult.passed) {
        verifyPassed = true;
        continue;
      }

      if (!shouldRetry(runCtx)) {
        runCtx = transitionState(runCtx, RunState.Failed);
        await recordFailure(brain, runCtx, `Verification failed for ${step.title}: ${verifyResult.details}`);
        await neuralLink.roomClose(roomId, "failed");
        return runCtx;
      }

      runCtx = {
        ...transitionState(runCtx, RunState.Fixing),
        iteration: runCtx.iteration + 1,
      };

      await neuralLink.messageSend({
        roomId,
        from: LEAD_PARTICIPANT_ID,
        kind: MessageKind.Finding,
        summary: `Fix ${step.title} (attempt ${runCtx.iteration})`,
        to: step.agentRole,
        body: `Address verify failure: ${verifyResult.details}`,
      });

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
  await brain.taskComplete(taskId);
  runCtx = transitionState(runCtx, RunState.Completed);
  return runCtx;
}

function summarizeObjective(objective: string): string {
  const cleaned = objective.trim().replace(/\s+/g, " ");
  if (cleaned.length <= 96) {
    return cleaned;
  }

  return `${cleaned.slice(0, 93)}...`;
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
      passed: false,
      details: `${stepTitle} verify result missing`,
    };
  }

  const passed = value.passed === true;
  const details = typeof value.details === "string" && value.details.trim().length > 0
    ? value.details
    : `${stepTitle} verification ${passed ? "passed" : "failed"}`;

  return { passed, details };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

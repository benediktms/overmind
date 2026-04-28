import { MessageKind, type NeuralLinkPort } from "../types.ts";
import {
  Mode,
  type RunContext,
  RunState,
  type WaitForMessage,
} from "../types.ts";
import { drainInbox } from "../coordination.ts";
import {
  createRunContext,
  recordStepCompletion,
  summarizeObjective,
  transitionState,
} from "./shared.ts";
import type { PersistenceCoordinator } from "../persistence.ts";
import type { TaskGraph } from "../planner/planner.ts";
import { type AgentDispatcher, safeDispatch } from "../agent_dispatcher.ts";
import { CancellationError, throwIfAborted } from "../cancellation.ts";

const DEFAULT_SCOUT_PARALLEL = 3;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const LEAD_PARTICIPANT_ID = "overmind-scout-lead";
const LEAD_DISPLAY_NAME = "Overmind Scout Lead";

interface BrainScoutAdapter {
  taskCreate(params: { title: string }): Promise<string | null>;
  taskAddExternalId(taskId: string, externalId: string): Promise<boolean>;
  memoryEpisode(params: {
    goal: string;
    actions: string;
    outcome: string;
    tags?: string[];
    importance?: number;
  }): Promise<boolean>;
  memorySearch(
    query: string,
    options?: { k?: number; tags?: string[] },
  ): Promise<Array<{ goal: string; actions: string; outcome: string }>>;
  taskComplete(taskId: string): Promise<boolean>;
  taskComment(taskId: string, comment: string): Promise<boolean>;
}

interface HandoffMessage {
  from?: string;
  summary?: string;
  body?: string;
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

export async function executeScout(
  ctx: RunContext,
  brain: BrainScoutAdapter,
  neuralLink: NeuralLinkPort,
  persistence: Pick<
    PersistenceCoordinator,
    "updateRun" | "completeRun" | "failRun" | "cancelRun"
  > = NOOP_PERSISTENCE,
  graph?: TaskGraph,
  dispatcher?: AgentDispatcher,
): Promise<RunContext> {
  let roomIdForCleanup: string | null = null;
  let runCtxForCleanup: RunContext | null = null;
  try {
    const objectiveSummary = summarizeObjective(ctx.objective);

    let runCtx = createRunContext({
      run_id: ctx.run_id,
      mode: Mode.Scout,
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
      title: `[overmind:scout] ${objectiveSummary}`,
    }) ?? "";

    runCtx = { ...runCtx, brain_task_id: taskId };
    runCtxForCleanup = runCtx;

    await persistence.updateRun(runCtx, {
      checkpointSummary: taskId
        ? "Created scout brain task"
        : "Running without Brain task",
    });

    if (taskId) {
      await brain.taskAddExternalId(taskId, `overmind_run_id:${ctx.run_id}`);
    }
    await recordStepCompletion(
      brain,
      runCtx,
      "task_setup",
      "Created scout task and linked run ID",
    );

    runCtx = transitionState(runCtx, RunState.Running);
    await persistence.updateRun(runCtx, {
      checkpointSummary: "Scout run entered running state",
    });

    const roomId = await neuralLink.roomOpen({
      title: `[overmind:scout:${ctx.run_id}] parallel exploration`,
      participantId: LEAD_PARTICIPANT_ID,
      displayName: LEAD_DISPLAY_NAME,
      purpose: ctx.objective,
      externalRef: ctx.run_id,
      interactionMode: "informative",
    });

    if (!roomId) {
      await persistence.failRun(
        { ...runCtx, state: RunState.Failed },
        "Failed to open scout coordination room",
      );
      throw new Error("Failed to open scout coordination room");
    }

    runCtx = {
      ...runCtx,
      room_id: roomId,
    };
    roomIdForCleanup = roomId;
    runCtxForCleanup = runCtx;
    await persistence.updateRun(runCtx, {
      checkpointSummary: `Opened scout coordination room ${roomId}`,
    });

    const angles = graph
      ? graph.tasks.map((t) => `${t.title}: ${t.description}`)
      : getExploreAngles(objectiveSummary, DEFAULT_SCOUT_PARALLEL);
    await Promise.all(
      angles.map((angle, index) => {
        return neuralLink.messageSend({
          roomId,
          from: LEAD_PARTICIPANT_ID,
          kind: MessageKind.Finding,
          summary: `Explore angle ${index + 1}/${angles.length}: ${angle}`,
          to: `probe-${index + 1}`,
          body: `Objective: ${ctx.objective}`,
          threadId: `probe-${index}`,
        });
      }),
    );

    if (dispatcher?.isAvailable()) {
      await Promise.allSettled(
        angles.map((prompt, index) =>
          safeDispatch(dispatcher, {
            agentId: `${ctx.run_id}-probe-${index + 1}`,
            role: "probe",
            prompt,
            roomId,
            participantId: `probe-${index + 1}`,
            workspace: ctx.workspace,
          })
        ),
      );
    }

    await recordStepCompletion(
      brain,
      runCtx,
      "dispatch",
      `Dispatched ${angles.length} scout probes`,
    );

    const handoffs: HandoffMessage[] = [];
    for (let index = 0; index < angles.length; index += 1) {
      throwIfAborted(ctx.signal);
      const message = await neuralLink.waitFor(
        roomId,
        LEAD_PARTICIPANT_ID,
        DEFAULT_WAIT_TIMEOUT_MS,
        [MessageKind.Handoff],
      );
      throwIfAborted(ctx.signal);

      if (isHandoffMessage(message)) {
        handoffs.push(message);
      }
    }
    await recordStepCompletion(
      brain,
      runCtx,
      "wait",
      `Received ${handoffs.length}/${angles.length} handoffs`,
    );

    await drainInbox(neuralLink, roomId, LEAD_PARTICIPANT_ID, async (_msg) => {
      // Catch late-arriving findings after the handoff collection window closes
    });

    const actions = synthesizeActions(handoffs);
    const outcome =
      `Scout synthesis complete with ${handoffs.length}/${angles.length} handoffs`;

    await brain.memoryEpisode({
      goal: `Scout objective (${ctx.run_id}): ${objectiveSummary}`,
      actions,
      outcome,
      tags: ["overmind", "scout", "orchestration"],
      importance: 2,
    });
    await recordStepCompletion(brain, runCtx, "synthesize", outcome);

    await neuralLink.roomClose(roomId, "completed");
    if (taskId) {
      await brain.taskComplete(taskId);
    }

    runCtx = transitionState(runCtx, RunState.Completed);
    await persistence.completeRun(runCtx, outcome);
    return runCtx;
  } catch (err) {
    if (!(err instanceof CancellationError)) throw err;
    if (!runCtxForCleanup) throw err;
    const cancelledCtx = transitionState(runCtxForCleanup, RunState.Cancelled);
    if (roomIdForCleanup) {
      try {
        await neuralLink.roomClose(roomIdForCleanup, "cancelled");
      } catch { /* best-effort */ }
    }
    await persistence.cancelRun(cancelledCtx);
    return cancelledCtx;
  }
}

function getExploreAngles(
  objectiveSummary: string,
  parallelism: number,
): string[] {
  const defaults = [
    `Architecture and dependency map for ${objectiveSummary}`,
    `Relevant tests, fixtures, and verification points for ${objectiveSummary}`,
    `Risks, unknowns, and edge cases for ${objectiveSummary}`,
  ];

  if (parallelism <= defaults.length) {
    return defaults.slice(0, parallelism);
  }

  const extras = Array.from(
    { length: parallelism - defaults.length },
    (_, index) => {
      return `Additional scout angle ${index + 1} for ${objectiveSummary}`;
    },
  );

  return [...defaults, ...extras];
}

function synthesizeActions(handoffs: HandoffMessage[]): string {
  if (handoffs.length === 0) {
    return "No handoff findings received before timeout.";
  }

  return handoffs
    .map((handoff, index) => {
      const from = handoff.from ?? `probe-${index + 1}`;
      const summary = handoff.summary ?? "(no summary)";
      const body = handoff.body ? ` | ${handoff.body}` : "";
      return `${from}: ${summary}${body}`;
    })
    .join("\n");
}

function isHandoffMessage(value: unknown): value is HandoffMessage {
  return typeof value === "object" && value !== null;
}

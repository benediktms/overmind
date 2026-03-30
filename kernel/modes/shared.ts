import { Mode, type RunContext, RunState } from "../types.ts";

interface BrainTaskWriter {
  taskComment(taskId: string, comment: string): Promise<boolean>;
}

interface BrainFailureWriter extends BrainTaskWriter {
  taskSetPriority(taskId: string, priority: number): Promise<boolean>;
}

export interface CreateRunContextParams {
  run_id: string;
  mode: Mode;
  objective: string;
  workspace: string;
  brain_task_id: string;
  room_id: string;
  max_iterations?: number;
  created_at?: string;
}

const DEFAULT_MAX_ITERATIONS_BY_MODE: Record<Mode, number> = {
  [Mode.Scout]: 0,
  [Mode.Relay]: 3,
  [Mode.Swarm]: 3,
};

const VALID_TRANSITIONS: Record<RunState, ReadonlySet<RunState>> = {
  [RunState.Pending]: new Set([RunState.Running, RunState.Failed]),
  [RunState.Running]: new Set([
    RunState.Verifying,
    RunState.Fixing,
    RunState.Completed,
    RunState.Failed,
  ]),
  [RunState.Verifying]: new Set([RunState.Completed, RunState.Fixing, RunState.Failed]),
  [RunState.Fixing]: new Set([RunState.Running, RunState.Verifying, RunState.Failed]),
  [RunState.Completed]: new Set(),
  [RunState.Failed]: new Set(),
};

export function createRunContext(params: CreateRunContextParams): RunContext {
  return {
    run_id: params.run_id,
    mode: params.mode,
    objective: params.objective,
    workspace: params.workspace,
    state: RunState.Pending,
    brain_task_id: params.brain_task_id,
    room_id: params.room_id,
    iteration: 0,
    max_iterations: params.max_iterations ?? DEFAULT_MAX_ITERATIONS_BY_MODE[params.mode],
    created_at: params.created_at ?? new Date().toISOString(),
    isVerifying: false,
  };
}

export function transitionState(ctx: RunContext, newState: RunState): RunContext {
  if (ctx.state === newState) {
    return { ...ctx };
  }

  const allowed = VALID_TRANSITIONS[ctx.state];
  if (!allowed.has(newState)) {
    throw new Error(`Invalid state transition: ${ctx.state} -> ${newState}`);
  }

  return {
    ...ctx,
    state: newState,
  };
}

export async function recordStepCompletion(
  brain: BrainTaskWriter,
  ctx: RunContext,
  stepName: string,
  result: string,
): Promise<boolean> {
  if (!ctx.brain_task_id) {
    return false;
  }
  return await brain.taskComment(ctx.brain_task_id, `[step:${stepName}] completed - ${result}`);
}

export async function recordVerifyResult(
  brain: BrainTaskWriter,
  ctx: RunContext,
  passed: boolean,
  details: string,
): Promise<boolean> {
  if (!ctx.brain_task_id) {
    return false;
  }
  const status = passed ? "pass" : "fail";
  return await brain.taskComment(ctx.brain_task_id, `[verify:${status}] ${details}`);
}

export function shouldRetry(ctx: RunContext): boolean {
  return ctx.iteration < ctx.max_iterations;
}

export async function recordFailure(
  brain: BrainFailureWriter,
  ctx: RunContext,
  reason: string,
): Promise<void> {
  if (!ctx.brain_task_id) {
    return;
  }
  await brain.taskSetPriority(ctx.brain_task_id, 1);
  await brain.taskComment(ctx.brain_task_id, `[failure] ${reason}`);
}

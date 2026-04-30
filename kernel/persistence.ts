import { join } from "@std/path";

import type { RunContext } from "./types.ts";
import { Mode, RunState } from "./types.ts";

export type BrainAvailabilityStatus = "available" | "disabled" | "degraded";

export interface BrainAvailability {
  enabled: boolean;
  available: boolean;
  status: BrainAvailabilityStatus;
  brainName: string;
}

export interface PersistedCapabilities {
  updated_at: string;
  brain: BrainAvailability;
}

export interface PersistedRunState {
  schema_version: 1;
  active: boolean;
  run_id: string;
  mode: Mode;
  original_prompt: string;
  objective: string;
  workspace: string;
  state: RunState;
  iteration: number;
  max_iterations: number;
  brain_task_id: string;
  room_id: string;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  last_error?: string;
  checkpoint_summary?: string;
  persistence: PersistedCapabilities;
  /**
   * Originating session id (Claude Code session_id, etc.). Optional for
   * backwards compat — pre-existing run state files written before this
   * field was introduced won't have it. Hooks that read active state
   * with a session filter treat missing session_id as "global" (matches
   * any session) so an upgrade doesn't silently black out resurrect.
   */
  session_id?: string;
}

export interface PersistedJournalEvent {
  timestamp: string;
  kind: "start" | "update" | "checkpoint" | "complete" | "failed" | "cancelled";
  snapshot: PersistedRunState;
}

export interface PersistenceWriter {
  getConnectionStatus(): BrainAvailability;
  taskComment(taskId: string, comment: string): Promise<boolean>;
}

interface PersistOptions {
  checkpointSummary?: string;
  lastError?: string;
  finished?: boolean;
  eventKind?: PersistedJournalEvent["kind"];
}

const STATE_DIR_NAME = ".overmind/state";
const RUNS_DIR_NAME = "runs";
const JOURNALS_DIR_NAME = "journals";
const CAPABILITIES_FILE_NAME = "capabilities.json";

export function resolveStateDir(workspace: string): string {
  return join(workspace, STATE_DIR_NAME);
}

export function resolveRunsDir(workspace: string): string {
  return join(resolveStateDir(workspace), RUNS_DIR_NAME);
}

export function resolveJournalsDir(workspace: string): string {
  return join(resolveStateDir(workspace), JOURNALS_DIR_NAME);
}

export function resolveCapabilitiesPath(workspace: string): string {
  return join(resolveStateDir(workspace), CAPABILITIES_FILE_NAME);
}

export function resolveModeStatePath(workspace: string, mode: Mode): string {
  return join(resolveStateDir(workspace), `${mode}-state.json`);
}

export function resolveRunStatePath(workspace: string, runId: string): string {
  return join(resolveRunsDir(workspace), `${runId}.json`);
}

export function resolveRunJournalPath(
  workspace: string,
  runId: string,
): string {
  return join(resolveJournalsDir(workspace), `${runId}.jsonl`);
}

export async function readCapabilities(
  workspace: string,
): Promise<PersistedCapabilities | null> {
  return await readJsonFile<PersistedCapabilities>(
    resolveCapabilitiesPath(workspace),
  );
}

export async function readModeState(
  workspace: string,
  mode: Mode,
): Promise<PersistedRunState | null> {
  return await readJsonFile<PersistedRunState>(
    resolveModeStatePath(workspace, mode),
  );
}

export async function readActiveModeState(
  workspace: string,
  sessionId?: string,
): Promise<PersistedRunState | null> {
  const states = await Promise.all([
    readModeState(workspace, Mode.Scout),
    readModeState(workspace, Mode.Relay),
    readModeState(workspace, Mode.Swarm),
  ]);

  const active = states.filter((state): state is PersistedRunState =>
    Boolean(state?.active)
  );
  if (active.length === 0) {
    return null;
  }

  // Session-scoped filter: when sessionId is supplied, return only runs
  // owned by that session. Treat runs missing session_id as "global"
  // (matches any session) so pre-upgrade state files don't silently
  // black out the resurrect path. When sessionId is omitted, return
  // any active state — preserves the legacy contract for callers that
  // legitimately want any active run (CLI tooling, resurrect scripts).
  const filtered = sessionId === undefined
    ? active
    : active.filter((state) =>
      state.session_id === undefined || state.session_id === sessionId
    );
  if (filtered.length === 0) {
    return null;
  }

  filtered.sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at)
  );
  return filtered[0];
}

export class PersistenceCoordinator {
  constructor(
    private readonly workspace: string,
    private readonly brain: PersistenceWriter,
  ) {}

  async startRun(ctx: RunContext): Promise<void> {
    await this.persist(ctx, { eventKind: "start" });
  }

  async updateRun(
    ctx: RunContext,
    options: Omit<PersistOptions, "finished"> = {},
  ): Promise<void> {
    await this.persist(ctx, {
      ...options,
      eventKind: options.eventKind ??
        (options.checkpointSummary ? "checkpoint" : "update"),
    });
  }

  async completeRun(
    ctx: RunContext,
    checkpointSummary?: string,
  ): Promise<void> {
    await this.persist(ctx, {
      checkpointSummary,
      finished: true,
      eventKind: "complete",
    });
  }

  async failRun(ctx: RunContext, lastError: string): Promise<void> {
    await this.persist(ctx, {
      lastError,
      checkpointSummary: lastError,
      finished: true,
      eventKind: "failed",
    });
  }

  async cancelRun(
    ctx: RunContext,
    reason = "Run cancelled by user",
  ): Promise<void> {
    await this.persist(ctx, {
      checkpointSummary: reason,
      finished: true,
      eventKind: "cancelled",
    });
  }

  private async persist(
    ctx: RunContext,
    options: PersistOptions,
  ): Promise<void> {
    await this.ensureDirectories();

    const snapshot = this.createSnapshot(ctx, options);
    await Promise.all([
      writeJsonFile(
        resolveCapabilitiesPath(this.workspace),
        snapshot.persistence,
      ),
      writeJsonFile(resolveModeStatePath(this.workspace, ctx.mode), snapshot),
      writeJsonFile(resolveRunStatePath(this.workspace, ctx.run_id), snapshot),
      appendJournal(resolveRunJournalPath(this.workspace, ctx.run_id), {
        timestamp: snapshot.updated_at,
        kind: options.eventKind ?? "update",
        snapshot,
      }),
    ]);

    if (options.checkpointSummary && snapshot.brain_task_id) {
      await this.brain.taskComment(
        snapshot.brain_task_id,
        `[checkpoint:${
          options.eventKind ?? "update"
        }] ${options.checkpointSummary}`,
      );
    }
  }

  private createSnapshot(
    ctx: RunContext,
    options: PersistOptions,
  ): PersistedRunState {
    const now = new Date().toISOString();
    return {
      schema_version: 1,
      active: !options.finished,
      run_id: ctx.run_id,
      mode: ctx.mode,
      original_prompt: ctx.objective,
      objective: ctx.objective,
      workspace: ctx.workspace,
      state: ctx.state,
      iteration: ctx.iteration,
      max_iterations: ctx.max_iterations,
      brain_task_id: ctx.brain_task_id,
      room_id: ctx.room_id,
      started_at: ctx.created_at,
      updated_at: now,
      finished_at: options.finished ? now : undefined,
      last_error: options.lastError,
      checkpoint_summary: options.checkpointSummary,
      persistence: {
        updated_at: now,
        brain: this.brain.getConnectionStatus(),
      },
      session_id: ctx.session_id,
    };
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      Deno.mkdir(resolveStateDir(this.workspace), { recursive: true }),
      Deno.mkdir(resolveRunsDir(this.workspace), { recursive: true }),
      Deno.mkdir(resolveJournalsDir(this.workspace), { recursive: true }),
    ]);
  }
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const content = await Deno.readTextFile(path);
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await Deno.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendJournal(
  path: string,
  event: PersistedJournalEvent,
): Promise<void> {
  await Deno.writeTextFile(path, `${JSON.stringify(event)}\n`, {
    append: true,
    create: true,
  });
}

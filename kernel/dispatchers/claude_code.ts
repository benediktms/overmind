/**
 * ClaudeCodeDispatcher — spawns Claude Code subprocesses to fulfil
 * `AgentDispatchRequest`s. Each spawn becomes a worker that joins the
 * neural_link room as `participantId`, drains its inbox, executes the
 * kickoff, and posts a `handoff` back to the lead before exiting.
 *
 * Fire-and-forget: `dispatch()` returns once the subprocess is spawned,
 * not when it exits. The kernel's mode executor watches the room for
 * handoffs — process exit is incidental.
 */

import { join } from "@std/path";
import {
  type AgentDispatcher,
  type AgentDispatchRequest,
  type AgentDispatchResult,
} from "../agent_dispatcher.ts";
import { buildSubprocessBootstrap } from "./bootstrap_prompt.ts";

const DEFAULT_CLAUDE_BINARY = "claude";
const DEFAULT_LOG_DIR = ".overmind/state/runs";

/**
 * Environment variable name prefixes that are safe to forward to worker
 * subprocesses. Everything else is stripped to avoid leaking secrets.
 */
const ALLOWED_ENV_PREFIXES = ["OVERMIND_", "DENO_", "ANTHROPIC_"];

/**
 * Explicit env var names (beyond the prefix list) that workers need for basic
 * OS functionality.
 */
const ALLOWED_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TERM",
  "SHELL",
  "TMPDIR",
]);

/**
 * Return a copy of `raw` retaining only the keys whose name starts with an
 * allowed prefix or is in the explicit allowlist.
 */
function filterEnv(
  raw: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      ALLOWED_ENV_KEYS.has(key) ||
      ALLOWED_ENV_PREFIXES.some((p) => key.startsWith(p))
    ) {
      out[key] = value;
    }
  }
  return out;
}

export interface ClaudeCodeDispatcherOptions {
  /** Path to the Claude Code binary. Defaults to "claude" (PATH lookup). */
  binaryPath?: string;
  /**
   * Directory under which per-agent log files are written. The dispatcher
   * creates `${logsDir}/${runId}/${agentId}.log` for each spawn. Default:
   * `.overmind/state/runs` (relative to the spawning workspace). Pass an
   * absolute path to redirect.
   */
  logsDir?: string;
  /** Override the spawn primitive — used by tests. */
  spawn?: (cmd: string, options: Deno.CommandOptions) => Deno.ChildProcess;
  /**
   * Milliseconds to wait after SIGTERM before escalating to SIGKILL.
   * Defaults to 5000. Tests may pass a shorter value.
   */
  killGraceMs?: number;
}

interface InflightAgent {
  runId: string;
  child: Deno.ChildProcess;
  /** True once cancelRun has been called for this entry. */
  cancelled: boolean;
  /** Handle for the SIGKILL escalation timer; cleared on clean exit. */
  killTimer?: number;
}

export class ClaudeCodeDispatcher implements AgentDispatcher {
  private readonly binaryPath: string;
  private readonly logsDir: string;
  private readonly killGraceMs: number;
  private readonly spawn: (
    cmd: string,
    options: Deno.CommandOptions,
  ) => Deno.ChildProcess;
  private readonly inflight = new Map<string, InflightAgent>();
  private available: boolean | null = null;
  /** Filtered snapshot of process env taken at construction time. */
  private readonly baseEnv: Record<string, string>;

  constructor(options: ClaudeCodeDispatcherOptions = {}) {
    this.binaryPath = options.binaryPath ?? DEFAULT_CLAUDE_BINARY;
    this.logsDir = options.logsDir ?? DEFAULT_LOG_DIR;
    this.killGraceMs = options.killGraceMs ?? 5000;
    this.spawn = options.spawn ??
      ((cmd, opts) => new Deno.Command(cmd, opts).spawn());
    this.baseEnv = filterEnv(Deno.env.toObject());
  }

  /**
   * Probe the binary by running `<bin> --version`. Cached after first call.
   * Synchronous downstream callers must `await` once via `probeAvailability`.
   */
  isAvailable(): boolean {
    return this.available ?? false;
  }

  /**
   * One-shot async availability check. Run once at startup before the
   * kernel begins issuing `dispatch()` calls.
   */
  async probeAvailability(): Promise<boolean> {
    try {
      const probe = new Deno.Command(this.binaryPath, {
        args: ["--version"],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      });
      const { code } = await probe.output();
      this.available = code === 0;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  async dispatch(
    request: AgentDispatchRequest,
  ): Promise<AgentDispatchResult> {
    if (!this.isAvailable()) {
      return {
        launched: false,
        error:
          `claude binary not available (path=${this.binaryPath}); did probeAvailability() succeed?`,
      };
    }

    const runId = extractRunId(request.agentId);
    const logBase = await this.openLogBase(request, runId);
    const env = buildEnv(this.baseEnv, request, runId);
    const args = buildArgs(request);
    const prompt = buildSubprocessBootstrap(request);

    let stdoutFile: Deno.FsFile | null = null;
    let stderrFile: Deno.FsFile | null = null;
    try {
      stdoutFile = await Deno.open(`${logBase}.stdout.log`, {
        write: true,
        create: true,
        truncate: true,
      });
      stderrFile = await Deno.open(`${logBase}.stderr.log`, {
        write: true,
        create: true,
        truncate: true,
      });
    } catch (err) {
      try {
        stdoutFile?.close();
      } catch { /* ignore */ }
      const error = err instanceof Error ? err.message : String(err);
      return {
        launched: false,
        error:
          `failed to open log file at ${logBase}.{stdout,stderr}.log: ${error}`,
      };
    }

    let child: Deno.ChildProcess;
    try {
      child = this.spawn(this.binaryPath, {
        args,
        cwd: request.workspace,
        env,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      });
    } catch (err) {
      try {
        stdoutFile.close();
      } catch { /* ignore */ }
      try {
        stderrFile.close();
      } catch { /* ignore */ }
      const error = err instanceof Error ? err.message : String(err);
      return { launched: false, error: `spawn failed: ${error}` };
    }

    // Feed the prompt via stdin so it does not appear in process argv (ps).
    try {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(prompt));
      await writer.close();
    } catch {
      // stdin write failure is non-fatal — the child may have already exited
      // or the fake child in tests may not buffer stdin.
    }

    const agent: InflightAgent = {
      runId,
      child,
      cancelled: false,
    };
    this.inflight.set(request.agentId, agent);

    const stdoutCapture = stdoutFile;
    const stderrCapture = stderrFile;
    pipeToFiles(child, stdoutCapture, stderrCapture, () => {
      // Clear the SIGKILL timer: a clean exit means escalation is unneeded.
      if (agent.killTimer !== undefined) {
        clearTimeout(agent.killTimer);
        agent.killTimer = undefined;
      }
      this.inflight.delete(request.agentId);
    });

    return { launched: true };
  }

  /**
   * Send SIGTERM to every in-flight child whose agentId belongs to `runId`,
   * then schedule a SIGKILL escalation after `killGraceMs` if the child has
   * not exited by then (tracked via pipeToFiles' onExit callback).
   *
   * Returns the number of SIGTERM signals sent. Idempotent: a second call for
   * the same runId is a no-op (children already marked cancelled).
   */
  cancelRun(runId: string): number {
    let count = 0;
    for (const [_agentId, agent] of this.inflight.entries()) {
      if (agent.runId !== runId) continue;
      if (agent.cancelled) {
        // Already cancelled; still count it so callers get a stable return.
        count++;
        continue;
      }
      agent.cancelled = true;
      try {
        agent.child.kill("SIGTERM");
        count++;
      } catch {
        // Child may have already exited; ignore.
      }
      // Schedule SIGKILL escalation. The timer handle is stored so pipeToFiles
      // can clear it when the child exits cleanly after SIGTERM.
      // TODO ovr-b65: dedicated test for SIGKILL grace in CI
      agent.killTimer = setTimeout(() => {
        try {
          agent.child.kill("SIGKILL");
        } catch {
          // Child already gone — this is the happy path.
        }
      }, this.killGraceMs);
    }
    return count;
  }

  /**
   * Returns the agentIds currently tracked as in-flight. Test-only.
   */
  getInflight(): string[] {
    return Array.from(this.inflight.keys());
  }

  private async openLogBase(
    request: AgentDispatchRequest,
    runId: string,
  ): Promise<string> {
    const baseDir = isAbsolute(this.logsDir)
      ? this.logsDir
      : join(request.workspace, this.logsDir);
    const runDir = join(baseDir, runId);
    await Deno.mkdir(runDir, { recursive: true });
    return join(runDir, request.agentId);
  }
}

/**
 * Extract the run_id from an agentId. The kernel encodes agentIds as
 * `${runId}-${suffix}` (see `kernel/modes/scout.ts:164` and
 * `kernel/modes/swarm.ts:429`). The runId itself starts with `run-` and
 * contains a UUID, so we anchor on that prefix.
 */
function extractRunId(agentId: string): string {
  const match = agentId.match(
    /^(run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
  );
  if (!match) {
    return agentId;
  }
  return match[1];
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/");
}

function buildEnv(
  base: Record<string, string>,
  request: AgentDispatchRequest,
  runId: string,
): Record<string, string> {
  return {
    ...base,
    OVERMIND_RUN_ID: runId,
    OVERMIND_AGENT_ID: request.agentId,
    OVERMIND_ROLE: request.role,
    OVERMIND_ROOM_ID: request.roomId,
    OVERMIND_PARTICIPANT_ID: request.participantId,
  };
}

/**
 * Build the CLI args for the worker subprocess. The prompt is fed via stdin
 * (see dispatch()) so that it does not appear in process argv / `ps` output.
 */
function buildArgs(request: AgentDispatchRequest): string[] {
  return [
    "--print",
    "-",
    "--permission-mode",
    "bypassPermissions",
    "--no-session-persistence",
    "--add-dir",
    request.workspace,
  ];
}

async function pipeToFiles(
  child: Deno.ChildProcess,
  stdoutFile: Deno.FsFile,
  stderrFile: Deno.FsFile,
  onExit: () => void,
): Promise<void> {
  // Two files because a WritableStream can only have one acquired writer at
  // a time — interleaving stdout+stderr into one file would require a
  // TransformStream merge, which is more code than it's worth here. Keep
  // them separate; readers can `cat` them in either order.
  const stdoutCopy = copyStream(child.stdout, stdoutFile.writable);
  const stderrCopy = copyStream(child.stderr, stderrFile.writable);
  try {
    await Promise.allSettled([stdoutCopy, stderrCopy, child.status]);
  } finally {
    try {
      stdoutFile.close();
    } catch { /* already closed */ }
    try {
      stderrFile.close();
    } catch { /* already closed */ }
    // onExit is the sole deleter from the inflight map. Wrap it so that a
    // close() exception above cannot prevent the entry from being removed.
    try {
      onExit();
    } catch { /* ignore */ }
  }
}

async function copyStream(
  source: ReadableStream<Uint8Array>,
  sink: WritableStream<Uint8Array>,
): Promise<void> {
  try {
    await source.pipeTo(sink);
  } catch {
    // Ignore — child may have closed early. The file will still close in
    // the caller's `finally`.
  }
}

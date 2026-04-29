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

const DEFAULT_CLAUDE_BINARY = "claude";
const DEFAULT_LOG_DIR = ".overmind/state/runs";

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
}

interface InflightAgent {
  runId: string;
  child: Deno.ChildProcess;
}

export class ClaudeCodeDispatcher implements AgentDispatcher {
  private readonly binaryPath: string;
  private readonly logsDir: string;
  private readonly spawn: (
    cmd: string,
    options: Deno.CommandOptions,
  ) => Deno.ChildProcess;
  private readonly inflight = new Map<string, InflightAgent>();
  private available: boolean | null = null;

  constructor(options: ClaudeCodeDispatcherOptions = {}) {
    this.binaryPath = options.binaryPath ?? DEFAULT_CLAUDE_BINARY;
    this.logsDir = options.logsDir ?? DEFAULT_LOG_DIR;
    this.spawn = options.spawn ??
      ((cmd, opts) => new Deno.Command(cmd, opts).spawn());
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
    const env = buildEnv(request, runId);
    const args = buildArgs(request);

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
        error: `failed to open log file at ${logBase}.{stdout,stderr}.log: ${error}`,
      };
    }

    let child: Deno.ChildProcess;
    try {
      child = this.spawn(this.binaryPath, {
        args,
        cwd: request.workspace,
        env,
        stdin: "null",
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

    this.inflight.set(request.agentId, { runId, child });

    const stdoutCapture = stdoutFile;
    const stderrCapture = stderrFile;
    pipeToFiles(child, stdoutCapture, stderrCapture, () => {
      this.inflight.delete(request.agentId);
    });

    return { launched: true };
  }

  /**
   * Send SIGTERM to every in-flight child whose agentId belongs to `runId`.
   * Best-effort — children may have already exited. Returns the number of
   * signals sent (not the number of children that successfully exit).
   */
  cancelRun(runId: string): number {
    let count = 0;
    for (const [agentId, agent] of this.inflight.entries()) {
      if (agent.runId !== runId) continue;
      try {
        agent.child.kill("SIGTERM");
        count++;
      } catch {
        // Child may have already exited; ignore.
      }
      this.inflight.delete(agentId);
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
  request: AgentDispatchRequest,
  runId: string,
): Record<string, string> {
  return {
    ...Deno.env.toObject(),
    OVERMIND_RUN_ID: runId,
    OVERMIND_AGENT_ID: request.agentId,
    OVERMIND_ROLE: request.role,
    OVERMIND_ROOM_ID: request.roomId,
    OVERMIND_PARTICIPANT_ID: request.participantId,
  };
}

function buildArgs(request: AgentDispatchRequest): string[] {
  const prompt = buildPrompt(request);
  return [
    "--print",
    prompt,
    "--permission-mode",
    "bypassPermissions",
    "--no-session-persistence",
    "--add-dir",
    request.workspace,
  ];
}

/**
 * The bootstrap prompt the spawned worker sees. It tells the worker who it
 * is, where to find its kickoff, and how to report back. Skill files in
 * `cli/claudecode-plugin/skills/` provide the per-role behavior; the worker
 * is expected to invoke its role skill (`/{role}`) on top of this.
 */
function buildPrompt(request: AgentDispatchRequest): string {
  return `You are an Overmind worker spawned by the kernel as agent_id=${request.agentId}.

Run context (also available via env vars OVERMIND_*):
- run_id: ${extractRunId(request.agentId)}
- role: ${request.role}
- room_id: ${request.roomId}
- participant_id: ${request.participantId}
- workspace: ${request.workspace}

Bootstrap protocol — execute these steps in order:

1. Join the room: call mcp__neural_link__room_join with
   room_id=${request.roomId}, participant_id=${request.participantId},
   display_name=${JSON.stringify(`${request.role} (${request.participantId})`)},
   role=member.
2. Read your kickoff message: call mcp__neural_link__inbox_read with
   room_id=${request.roomId}, participant_id=${request.participantId}.
   Your kickoff is the first message addressed to you.
3. Execute the kickoff. Invoke the /${request.role} skill if available; act
   as a ${request.role} otherwise. Original objective: ${request.prompt}.
4. Post a handoff back to the lead: call mcp__neural_link__message_send
   with room_id=${request.roomId}, from=${request.participantId},
   kind=handoff, summary=<short summary>, body=<full findings>.
5. Leave the room: call mcp__neural_link__room_leave with the same
   room_id and participant_id.
6. Exit. Do not loop, do not retry, do not start new investigations.

If any step fails, post a handoff with kind=handoff, summary="error: <reason>",
body=<details> before exiting. Never silently exit.`;
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
    onExit();
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

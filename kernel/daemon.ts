import { OvermindError } from "./errors.ts";
import { EventType, Mode } from "./types.ts";
import type {
  CancelRequest,
  DispatcherMode,
  DrainDispatchesRequest,
  ModeRequest,
  SocketRequest,
  SocketResponse,
} from "./types.ts";
import { fromFileUrl } from "@std/path";
import { Kernel } from "./kernel.ts";
import { ConfigLoader } from "./config.ts";
import type { AgentDispatcher } from "./agent_dispatcher.ts";
import { ClaudeCodeDispatcher } from "./dispatchers/claude_code.ts";
import { ClientSideDispatcher } from "./dispatchers/client_side.ts";
import { LockRegistry } from "./locks.ts";
import { OvermindHttpServer } from "./http.ts";

interface OvermindDaemonOptions {
  baseDir?: string;
  kernel?: Kernel;
  httpPort?: number;
  httpHostname?: string;
  enableHttp?: boolean;
}

interface ParsedRequest {
  request: SocketRequest | null;
  error: string | null;
}

const SOCKET_FILE_NAME = "daemon.sock";
const PID_FILE_NAME = "daemon.pid";
const LOCK_FILE_NAME = "daemon.lock";
const LOCK_JOURNAL_FILE_NAME = "locks.jsonl";
const HTTP_PORT_ENV_VAR = "OVERMIND_KERNEL_HTTP_PORT";
const HTTP_BIND_ENV_VAR = "OVERMIND_KERNEL_HTTP_BIND";
const HTTP_DEFAULT_PORT = 8080;
const HTTP_DEFAULT_BIND = "127.0.0.1";
const STARTUP_RETRY_ATTEMPTS = 5;
const STARTUP_RETRY_INTERVAL_MS = 200;
// Daemon-readiness probe gets a larger retry budget than the socket-connect
// retry: a freshly spawned daemon has to boot Deno, load config, instantiate
// the kernel, and connect adapters before its socket is responsive. 1s
// (the previous shared budget) was tight enough to manifest as flaky
// `Daemon socket timeout` errors in agent transcripts. 6s covers warm
// hosts; cold hosts can override via env.
const READINESS_RETRY_ATTEMPTS = 30;
const READINESS_RETRY_INTERVAL_MS = 200;
// Per-attempt cap on a single socket round-trip. Without this, a half-open
// connection (daemon accepted the connect but never wrote a response — e.g.
// stuck inside executeMode's synchronous prefix) hangs the client forever
// because Deno.Conn.read has no inherent timeout. Crossed this and the conn
// is force-closed, the read throws BadResource, and the retry loop kicks in.
//
// Tunable via `OVERMIND_SOCKET_TIMEOUT_MS` env var: 5s is the lower-bound
// default that's fine for steady-state, but the first request after auto-
// spawn can take longer (Deno cold-start + adapter wiring). Bump to 15s in
// CI/slow-host scenarios; floor at 1s to keep it sane.
const DEFAULT_SOCKET_REQUEST_TIMEOUT_MS = 15_000;
function readSocketRequestTimeoutMs(): number {
  const raw = Deno.env.get("OVERMIND_SOCKET_TIMEOUT_MS");
  if (!raw) return DEFAULT_SOCKET_REQUEST_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    return DEFAULT_SOCKET_REQUEST_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}
const SOCKET_REQUEST_TIMEOUT_MS = readSocketRequestTimeoutMs();
const managedDaemonChildren = new Map<string, Deno.ChildProcess>();

export async function ensureDaemonRunning(baseDir?: string): Promise<void> {
  const resolvedBaseDir = resolveBaseDir(baseDir);
  const socketPath = `${resolvedBaseDir}/${SOCKET_FILE_NAME}`;
  const pidPath = `${resolvedBaseDir}/${PID_FILE_NAME}`;
  const lockPath = `${resolvedBaseDir}/${LOCK_FILE_NAME}`;

  await Deno.mkdir(resolvedBaseDir, { recursive: true });

  if (await isDaemonAvailable(pidPath, socketPath)) {
    return;
  }

  let lockHandle: Deno.FsFile | null = null;
  for (let attempt = 1; attempt <= STARTUP_RETRY_ATTEMPTS; attempt += 1) {
    if (await isDaemonAvailable(pidPath, socketPath)) {
      return;
    }

    try {
      lockHandle = await Deno.open(lockPath, { write: true, createNew: true });
      break;
    } catch (err) {
      if (!(err instanceof Deno.errors.AlreadyExists)) {
        throw err;
      }
      await sleep(STARTUP_RETRY_INTERVAL_MS);
    }
  }

  if (!lockHandle) {
    if (await isDaemonAvailable(pidPath, socketPath)) {
      return;
    }
    throw new OvermindError("Timed out waiting for daemon startup lock");
  }

  try {
    if (await isDaemonAvailable(pidPath, socketPath)) {
      return;
    }

    startDaemonProcess(resolvedBaseDir);
    await waitForSocketReady(
      socketPath,
      READINESS_RETRY_ATTEMPTS,
      READINESS_RETRY_INTERVAL_MS,
    );
  } finally {
    lockHandle.close();
    await removeIfExists(lockPath);
  }
}

export async function sendToSocket(
  request: SocketRequest,
  socketPath = `${resolveBaseDir()}/${SOCKET_FILE_NAME}`,
  callerSignal?: AbortSignal,
  requestTimeoutMs: number = SOCKET_REQUEST_TIMEOUT_MS,
): Promise<SocketResponse> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= STARTUP_RETRY_ATTEMPTS; attempt += 1) {
    if (callerSignal?.aborted) {
      throw new OvermindError("sendToSocket aborted by caller");
    }
    let conn: Deno.Conn | null = null;
    let connected = false;
    let timer: number | null = null;
    let timedOut = false;
    const closeConn = () => {
      try {
        conn?.close();
      } catch {
        // Already closed (or never opened) — idempotent close.
      }
    };
    try {
      conn = await Deno.connect({ transport: "unix", path: socketPath });
      connected = true;
      timer = setTimeout(() => {
        timedOut = true;
        closeConn();
      }, requestTimeoutMs);
      callerSignal?.addEventListener("abort", closeConn, { once: true });

      const body = JSON.stringify(request) + "\n";
      await conn.write(new TextEncoder().encode(body));

      const responseRaw = await readNdjsonPayload(conn);
      const payload = JSON.parse(responseRaw) as SocketResponse;
      if (!isSocketResponse(payload)) {
        throw new OvermindError("Malformed daemon response");
      }

      return payload;
    } catch (err) {
      lastError = timedOut
        ? new OvermindError(
          `Daemon did not respond within ${requestTimeoutMs}ms`,
        )
        : err;
      // Pre-connect failures (ENOENT, ECONNREFUSED) are transient startup
      // races and warrant retry. Post-connect failures (timeout, malformed
      // response) signal a daemon-side problem that another attempt won't
      // fix — surface them immediately instead of burning the full retry
      // budget.
      if (connected) break;
      if (
        attempt < STARTUP_RETRY_ATTEMPTS && !callerSignal?.aborted
      ) {
        await sleep(STARTUP_RETRY_INTERVAL_MS);
        continue;
      }
    } finally {
      if (timer !== null) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", closeConn);
      closeConn();
    }
  }

  throw new OvermindError(
    `Failed to communicate with daemon socket at ${socketPath}: ${
      String(lastError)
    }`,
  );
}

export class OvermindDaemon {
  private readonly baseDir: string;
  private readonly socketPath: string;
  private readonly pidPath: string;
  private readonly lockJournalPath: string;
  private readonly kernel: Kernel | null;
  private readonly httpPort: number;
  private readonly httpHostname: string;
  private readonly enableHttp: boolean;

  private listener: Deno.Listener | null = null;
  private acceptLoopPromise: Promise<void> | null = null;
  private running = false;
  private signalHandlersRegistered = false;
  private lockRegistry: LockRegistry | null = null;
  private httpServer: OvermindHttpServer | null = null;

  private readonly sigintHandler = () => {
    void this.shutdown().finally(() => Deno.exit(0));
  };
  private readonly sigtermHandler = () => {
    void this.shutdown().finally(() => Deno.exit(0));
  };

  constructor(options: OvermindDaemonOptions = {}) {
    const defaultBaseDir = `${Deno.env.get("HOME") ?? "."}/.overmind`;
    this.baseDir = options.baseDir ?? defaultBaseDir;
    this.socketPath = `${this.baseDir}/${SOCKET_FILE_NAME}`;
    this.pidPath = `${this.baseDir}/${PID_FILE_NAME}`;
    this.lockJournalPath = `${this.baseDir}/${LOCK_JOURNAL_FILE_NAME}`;
    this.kernel = options.kernel ?? null;
    this.httpPort = options.httpPort ?? readPortFromEnv() ?? HTTP_DEFAULT_PORT;
    this.httpHostname = options.httpHostname ??
      Deno.env.get(HTTP_BIND_ENV_VAR) ?? HTTP_DEFAULT_BIND;
    // Default the HTTP listener on only when a kernel is wired in. The
    // script-mode subprocess (started by ensureDaemonRunning) has no kernel
    // today, so locks would never be auto-released — the listener would just
    // burn port 8080 for nothing.
    this.enableHttp = options.enableHttp ?? this.kernel !== null;
  }

  async start(): Promise<void> {
    if (this.running) return;

    await Deno.mkdir(this.baseDir, { recursive: true });

    await this.cleanupStalePidFile();
    await this.cleanupStaleSocketFile();

    this.listener = Deno.listen({ transport: "unix", path: this.socketPath });
    await Deno.writeTextFile(this.pidPath, `${Deno.pid}\n`);

    this.running = true;
    this.registerSignalHandlers();
    this.acceptLoopPromise = this.acceptLoop();

    if (this.enableHttp) {
      await this.startHttp();
    }
  }

  async shutdown(): Promise<void> {
    if (!this.running && !this.listener && !this.httpServer) {
      return;
    }

    this.running = false;
    this.unregisterSignalHandlers();

    // HTTP shutdown first so in-flight requests don't race the lock state.
    if (this.httpServer) {
      try {
        await this.httpServer.shutdown();
      } catch (err) {
        console.error("HTTP server shutdown error:", err);
      }
      this.httpServer = null;
    }
    this.lockRegistry = null;

    if (this.listener) {
      this.listener.close();
      this.listener = null;
    }

    if (this.acceptLoopPromise) {
      await this.acceptLoopPromise;
      this.acceptLoopPromise = null;
    }

    await removeIfExists(this.pidPath);
    await removeIfExists(this.socketPath);
  }

  getLockRegistry(): LockRegistry | null {
    return this.lockRegistry;
  }

  getHttpPort(): number {
    return this.httpServer?.port() ?? 0;
  }

  private async startHttp(): Promise<void> {
    // HTTP failures must not abort the daemon — the Unix socket remains the
    // source of truth for daemon health. We log and continue.
    try {
      const registry = new LockRegistry(this.lockJournalPath);
      await registry.load();
      const kernel = this.kernel;
      // Wire /event posts onto the kernel's EventBus so hook deliveries land
      // somewhere observable. Without a kernel (script-mode subprocess path)
      // events drop silently — the existing fail-open contract on the hook
      // side already handles that gracefully.
      //
      // We emit on the bus directly rather than via Kernel.emit, deliberately
      // bypassing the TriggerEngine. External (attacker-controlled) hook
      // payloads must never reach adapter actions like brain_task_create.
      const eventSink = kernel
        ? (body: unknown) => {
          kernel.getEventBus().emit({
            type: EventType.ExternalHookEvent,
            timestamp: new Date(),
            payload: { body },
          });
        }
        : undefined;
      const server = new OvermindHttpServer({
        registry,
        port: this.httpPort,
        hostname: this.httpHostname,
        eventSink,
      });
      server.start();
      this.lockRegistry = registry;
      this.httpServer = server;
    } catch (err) {
      console.error("Failed to start kernel HTTP listener:", err);
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  private registerSignalHandlers(): void {
    if (this.signalHandlersRegistered) return;

    Deno.addSignalListener("SIGINT", this.sigintHandler);
    Deno.addSignalListener("SIGTERM", this.sigtermHandler);
    this.signalHandlersRegistered = true;
  }

  private unregisterSignalHandlers(): void {
    if (!this.signalHandlersRegistered) return;

    Deno.removeSignalListener("SIGINT", this.sigintHandler);
    Deno.removeSignalListener("SIGTERM", this.sigtermHandler);
    this.signalHandlersRegistered = false;
  }

  private async acceptLoop(): Promise<void> {
    if (!this.listener) return;

    while (this.running && this.listener) {
      let conn: Deno.Conn | null = null;
      try {
        conn = await this.listener.accept();
        void this.handleConnection(conn);
      } catch (err) {
        if (
          err instanceof Deno.errors.BadResource ||
          err instanceof Deno.errors.Interrupted
        ) {
          break;
        }
        if (conn) conn.close();
      }
    }
  }

  private async handleConnection(conn: Deno.Conn): Promise<void> {
    try {
      const requestRaw = await this.readRequestPayload(conn);
      // Probe-and-close pattern: liveness checks (isDaemonAvailable,
      // isDaemonReachable, the startup readiness probe in
      // ensureDaemonRunning) all connect and may close immediately. An
      // empty payload from a closed peer means "are you up?" — answering
      // would just BrokenPipe-rejection on the write, which surfaces as an
      // uncaught error because acceptLoop fires this method as `void`.
      // Bail before attempting to respond.
      if (requestRaw.length === 0) {
        return;
      }
      const parsed = this.parseRequest(requestRaw);

      let responseBody: string;
      if (parsed.request) {
        if (parsed.request.type === "drain_dispatches") {
          const req = parsed.request as DrainDispatchesRequest;
          // Drain semantics apply only to the client_side dispatcher —
          // subprocess spawns inline and has no queue to drain. Querying
          // the default via `getDispatcher()` was a regression after the
          // dispatcher registry landed: when both dispatchers exist the
          // default resolves to subprocess (when `claude` is on PATH),
          // and subprocess has no `drainPending`, so callers received
          // an empty list even when the run had legitimately queued
          // dispatches via client_side. Always query client_side here.
          const dispatcher = this.kernel?.getDispatcher?.("client_side");
          const dispatches = dispatcher?.drainPending?.(req.run_id) ?? [];
          responseBody = JSON.stringify({
            status: "accepted",
            run_id: req.run_id,
            error: null,
            dispatches,
          }) + "\n";
        } else if (parsed.request.type === "cancel_request") {
          const req = parsed.request as CancelRequest;
          let response: SocketResponse;
          if (this.kernel) {
            const cancelled = this.kernel.cancelRun(req.run_id);
            response = cancelled
              ? { status: "accepted", run_id: req.run_id, error: null }
              : { status: "error", run_id: req.run_id, error: "Run not found" };
          } else {
            response = {
              status: "error",
              run_id: req.run_id,
              error: "No kernel available",
            };
          }
          responseBody = JSON.stringify(response) + "\n";
        } else {
          const req = parsed.request as ModeRequest;
          // Kernel-presence guard. A daemon process without a kernel
          // (misconfigured embed, test harness, or future script-mode
          // that hasn't wired runDaemon) cannot actually execute the
          // request. Without this guard the response below would set
          // status: "accepted" while the inner `if (this.kernel)`
          // silently skipped executeMode — the exact silent-failure
          // mode that this whole change exists to eliminate (oculus,
          // team review).
          if (!this.kernel) {
            const response: SocketResponse = {
              status: "error",
              run_id: req.run_id,
              error:
                "kernel not available in this daemon process (no executor wired); " +
                "the request would have been accepted but no work would run.",
            };
            responseBody = JSON.stringify(response) + "\n";
          } else if (
            // Loud-fail policy: if the caller asked for a dispatcher mode
            // the daemon doesn't have, reject the request synchronously.
            // The alternative is silent failure — `ClientSideDispatcher.
            // dispatch` returns `launched: true` and queues, but the
            // verify path then times out at 180s with no handoffs. That
            // was the user-visible "delegation succeeded but nothing
            // ran" symptom this fix exists to eliminate.
            req.dispatcher_mode &&
            !this.kernel.hasDispatcher(req.dispatcher_mode)
          ) {
            const response: SocketResponse = {
              status: "error",
              run_id: req.run_id,
              error:
                `dispatcher_mode '${req.dispatcher_mode}' is not available on this daemon ` +
                `(install/configure the matching dispatcher, or omit dispatcher_mode to use the default).`,
            };
            responseBody = JSON.stringify(response) + "\n";
          } else {
            const response: SocketResponse = {
              status: "accepted",
              run_id: req.run_id,
              error: null,
            };
            // Fire-and-forget mode execution. dispatcher_mode and
            // session_id thread through executeMode so the kernel
            // routes spawn requests through the matching dispatcher and
            // persists the originating session for hook scoping.
            this.kernel.executeMode(
              req.mode,
              req.objective,
              req.workspace,
              req.run_id,
              {
                dispatcherMode: req.dispatcher_mode,
                sessionId: req.session_id,
              },
            ).catch((err) => {
              console.error(`Mode execution error for ${req.run_id}:`, err);
            });
            responseBody = JSON.stringify(response) + "\n";
          }
        }
      } else {
        const response: SocketResponse = {
          status: "error",
          run_id: "",
          error: parsed.error ?? "Invalid request",
        };
        responseBody = JSON.stringify(response) + "\n";
      }

      await conn.write(new TextEncoder().encode(responseBody));
    } finally {
      conn.close();
    }
  }

  private async readRequestPayload(conn: Deno.Conn): Promise<string> {
    return await readNdjsonPayload(conn);
  }

  private parseRequest(raw: string): ParsedRequest {
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return { request: null, error: "Malformed request: invalid JSON" };
    }

    if (this.isCancelRequest(payload)) {
      return { request: payload, error: null };
    }

    if (this.isDrainDispatchesRequest(payload)) {
      return { request: payload, error: null };
    }

    if (!this.isModeRequest(payload)) {
      return {
        request: null,
        error: "Invalid request: expected mode_request contract",
      };
    }

    return { request: payload, error: null };
  }

  private isCancelRequest(payload: unknown): payload is CancelRequest {
    if (!payload || typeof payload !== "object") {
      return false;
    }

    const value = payload as Record<string, unknown>;
    return value.type === "cancel_request" &&
      typeof value.run_id === "string" && value.run_id.length > 0;
  }

  private isDrainDispatchesRequest(
    payload: unknown,
  ): payload is DrainDispatchesRequest {
    if (!payload || typeof payload !== "object") {
      return false;
    }
    const value = payload as Record<string, unknown>;
    return value.type === "drain_dispatches" &&
      typeof value.run_id === "string" && value.run_id.length > 0;
  }

  private isModeRequest(payload: unknown): payload is ModeRequest {
    if (!payload || typeof payload !== "object") {
      return false;
    }

    const value = payload as Record<string, unknown>;
    if (
      value.dispatcher_mode !== undefined &&
      value.dispatcher_mode !== "subprocess" &&
      value.dispatcher_mode !== "client_side"
    ) {
      return false;
    }
    if (
      value.session_id !== undefined &&
      typeof value.session_id !== "string"
    ) {
      return false;
    }
    return value.type === "mode_request" &&
      typeof value.run_id === "string" && value.run_id.length > 0 &&
      typeof value.mode === "string" &&
      [Mode.Scout, Mode.Relay, Mode.Swarm].includes(value.mode as Mode) &&
      typeof value.objective === "string" &&
      typeof value.workspace === "string";
  }

  private async cleanupStalePidFile(): Promise<void> {
    if (!(await this.pathExists(this.pidPath))) return;

    const pidRaw = (await Deno.readTextFile(this.pidPath)).trim();
    const pid = Number(pidRaw);
    if (!Number.isInteger(pid) || pid <= 0) {
      await removeIfExists(this.pidPath);
      return;
    }

    const exists = processExists(pid);
    if (!exists) {
      await removeIfExists(this.pidPath);
      return;
    }

    const isDaemonProcess = await this.isLikelyOvermindDaemonProcess(pid);
    if (isDaemonProcess) {
      throw new OvermindError(`Daemon already running with PID ${pid}`);
    }

    await removeIfExists(this.pidPath);
  }

  private async cleanupStaleSocketFile(): Promise<void> {
    if (!(await this.pathExists(this.socketPath))) return;

    let connected = false;
    try {
      const conn = await Deno.connect({
        transport: "unix",
        path: this.socketPath,
      });
      connected = true;
      conn.close();
    } catch {
      connected = false;
    }

    if (connected) {
      throw new OvermindError("Daemon socket is already active");
    }

    await removeIfExists(this.socketPath);
  }

  private async isLikelyOvermindDaemonProcess(pid: number): Promise<boolean> {
    try {
      const command = new Deno.Command("ps", {
        args: ["-p", String(pid), "-o", "command="],
        stdout: "piped",
        stderr: "null",
      });
      const output = await command.output();
      if (!output.success) return false;

      const processCommand = new TextDecoder().decode(output.stdout).trim();
      return processCommand.includes("kernel/daemon.ts") ||
        processCommand.includes("overmind daemon");
    } catch {
      return false;
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await Deno.stat(path);
      return true;
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        return false;
      }
      throw err;
    }
  }
}

function resolveBaseDir(baseDir?: string): string {
  const defaultBaseDir = `${Deno.env.get("HOME") ?? "."}/.overmind`;
  return baseDir ?? defaultBaseDir;
}

function processExists(pid: number): boolean {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.PermissionDenied) {
      return true;
    }
    if (err instanceof Deno.errors.NotFound) {
      return false;
    }
    return false;
  }
}

async function isDaemonAvailable(
  pidPath: string,
  socketPath: string,
): Promise<boolean> {
  let pid: number | null = null;
  try {
    const pidRaw = (await Deno.readTextFile(pidPath)).trim();
    const parsed = Number(pidRaw);
    pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }

  if (!pid || !processExists(pid)) {
    return false;
  }

  try {
    const conn = await Deno.connect({ transport: "unix", path: socketPath });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Public wrapper around `isDaemonAvailable` that takes a baseDir. Returns
 * true only when the PID file points at a live process AND the Unix socket
 * accepts a connection — i.e. when `overmind_delegate` would actually be
 * able to reach the daemon. Use this for status reporting; the HTTP
 * `/health` endpoint is a separate, best-effort surface and can be up while
 * the socket is down (or vice versa).
 */
export async function isDaemonReachable(baseDir?: string): Promise<boolean> {
  const resolved = resolveBaseDir(baseDir);
  return await isDaemonAvailable(
    `${resolved}/${PID_FILE_NAME}`,
    `${resolved}/${SOCKET_FILE_NAME}`,
  );
}

/**
 * Decide how to invoke the daemon process given the running executable.
 *
 * Dual-use: `kernel/daemon.ts` runs both as a script (during dev, via
 * `deno run kernel/daemon.ts`) and as a subcommand of the compiled
 * `overmind` binary (in production — the MCP server is the compiled
 * binary). The two invocation shapes need different argv:
 *
 *   dev (`execPath` ends with "deno")
 *     → `[deno, "run", "--allow-all", daemonPath]`
 *
 *   compiled (anything else; e.g. `…/overmind`)
 *     → `[overmind, "daemon", "start"]` (cli/overmind.ts routes this
 *       to `runDaemon()` — same entry point as dev mode).
 *
 * Without this branching, auto-spawn from the compiled MCP server
 * invoked `[overmind, "run", …]`, which fell through `runCli`'s
 * default branch (prints help, exits 1). The socket never appeared,
 * and the caller saw "Daemon socket was not ready" with no diagnostic
 * indicating the spawn itself never actually started a daemon.
 *
 * Exported for testability — the spawn itself has side effects, but
 * the argv decision is pure.
 */
export function selectDaemonSpawnArgs(
  execPath: string,
  daemonPath: string,
): string[] {
  const isDeno = execPath.endsWith("/deno") || execPath.endsWith("\\deno");
  return isDeno ? ["run", "--allow-all", daemonPath] : ["daemon", "start"];
}

function startDaemonProcess(baseDir: string): void {
  const daemonPath = fromFileUrl(import.meta.url);
  const exec = Deno.execPath();
  const args = selectDaemonSpawnArgs(exec, daemonPath);
  const command = new Deno.Command(exec, {
    args,
    env: {
      HOME: Deno.env.get("HOME") ?? ".",
      OVERMIND_DAEMON_BASE_DIR: baseDir,
    },
    stdin: "null",
    stdout: "null",
    stderr: "null",
  });

  const child = command.spawn();
  managedDaemonChildren.set(baseDir, child);
  void child.status.finally(() => {
    if (managedDaemonChildren.get(baseDir) === child) {
      managedDaemonChildren.delete(baseDir);
    }
  });
}

async function waitForSocketReady(
  socketPath: string,
  attempts: number,
  intervalMs: number,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let conn: Deno.Conn | null = null;
    try {
      conn = await Deno.connect({ transport: "unix", path: socketPath });
      const probeRequest: SocketRequest = {
        type: "mode_request",
        run_id: "daemon-ready-check",
        mode: Mode.Scout,
        objective: "daemon readiness probe",
        workspace: resolveBaseDir(),
      };
      await conn.write(
        new TextEncoder().encode(JSON.stringify(probeRequest) + "\n"),
      );
      const responseRaw = await readNdjsonPayload(conn);
      const payload = JSON.parse(responseRaw) as SocketResponse;
      if (!isSocketResponse(payload)) {
        throw new OvermindError(
          "Malformed daemon response during readiness check",
        );
      }
      return;
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await sleep(intervalMs);
      }
    } finally {
      conn?.close();
    }
  }

  throw new OvermindError(
    `Daemon socket was not ready at ${socketPath}: ${String(lastError)}`,
  );
}

const MAX_NDJSON_BUFFER_SIZE = 1024 * 1024; // 1 MB

async function readNdjsonPayload(conn: Deno.Conn): Promise<string> {
  const chunks: Uint8Array[] = [];
  const buf = new Uint8Array(4096);
  let totalSize = 0;

  while (true) {
    const n = await conn.read(buf);
    if (n === null) break;

    const chunk = buf.slice(0, n);
    chunks.push(chunk);
    totalSize += n;

    if (totalSize > MAX_NDJSON_BUFFER_SIZE) {
      throw new OvermindError("Request payload exceeds maximum buffer size");
    }

    // Check if we've received a newline delimiter
    if (chunk.includes(0x0a)) break;
  }

  if (chunks.length === 0) return "";

  const merged = new Uint8Array(totalSize);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }

  const raw = new TextDecoder().decode(merged);
  const newlineIndex = raw.indexOf("\n");
  return newlineIndex >= 0 ? raw.slice(0, newlineIndex) : raw;
}

function isSocketResponse(payload: unknown): payload is SocketResponse {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const value = payload as Record<string, unknown>;
  return (value.status === "accepted" || value.status === "error") &&
    typeof value.run_id === "string" &&
    (value.error === null || typeof value.error === "string");
}

async function removeIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPortFromEnv(): number | null {
  const raw = Deno.env.get(HTTP_PORT_ENV_VAR);
  if (!raw) return null;
  const parsed = Number(raw);
  // Reject 0 from the env path — operators setting OVERMIND_KERNEL_HTTP_PORT=0
  // probably typoed. Tests still pick ephemeral ports via the explicit
  // `httpPort: 0` constructor option.
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return null;
  return parsed;
}

// ─── Lifecycle: stop / status / restart ────────────────────────────────────
// Mirrors brain's daemon CLI shape (`brain daemon stop|status|restart`).
// Operates on the same PID file the running daemon writes (`daemon.pid` in
// the base dir) and uses `Deno.kill(pid, 0)` to probe liveness without
// affecting the target process.

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  /** True when a PID file exists but the process is dead (stale entry). */
  stale: boolean;
}

/**
 * Inspect the PID file and return what's there. Pure: no kill, no removal.
 * Tests construct synthetic baseDirs to drive every code path.
 */
export async function daemonStatus(baseDir?: string): Promise<DaemonStatus> {
  const resolvedBaseDir = resolveBaseDir(baseDir);
  const pidPath = `${resolvedBaseDir}/${PID_FILE_NAME}`;

  let pid: number | null = null;
  try {
    const raw = (await Deno.readTextFile(pidPath)).trim();
    const parsed = Number(raw);
    pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  if (pid === null) return { running: false, pid: null, stale: false };
  if (processExists(pid)) return { running: true, pid, stale: false };
  return { running: false, pid, stale: true };
}

/**
 * Send SIGTERM to a running daemon and wait briefly for it to exit. Removes
 * a stale PID file if no process is running. Returns a string describing
 * what happened, suitable for printing to stdout.
 *
 * Does not delete the socket file — the daemon's own shutdown removes it,
 * and SIGKILL stragglers are handled by the next start's stale-socket
 * detection (mirrors brain).
 */
export async function stopDaemon(
  baseDir?: string,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollMs = options.pollIntervalMs ?? 100;
  const resolvedBaseDir = resolveBaseDir(baseDir);
  const pidPath = `${resolvedBaseDir}/${PID_FILE_NAME}`;

  const status = await daemonStatus(resolvedBaseDir);
  if (!status.running) {
    if (status.stale && status.pid !== null) {
      await removeIfExists(pidPath);
      return `Daemon is not running (stale PID file for ${status.pid} removed)`;
    }
    return "Daemon is not running";
  }

  const pid = status.pid as number;
  try {
    Deno.kill(pid, "SIGTERM");
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      // Race: process exited between status check and kill. Treat as success.
      await removeIfExists(pidPath);
      return `Daemon already exited (PID ${pid})`;
    }
    throw err;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) {
      await removeIfExists(pidPath);
      return `Daemon stopped (PID ${pid})`;
    }
    await sleep(pollMs);
  }

  return `Daemon did not exit within ${timeoutMs}ms (PID ${pid}); send SIGKILL manually if needed`;
}

/**
 * Pick the daemon-default dispatcher. Precedence (highest first):
 *   1. `OVERMIND_CLIENT_DISPATCHER` env var: "1" forces client_side, "0"
 *      forces subprocess. Useful for one-off testing without editing the
 *      toml.
 *   2. `configMode` argument (loaded from `[dispatcher] mode` in
 *      overmind.toml): "client_side" or "subprocess".
 *   3. Default "subprocess" if neither is set.
 *
 * client_side returns a ClientSideDispatcher unconditionally — there is
 * no precondition to verify on the daemon side. subprocess probes for
 * the `claude` binary and falls back to NoopDispatcher (returns
 * undefined) if it's missing.
 *
 * Note: as of the per-request `dispatcher_mode` change, the daemon also
 * exposes BOTH dispatchers concurrently via `selectDispatchers` (plural)
 * so callers can pick per-run. This single-result helper is kept for
 * backwards compatibility with existing tests and for callers that want
 * a one-shot default.
 */
export async function selectDispatcher(
  configMode: "subprocess" | "client_side" = "subprocess",
  env: (key: string) => string | undefined = (k) => Deno.env.get(k),
): Promise<ClientSideDispatcher | ClaudeCodeDispatcher | undefined> {
  const envOverride = env("OVERMIND_CLIENT_DISPATCHER");
  let mode: "subprocess" | "client_side" = configMode;
  if (envOverride === "1") {
    console.warn(
      "[overmind] OVERMIND_CLIENT_DISPATCHER=1 is deprecated; prefer passing dispatcher_mode: \"client_side\" per-request via overmind_delegate.",
    );
    mode = "client_side";
  } else if (envOverride === "0") {
    mode = "subprocess";
  }

  if (mode === "client_side") {
    console.log(
      "[overmind] using ClientSideDispatcher (in-process teammate spawning); caller must drain via overmind_pending_dispatches",
    );
    return new ClientSideDispatcher();
  }
  const subprocess = new ClaudeCodeDispatcher();
  const ok = await subprocess.probeAvailability();
  if (ok) {
    return subprocess;
  }
  console.warn(
    "[overmind] claude binary not found on PATH; falling back to NoopDispatcher (swarm/relay/scout will not actually spawn agents).",
  );
  return undefined;
}

/**
 * Build the daemon's dispatcher registry — one entry per dispatcher kind
 * the host can support. Result:
 *   - `client_side` is always present (no preconditions).
 *   - `subprocess` is present iff the `claude` binary is on PATH.
 *
 * The kernel is constructed with this registry plus a `defaultDispatcherMode`
 * so caller-declared `dispatcher_mode` is honoured per-run, and requests
 * that don't declare one fall back to the default. Loud-fail at the daemon
 * request handler covers the case where a caller asks for a dispatcher
 * the daemon doesn't have.
 */
export async function selectDispatchers(): Promise<{
  dispatchers: Partial<Record<DispatcherMode, AgentDispatcher>>;
  defaultMode: DispatcherMode;
}> {
  const dispatchers: Partial<Record<DispatcherMode, AgentDispatcher>> = {};
  dispatchers.client_side = new ClientSideDispatcher();

  const subprocess = new ClaudeCodeDispatcher();
  const subprocessOk = await subprocess.probeAvailability();
  if (subprocessOk) {
    dispatchers.subprocess = subprocess;
  } else {
    console.warn(
      "[overmind] claude binary not found on PATH; subprocess dispatcher unavailable. " +
        "Caller-driven client_side requests still work; headless callers (CLI/CI) without dispatcher_mode set will fail loudly at request time.",
    );
  }

  // Default is always "subprocess" when available — the only mode that
  // works for any caller. When subprocess isn't available the daemon falls
  // back to "client_side" as the default, but unspecifying callers in that
  // posture will silently queue; the loud-fail at request handle time
  // catches that. We keep the default field accurate so kernel.getDispatcher()
  // without a mode still resolves to something.
  const defaultMode: DispatcherMode = dispatchers.subprocess
    ? "subprocess"
    : "client_side";
  return { dispatchers, defaultMode };
}

export async function runDaemon(): Promise<never> {
  // Attach a Kernel so the HTTP listener (on port 8080 by default) starts.
  // Without this the daemon only serves the Unix socket path; the MCP server
  // cannot reach the kernel because nothing is listening on localhost:8080
  // for /lock, /event, etc.
  //
  // Dispatcher policy: the daemon exposes BOTH dispatcher kinds (where
  // available) and lets callers pick per-request via `dispatcher_mode`.
  // The toml `[dispatcher] mode` setting is no longer load-bearing for
  // caller correctness — it survives only as the env-var-overridable
  // default surfaced via `selectDispatcher` for tests and one-off CLI
  // invocations.
  const { dispatchers, defaultMode } = await selectDispatchers();
  const kernel = new Kernel({
    dispatchers,
    defaultDispatcherMode: defaultMode,
  });
  await kernel.start();
  const daemon = new OvermindDaemon({
    baseDir: Deno.env.get("OVERMIND_DAEMON_BASE_DIR") ?? undefined,
    kernel,
  });
  await daemon.start();
  return await new Promise<never>(() => {});
}

/**
 * Stop any running daemon and re-spawn one detached from the current process.
 * Used by `overmind daemon restart`. Returns a status line for printing.
 */
export async function restartDaemon(
  binaryPath: string,
  baseDir?: string,
): Promise<string> {
  const stopMsg = await stopDaemon(baseDir);

  const command = new Deno.Command(binaryPath, {
    args: ["daemon", "start"],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  });
  const child = command.spawn();
  child.unref();
  child.status.catch(() => {});

  return `${stopMsg}\nDaemon restart spawned (binary: ${binaryPath})`;
}

if (import.meta.main) {
  await runDaemon();
}

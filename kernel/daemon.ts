import { OvermindError } from "./errors.ts";
import { Mode } from "./types.ts";
import type {
  CancelRequest,
  ModeRequest,
  SocketRequest,
  SocketResponse,
} from "./types.ts";
import { fromFileUrl } from "@std/path";
import type { Kernel } from "./kernel.ts";

interface OvermindDaemonOptions {
  baseDir?: string;
  kernel?: Kernel;
}

interface ParsedRequest {
  request: SocketRequest | null;
  error: string | null;
}

const SOCKET_FILE_NAME = "daemon.sock";
const PID_FILE_NAME = "daemon.pid";
const LOCK_FILE_NAME = "daemon.lock";
const STARTUP_RETRY_ATTEMPTS = 5;
const STARTUP_RETRY_INTERVAL_MS = 200;
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
      STARTUP_RETRY_ATTEMPTS,
      STARTUP_RETRY_INTERVAL_MS,
    );
  } finally {
    lockHandle.close();
    await removeIfExists(lockPath);
  }
}

export async function sendToSocket(
  request: SocketRequest,
  socketPath = `${resolveBaseDir()}/${SOCKET_FILE_NAME}`,
): Promise<SocketResponse> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= STARTUP_RETRY_ATTEMPTS; attempt += 1) {
    let conn: Deno.Conn | null = null;
    try {
      conn = await Deno.connect({ transport: "unix", path: socketPath });
      const body = JSON.stringify(request) + "\n";
      await conn.write(new TextEncoder().encode(body));

      const responseRaw = await readNdjsonPayload(conn);
      const payload = JSON.parse(responseRaw) as SocketResponse;
      if (!isSocketResponse(payload)) {
        throw new OvermindError("Malformed daemon response");
      }

      return payload;
    } catch (err) {
      lastError = err;
      if (attempt < STARTUP_RETRY_ATTEMPTS) {
        await sleep(STARTUP_RETRY_INTERVAL_MS);
        continue;
      }
    } finally {
      conn?.close();
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
  private readonly kernel: Kernel | null;

  private listener: Deno.Listener | null = null;
  private acceptLoopPromise: Promise<void> | null = null;
  private running = false;
  private signalHandlersRegistered = false;

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
    this.kernel = options.kernel ?? null;
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
  }

  async shutdown(): Promise<void> {
    if (!this.running && !this.listener) {
      return;
    }

    this.running = false;
    this.unregisterSignalHandlers();

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
      const parsed = this.parseRequest(requestRaw);

      let response: SocketResponse;
      if (parsed.request) {
        if (parsed.request.type === "cancel_request") {
          const req = parsed.request as CancelRequest;
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
        } else {
          const req = parsed.request as ModeRequest;
          response = { status: "accepted", run_id: req.run_id, error: null };
          // Fire-and-forget mode execution if kernel is available
          if (this.kernel) {
            this.kernel.executeMode(
              req.mode,
              req.objective,
              req.workspace,
              req.run_id,
            ).catch((err) => {
              console.error(`Mode execution error for ${req.run_id}:`, err);
            });
          }
        }
      } else {
        response = {
          status: "error",
          run_id: "",
          error: parsed.error ?? "Invalid request",
        };
      }

      const responseBody = JSON.stringify(response) + "\n";
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

  private isModeRequest(payload: unknown): payload is ModeRequest {
    if (!payload || typeof payload !== "object") {
      return false;
    }

    const value = payload as Record<string, unknown>;
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

function startDaemonProcess(baseDir: string): void {
  const daemonPath = fromFileUrl(import.meta.url);
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", daemonPath],
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

if (import.meta.main) {
  const daemon = new OvermindDaemon({
    baseDir: Deno.env.get("OVERMIND_DAEMON_BASE_DIR") ?? undefined,
  });
  await daemon.start();
  await new Promise<void>(() => {});
}

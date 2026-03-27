import { OvermindError } from "./errors.ts";
import { Mode } from "./types.ts";
import type { SocketRequest, SocketResponse } from "./types.ts";

interface OvermindDaemonOptions {
  baseDir?: string;
}

interface ParsedRequest {
  request: SocketRequest | null;
  error: string | null;
}

const SOCKET_FILE_NAME = "daemon.sock";
const PID_FILE_NAME = "daemon.pid";

export class OvermindDaemon {
  private readonly baseDir: string;
  private readonly socketPath: string;
  private readonly pidPath: string;

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

    await this.removeIfExists(this.pidPath);
    await this.removeIfExists(this.socketPath);
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
        if (err instanceof Deno.errors.BadResource || err instanceof Deno.errors.Interrupted) {
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

      const response: SocketResponse = parsed.request
        ? { status: "accepted", run_id: parsed.request.run_id, error: null }
        : { status: "error", run_id: "", error: parsed.error ?? "Invalid request" };

      const responseBody = JSON.stringify(response);
      await conn.write(new TextEncoder().encode(responseBody));
    } finally {
      conn.close();
    }
  }

  private async readRequestPayload(conn: Deno.Conn): Promise<string> {
    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(4096);

    while (true) {
      const n = await conn.read(buf);
      if (n === null) break;

      chunks.push(buf.slice(0, n));

      if (n < buf.length) {
        break;
      }
    }

    if (chunks.length === 0) {
      return "";
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    return new TextDecoder().decode(merged);
  }

  private parseRequest(raw: string): ParsedRequest {
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return { request: null, error: "Malformed request: invalid JSON" };
    }

    if (!this.isModeRequest(payload)) {
      return { request: null, error: "Invalid request: expected mode_request contract" };
    }

    return { request: payload, error: null };
  }

  private isModeRequest(payload: unknown): payload is SocketRequest {
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
      await this.removeIfExists(this.pidPath);
      return;
    }

    const exists = this.processExists(pid);
    if (!exists) {
      await this.removeIfExists(this.pidPath);
      return;
    }

    const isDaemonProcess = await this.isLikelyOvermindDaemonProcess(pid);
    if (isDaemonProcess) {
      throw new OvermindError(`Daemon already running with PID ${pid}`);
    }

    await this.removeIfExists(this.pidPath);
  }

  private async cleanupStaleSocketFile(): Promise<void> {
    if (!(await this.pathExists(this.socketPath))) return;

    let connected = false;
    try {
      const conn = await Deno.connect({ transport: "unix", path: this.socketPath });
      connected = true;
      conn.close();
    } catch {
      connected = false;
    }

    if (connected) {
      throw new OvermindError("Daemon socket is already active");
    }

    await this.removeIfExists(this.socketPath);
  }

  private processExists(pid: number): boolean {
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
      return processCommand.includes("kernel/daemon.ts") || processCommand.includes("overmind daemon");
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

  private async removeIfExists(path: string): Promise<void> {
    try {
      await Deno.remove(path);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        throw err;
      }
    }
  }
}

if (import.meta.main) {
  const daemon = new OvermindDaemon();
  await daemon.start();
  await new Promise<void>(() => {});
}

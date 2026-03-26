import { McpError, McpErrorCode, McpVersion } from "./mcp_protocol.ts";

export interface StdioTransportOptions {
  command: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export class McpStdioClient {
  private proc: Deno.ChildProcess | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private requestId = 0;
  private pendingRequests: Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  > = new Map();
  private initialized = false;

  async connect(options: StdioTransportOptions): Promise<void> {
    this.proc = new Deno.Command(options.command[0], {
      args: options.command.slice(1),
      env: options.env,
      cwd: options.cwd,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    const stdin = this.proc.stdin.getWriter();
    const stdout = this.proc.stdout.getReader();
    this.writer = stdin;
    this.reader = stdout;

    await this.initialize();
  }

  private async initialize(): Promise<void> {
    await this.sendRequest("initialize", {
      protocolVersion: McpVersion.V2024_11_05,
      capabilities: {},
      clientInfo: { name: "overmind", version: "0.1.0" },
    });
    this.initialized = true;
    await this.sendNotification("initialized", {});
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<unknown> {
    if (!this.initialized) throw new McpError("Not initialized", McpErrorCode.InternalError);
    return this.sendRequest("tools/call", { name, arguments: args ?? {} });
  }

  async sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.writer || !this.reader) throw new McpError("Not connected", McpErrorCode.InternalError);

    const id = ++this.requestId;
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    });

    await this.writer.write(new TextEncoder().encode(request + "\n"));

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.readResponses().catch(reject);
    });
  }

  async sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    if (!this.writer) throw new McpError("Not connected", McpErrorCode.InternalError);
    const notification = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params: params ?? {},
    });
    await this.writer.write(new TextEncoder().encode(notification + "\n"));
  }

  private async readResponses(): Promise<void> {
    if (!this.reader) return;

    const buffer = "";
    let result = "";

    while (true) {
      const { value, done } = await this.reader.read();
      if (done) break;

      result += new TextDecoder().decode(value);
      const lines = result.split("\n");
      result = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const response = JSON.parse(line);
        if ("id" in response) {
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            this.pendingRequests.delete(response.id);
            if (response.error) {
              pending.reject(
                new McpError(
                  response.error.message,
                  response.error.code,
                  response.error.data,
                ),
              );
            } else {
              pending.resolve(response.result);
            }
          }
        }
      }
    }
  }

  async close(): Promise<void> {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.initialized = false;
  }
}

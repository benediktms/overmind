// Overmind MCP server — JSON-RPC over stdio.
//
// Replaces the legacy Node.js bridge (cli/claudecode-plugin/bridge/mcp-bridge.cjs).
// Bridges Claude Code tool calls to the Overmind kernel via the daemon's
// Unix socket (mode_request protocol — same wire format the `overmind
// delegate` CLI uses). Runs in-process inside the compiled `overmind`
// binary (subcommand `overmind mcp`), matching brain's `brain mcp` model.

import { ensureDaemonRunning, sendToSocket } from "../kernel/daemon.ts";
import { Mode } from "../kernel/types.ts";
import type { SocketRequest, SocketResponse } from "../kernel/types.ts";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  // null is valid for id per JSON-RPC 2.0 — spec uses it for error responses
  // when the original id couldn't be determined (e.g. parse errors).
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

interface MCPConfig {
  /** Neural_link server base URL (no trailing slash). The /mcp JSON-RPC and
   *  /health probe paths are appended by callers, not baked into the base. */
  neuralLinkBase: string;
  /** Kernel HTTP server base URL (no trailing slash). */
  kernelHttpUrl: string;
  /** Daemon state directory (~/.overmind by default). The Unix socket lives
   *  at `${baseDir}/daemon.sock`. */
  baseDir: string;
  roomId: string;
  participantId: string;
}

/**
 * Sink for `overmind_delegate` calls — the production binding speaks the
 * daemon's `mode_request` protocol over its Unix socket; tests inject a
 * stub that records arguments for assertion. The callable is responsible
 * for ensuring the daemon is running and forwarding the response.
 */
export interface DelegateSink {
  (request: SocketRequest, baseDir: string): Promise<SocketResponse>;
}

/**
 * Trim a trailing `/mcp` suffix from a configured URL. Earlier versions of
 * this server (and the legacy Node bridge) baked `/mcp` into the env var;
 * we now treat the env var as the server BASE URL and append paths
 * explicitly. Accept both shapes for backward compat with existing user
 * configs.
 */
export function normalizeNeuralLinkBase(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/mcp") ? trimmed.slice(0, -"/mcp".length) : trimmed;
}

function loadConfig(): MCPConfig {
  const home = Deno.env.get("HOME") ?? ".";
  return {
    neuralLinkBase: normalizeNeuralLinkBase(
      Deno.env.get("OVERMIND_NEURAL_LINK_URL") ?? "http://localhost:9961",
    ),
    kernelHttpUrl: (Deno.env.get("OVERMIND_KERNEL_HTTP_URL") ?? "http://localhost:8080")
      .replace(/\/+$/, ""),
    baseDir: Deno.env.get("OVERMIND_BASE_DIR") ?? `${home}/.overmind`,
    roomId: Deno.env.get("OVERMIND_ROOM_ID") ?? "",
    participantId: Deno.env.get("OVERMIND_PARTICIPANT_ID") ?? "claudecode-overmind",
  };
}

/**
 * Production DelegateSink — auto-spawns the daemon if it isn't running,
 * then forwards the mode_request over the daemon's Unix socket. Mirrors
 * what the `overmind delegate` CLI command does.
 */
const liveDelegateSink: DelegateSink = async (request, baseDir) => {
  await ensureDaemonRunning(baseDir);
  return await sendToSocket(request, `${baseDir}/daemon.sock`);
};

const TOOLS = [
  {
    name: "overmind_delegate",
    description: "Delegate work to the Overmind swarm coordinator via neural_link",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string", description: "The objective to accomplish" },
        mode: {
          type: "string",
          enum: ["scout", "relay", "swarm"],
          description: "Execution mode (scout=parallel context, relay=sequential pipeline, swarm=parallel with verify/fix)",
        },
        priority: {
          type: "number",
          enum: [0, 1, 2, 3, 4],
          description: "Priority (0=critical, 1=high, 2=medium, 3=low, 4=backlog)",
          default: 4,
        },
      },
      required: ["objective"],
    },
  },
  {
    name: "overmind_status",
    description: "Get Overmind kernel and swarm status",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "overmind_cancel",
    description: "Cancel a running objective",
    inputSchema: {
      type: "object",
      properties: {
        objective_id: { type: "string", description: "ID of the objective to cancel" },
      },
      required: ["objective_id"],
    },
  },
  {
    name: "overmind_room_join",
    description: "Join an Overmind neural_link room for coordination",
    inputSchema: {
      type: "object",
      properties: {
        room_id: { type: "string", description: "Room ID to join" },
        display_name: { type: "string", description: "Display name", default: "Claude Code" },
      },
      required: ["room_id"],
    },
  },
];

// JSON-RPC 2.0 standard error codes used below.
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;

// Cap on the size of a single buffered line (no newline yet seen) before
// we abort it as a parse error. Without this cap, a peer that sends a
// gigabyte of bytes without a newline would exhaust memory before any
// message could be parsed. Real MCP messages are tiny — 1 MB is enormous
// headroom and still bounds memory.
const MAX_LINE_SIZE = 1 << 20; // 1 MB

// Internal contract for the writer the server uses to emit responses. The
// production binding pipes to stdout; tests inject a buffered writer so
// they can inspect what the server would have sent.
export interface MCPWriter {
  (msg: JsonRpcMessage): void;
}

export class MCPServer {
  private config: MCPConfig;
  private writer: MCPWriter;
  private delegateSink: DelegateSink;
  private sessionId: string | null = null;
  private encoder = new TextEncoder();

  constructor(
    config: MCPConfig,
    writer?: MCPWriter,
    delegateSink?: DelegateSink,
  ) {
    this.config = config;
    this.writer = writer ?? ((msg) => {
      const line = JSON.stringify(msg) + "\n";
      Deno.stdout.writeSync(this.encoder.encode(line));
    });
    this.delegateSink = delegateSink ?? liveDelegateSink;
  }

  private write(msg: JsonRpcMessage): void {
    this.writer(msg);
  }

  private respond(id: number | string | null | undefined, result: unknown): void {
    // Notifications (no id field) get no response per spec — there's no way
    // for the peer to correlate it. Treat explicit null id the same way
    // since the spec reserves null for error-on-unknown-id and a successful
    // response with id null wouldn't be useful to a normal client.
    if (id === undefined || id === null) return;
    this.write({ jsonrpc: "2.0", id, result });
  }

  private respondError(
    id: number | string | null | undefined,
    code: number,
    message: string,
  ): void {
    // Unlike successful responses, JSON-RPC requires an error response even
    // when the id is unknown (parse error before id was extracted). Spec:
    // "If there was an error in detecting the id in the Request object
    // (e.g. Parse error/Invalid Request), it MUST be Null."
    this.write({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  }

  /**
   * Feed a chunk of bytes/text to the parser. Used by run() (over stdin) and
   * by tests that drive the server with synthetic input. Splits on newlines,
   * dispatches complete lines, retains any partial trailing line in the
   * caller-supplied buffer (returned as the new buffer state).
   *
   * Emits a JSON-RPC parse error and discards the buffer if a single
   * unterminated line exceeds MAX_LINE_SIZE.
   */
  async feed(chunk: string, buffer: string): Promise<string> {
    let next = buffer + chunk;

    if (next.length > MAX_LINE_SIZE && !next.includes("\n")) {
      this.respondError(
        null,
        RPC_PARSE_ERROR,
        `Line exceeds maximum size (${MAX_LINE_SIZE} bytes); buffer dropped.`,
      );
      return "";
    }

    const lines = next.split("\n");
    next = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage;
      } catch (err) {
        // Spec: parse errors → id null, code -32700.
        this.respondError(
          null,
          RPC_PARSE_ERROR,
          `Parse error: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
        this.respondError(null, RPC_INVALID_REQUEST, "Invalid Request");
        continue;
      }
      await this.handleMessage(msg);
    }

    return next;
  }

  async run(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";

    const reader = Deno.stdin.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer = await this.feed(decoder.decode(value, { stream: true }), buffer);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async handleMessage(msg: JsonRpcMessage): Promise<void> {
    if (!msg.method) return;
    const params = msg.params ?? {};

    switch (msg.method) {
      case "initialize":
        this.respond(msg.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "overmind", version: "0.2.0" },
        });
        return;

      case "initialized":
      case "notifications/initialized":
        return;

      case "tools/list":
        this.respond(msg.id, { tools: TOOLS });
        return;

      case "tools/call": {
        const name = params.name as string | undefined;
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (!name) {
          this.respondError(msg.id, -32602, "Missing tool name");
          return;
        }
        try {
          const result = await this.callTool(name, args);
          this.respond(msg.id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          });
        } catch (err) {
          this.respond(msg.id, {
            content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          });
        }
        return;
      }

      default:
        this.respondError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "overmind_delegate":
        return await this.delegate(
          String(args.objective ?? ""),
          (args.mode as string) ?? "scout",
          typeof args.priority === "number" ? args.priority : 4,
        );
      case "overmind_status":
        return await this.status();
      case "overmind_cancel":
        return await this.cancel(String(args.objective_id ?? ""));
      case "overmind_room_join":
        return await this.roomJoin(
          String(args.room_id ?? ""),
          (args.display_name as string) ?? "Claude Code",
        );
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }


  private async delegate(objective: string, modeRaw: string, _priority: number): Promise<unknown> {
    const trimmed = objective.trim();
    if (!trimmed) {
      return { success: false, error: "objective is required" };
    }
    const mode = parseMode(modeRaw);
    if (!mode) {
      return { success: false, error: `invalid mode: ${modeRaw}` };
    }

    const runId = `run-${crypto.randomUUID()}`;
    const request: SocketRequest = {
      type: "mode_request",
      run_id: runId,
      mode,
      objective: trimmed,
      workspace: Deno.cwd(),
      config_override: { max_fix_cycles: mode === Mode.Scout ? 0 : 3 },
    };

    try {
      const response = await this.delegateSink(request, this.config.baseDir);
      if (response.status === "accepted") {
        return { success: true, run_id: response.run_id, mode };
      }
      return { success: false, run_id: response.run_id, error: response.error ?? "unknown error" };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async status(): Promise<unknown> {
    const status: Record<string, unknown> = {
      neural_link_url: this.config.neuralLinkBase,
      room_id: this.config.roomId || null,
      participant_id: this.config.participantId,
      kernel_http_url: this.config.kernelHttpUrl,
      configured: !!(this.config.roomId || this.config.kernelHttpUrl),
    };

    // Probe both /health endpoints. Both servers expose them as GET, no
    // auth, returning {status: "ok"} on 200. Earlier versions of this code
    // appended /health to a URL that already had a /mcp suffix, producing
    // /mcp/health which 404s on neural_link — that's why "available: false"
    // showed up even when the daemons were healthy.
    status.neural_link_available = await this.probe(`${this.config.neuralLinkBase}/health`);
    status.kernel_available = await this.probe(`${this.config.kernelHttpUrl}/health`);

    return status;
  }

  private async probe(url: string): Promise<boolean> {
    try {
      const resp = await fetch(url);
      return resp.ok;
    } catch {
      return false;
    }
  }

  private async cancel(_objectiveId: string): Promise<unknown> {
    // Kernel cancellation is cooperative and not yet wired through the
    // daemon socket protocol. The CLI's `overmind cancel` command emits the
    // same notice. When mode_request grows a cancel companion request, this
    // tool can forward through the same delegateSink.
    return {
      success: false,
      error: "cancellation not yet implemented in the kernel — runs stop at next checkpoint",
    };
  }

  private async roomJoin(_roomId: string, _displayName: string): Promise<unknown> {
    // Joining a neural_link coordination room requires a full JSON-RPC
    // tools/call exchange with neural_link's MCP server (initialize +
    // session id + tools/call name="room_join"). The legacy bridge tried
    // to POST a non-existent /room/join REST endpoint; rather than ship
    // another broken path, surface a clear "not yet supported" error.
    return {
      success: false,
      error: "room_join over neural_link MCP not yet supported — use neural_link's MCP server directly",
    };
  }
}

function parseMode(raw: string): Mode | null {
  switch (raw) {
    case "scout":
      return Mode.Scout;
    case "relay":
      return Mode.Relay;
    case "swarm":
      return Mode.Swarm;
    default:
      return null;
  }
}

export async function runMcp(): Promise<void> {
  console.error("[overmind-mcp] Starting stdio MCP server...");
  const server = new MCPServer(loadConfig());
  await server.run();
}

if (import.meta.main) {
  await runMcp();
}

// Overmind MCP server — JSON-RPC over stdio.
//
// Replaces the legacy Node.js bridge (cli/claudecode-plugin/bridge/mcp-bridge.cjs).
// Bridges Claude Code tool calls to the Overmind kernel HTTP API and to
// neural_link's HTTP MCP. Runs in-process inside the compiled `overmind` binary
// (subcommand `overmind mcp`), matching brain's `brain mcp` model.

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
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
  roomId: string;
  participantId: string;
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
  return {
    neuralLinkBase: normalizeNeuralLinkBase(
      Deno.env.get("OVERMIND_NEURAL_LINK_URL") ?? "http://localhost:9961",
    ),
    kernelHttpUrl: (Deno.env.get("OVERMIND_KERNEL_HTTP_URL") ?? "http://localhost:8080")
      .replace(/\/+$/, ""),
    roomId: Deno.env.get("OVERMIND_ROOM_ID") ?? "",
    participantId: Deno.env.get("OVERMIND_PARTICIPANT_ID") ?? "claudecode-overmind",
  };
}

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

class MCPServer {
  private config: MCPConfig;
  private sessionId: string | null = null;
  private encoder = new TextEncoder();

  constructor(config: MCPConfig) {
    this.config = config;
  }

  private write(msg: JsonRpcMessage): void {
    const line = JSON.stringify(msg) + "\n";
    Deno.stdout.writeSync(this.encoder.encode(line));
  }

  private respond(id: number | string | undefined, result: unknown): void {
    if (id === undefined) return;
    this.write({ jsonrpc: "2.0", id, result });
  }

  private respondError(id: number | string | undefined, code: number, message: string): void {
    if (id === undefined) return;
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async run(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";

    const reader = Deno.stdin.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed) as JsonRpcMessage;
            await this.handleMessage(msg);
          } catch (err) {
            console.error("[overmind-mcp] Failed to parse message:", err);
          }
        }
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

  private async neuralLinkFetch(path: string, body: unknown): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

    // NOTE: neural_link only exposes POST /mcp (JSON-RPC) and GET /health on
    // its HTTP server — the /room/open, /message/send, /room/join paths
    // referenced below do NOT exist as REST endpoints. The legacy Node bridge
    // and this port have been calling them since day 1 and getting 404s; the
    // delegate-via-neural_link path is structurally broken and needs a
    // proper JSON-RPC tools/call rewrite. Tracked separately. The kernel
    // HTTP path (POST /objective ... etc) above is the only working route.
    const resp = await fetch(`${this.config.neuralLinkBase}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const newSession = resp.headers.get("Mcp-Session-Id");
    if (newSession) this.sessionId = newSession;
    return resp;
  }

  private async delegate(objective: string, mode: string, priority: number): Promise<unknown> {
    if (!this.config.roomId) {
      // Try kernel HTTP if no room configured.
      try {
        const resp = await fetch(`${this.config.kernelHttpUrl}/objective`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ objective, mode, priority }),
        });
        if (resp.ok) {
          const data = await resp.json();
          return { success: true, objective_id: data.objective_id, mode };
        }
      } catch {
        // Fall through to neural_link.
      }

      // Open a room via neural_link.
      const openResp = await this.neuralLinkFetch("/room/open", {
        title: `overmind-${Date.now()}`,
        participant_id: this.config.participantId,
        display_name: "Overmind Lead",
        purpose: "Overmind kernel coordination",
        interaction_mode: "informative",
      });

      if (!openResp.ok) {
        return { success: false, error: "neural_link not available" };
      }

      const openData = await openResp.json();
      const roomId = openData.room_id;
      if (openData.session_id) this.sessionId = openData.session_id;

      const sendResp = await this.neuralLinkFetch("/message/send", {
        room_id: roomId,
        from: this.config.participantId,
        kind: "proposal",
        summary: `Objective: ${objective.slice(0, 50)}...`,
        body: JSON.stringify({ objective, mode, priority }),
        persist_hint: "durable",
      });

      return {
        success: sendResp.ok,
        room_id: roomId,
        mode,
        message: sendResp.ok ? "Objective sent to Overmind swarm" : "Failed to send objective",
      };
    }

    const resp = await this.neuralLinkFetch("/message/send", {
      room_id: this.config.roomId,
      from: this.config.participantId,
      kind: "proposal",
      summary: `Objective: ${objective.slice(0, 50)}...`,
      body: JSON.stringify({ objective, mode, priority }),
      persist_hint: "durable",
    });

    if (!resp.ok) return { success: false, error: "Failed to send via neural_link" };
    return { success: true, mode, room_id: this.config.roomId };
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

  private async cancel(objectiveId: string): Promise<unknown> {
    if (!this.config.roomId) return { success: false, error: "No room configured" };

    const resp = await this.neuralLinkFetch("/message/send", {
      room_id: this.config.roomId,
      from: this.config.participantId,
      kind: "blocker",
      summary: `Cancel: ${objectiveId}`,
      body: JSON.stringify({ cancel: objectiveId }),
      persist_hint: "durable",
    });

    return { success: resp.ok };
  }

  private async roomJoin(roomId: string, displayName: string): Promise<unknown> {
    const resp = await this.neuralLinkFetch("/room/join", {
      room_id: roomId,
      participant_id: this.config.participantId,
      display_name: displayName,
      role: "member",
    });

    if (!resp.ok) return { success: false, error: "Failed to join room" };
    return { success: true, room_id: roomId };
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

// Overmind MCP server — JSON-RPC over stdio.
//
// Replaces the legacy Node.js bridge (cli/claudecode-plugin/bridge/mcp-bridge.cjs).
// Bridges Claude Code tool calls to the Overmind kernel via the daemon's
// Unix socket (mode_request protocol — same wire format the `overmind
// delegate` CLI uses). Runs in-process inside the compiled `overmind`
// binary (subcommand `overmind mcp`), matching brain's `brain mcp` model.

import {
  daemonStatus,
  ensureDaemonRunning,
  isDaemonReachable,
  sendToSocket,
} from "../kernel/daemon.ts";
import { Mode } from "../kernel/types.ts";
import type { SocketRequest, SocketResponse } from "../kernel/types.ts";
import { normalizeNeuralLinkBase } from "../adapters/neural_link/adapter.ts";
export { normalizeNeuralLinkBase };

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
 *
 * The optional `signal` is wired to the JSON-RPC request that triggered
 * this call — abort fires when the peer sends `notifications/cancelled`
 * for the same id, letting in-flight socket reads short-circuit instead
 * of hanging until the per-attempt timeout in sendToSocket.
 */
export interface DelegateSink {
  (
    request: SocketRequest,
    baseDir: string,
    signal?: AbortSignal,
  ): Promise<SocketResponse>;
}

function loadConfig(): MCPConfig {
  const home = Deno.env.get("HOME") ?? ".";
  return {
    neuralLinkBase: normalizeNeuralLinkBase(
      Deno.env.get("OVERMIND_NEURAL_LINK_URL") ?? "http://localhost:9961",
    ),
    kernelHttpUrl:
      (Deno.env.get("OVERMIND_KERNEL_HTTP_URL") ?? "http://localhost:8080")
        .replace(/\/+$/, ""),
    baseDir: Deno.env.get("OVERMIND_BASE_DIR") ?? `${home}/.overmind`,
    roomId: Deno.env.get("OVERMIND_ROOM_ID") ?? "",
    participantId: Deno.env.get("OVERMIND_PARTICIPANT_ID") ??
      "claudecode-overmind",
  };
}

/**
 * Production DelegateSink — auto-spawns the daemon if it isn't running,
 * then forwards the mode_request over the daemon's Unix socket. Mirrors
 * what the `overmind delegate` CLI command does.
 */
const liveDelegateSink: DelegateSink = async (request, baseDir, signal) => {
  await ensureDaemonRunning(baseDir);
  return await sendToSocket(request, `${baseDir}/daemon.sock`, signal);
};

const TOOLS = [
  {
    name: "overmind_delegate",
    description:
      "Delegate work to the Overmind swarm coordinator via neural_link",
    inputSchema: {
      type: "object",
      properties: {
        objective: {
          type: "string",
          description: "The objective to accomplish",
        },
        mode: {
          type: "string",
          enum: ["scout", "relay", "swarm"],
          description:
            "Execution mode (scout=parallel context, relay=sequential pipeline, swarm=parallel with verify/fix)",
        },
        priority: {
          type: "number",
          enum: [0, 1, 2, 3, 4],
          description:
            "Priority (0=critical, 1=high, 2=medium, 3=low, 4=backlog)",
          default: 4,
        },
        dispatcher_mode: {
          type: "string",
          enum: ["subprocess", "client_side"],
          description:
            "Caller-declared dispatcher capability. 'client_side' means the caller will drain pending dispatches via overmind_pending_dispatches and spawn each agent as a teammate (Claude Code with experimental teams). 'subprocess' lets the daemon spawn `claude --print` subprocesses (works for any caller, slower bootstrap). Omit to use the daemon's default. The relay/swarm/scout/delegate skills set this automatically based on caller type.",
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
        objective_id: {
          type: "string",
          description: "ID of the objective to cancel",
        },
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
        display_name: {
          type: "string",
          description: "Display name",
          default: "Claude Code",
        },
      },
      required: ["room_id"],
    },
  },
  {
    name: "overmind_pending_dispatches",
    description:
      "Return and drain pending agent dispatches for a run. Used by client-side orchestrators to retrieve queued agent spawn requests from the kernel.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: {
          type: "string",
          description: "Run ID whose pending dispatches should be drained",
        },
      },
      required: ["run_id"],
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
  // Tracks in-flight `tools/call` invocations so `notifications/cancelled`
  // can abort the matching one. Without this the MCP server's serial
  // message loop wedges on a single hung tool call forever, and the
  // peer's user-cancel does nothing because we don't handle the notif.
  private inflight = new Map<number | string, AbortController>();
  // Tracks promises returned from concurrent tools/call dispatches so
  // tests (and shutdown logic) can wait for them to settle. Production
  // doesn't strictly need this, but tests assert against `writer` output
  // and would race with the dispatcher otherwise.
  private dispatched = new Set<Promise<void>>();

  constructor(
    config: MCPConfig,
    writer?: MCPWriter,
    delegateSink?: DelegateSink,
  ) {
    this.config = config;
    // Default writer loops over short writes — Deno.stdout.writeSync may
    // return fewer bytes than requested, especially for payloads exceeding
    // the pipe buffer. Without the loop, large MCP responses can be split
    // and produce a corrupted JSON-RPC frame on the wire.
    this.writer = writer ?? ((msg) => {
      const data = this.encoder.encode(JSON.stringify(msg) + "\n");
      let offset = 0;
      while (offset < data.length) {
        offset += Deno.stdout.writeSync(data.subarray(offset));
      }
    });
    this.delegateSink = delegateSink ?? liveDelegateSink;
  }

  private write(msg: JsonRpcMessage): void {
    this.writer(msg);
  }

  private respond(
    id: number | string | null | undefined,
    result: unknown,
  ): void {
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
      // tools/call dispatched without await so a long-running tool doesn't
      // block subsequent messages on the same stdin stream — including the
      // `notifications/cancelled` that would unblock it. JSON-RPC 2.0
      // correlates by id, so out-of-order resolution is allowed. Other
      // methods (initialize, tools/list, cancellation notifs themselves)
      // are awaited because their handlers are sync and their ordering
      // matters for the peer's state machine.
      if (msg.method === "tools/call") {
        // Track the same promise we add to the set so the .finally cleanup
        // reliably removes it. Earlier shape `void p.finally(...)` chained a
        // SECOND promise whose cleanup ran on a microtask AFTER allSettled
        // resolved p, leaving a settled promise momentarily in the set.
        const id = msg.id;
        let tracked: Promise<void>;
        tracked = this.handleMessage(msg)
          .catch((err) => {
            // handleMessage's tools/call branch already converts errors
            // into JSON-RPC error responses; reaching this catch means a
            // bug in dispatch itself. Surface a -32603 so the peer doesn't
            // hang waiting for a response that would never arrive.
            console.error("Unhandled error in tools/call handler:", err);
            this.respondError(
              id ?? null,
              -32603,
              `Internal error: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          })
          .finally(() => this.dispatched.delete(tracked));
        this.dispatched.add(tracked);
      } else {
        await this.handleMessage(msg);
      }
    }

    return next;
  }

  /**
   * Wait for all currently-dispatched `tools/call` handlers to settle.
   * Tests use this to synchronize against responses written from the
   * concurrent dispatch path; production callers can use it during
   * shutdown to drain in-flight work before exiting.
   *
   * Capped to bound the case where a buggy handler keeps re-enqueuing
   * dispatches indefinitely. Re-entrant dispatch is not supported.
   */
  async flush(): Promise<void> {
    const MAX_DRAIN_PASSES = 32;
    for (let pass = 0; pass < MAX_DRAIN_PASSES; pass += 1) {
      if (this.dispatched.size === 0) return;
      await Promise.allSettled([...this.dispatched]);
    }
    if (this.dispatched.size > 0) {
      console.error(
        `MCPServer.flush(): drain budget exhausted with ${this.dispatched.size} promises still pending — re-entrant dispatch?`,
      );
    }
  }

  async run(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";

    const reader = Deno.stdin.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer = await this.feed(
          decoder.decode(value, { stream: true }),
          buffer,
        );
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

      // Peer-initiated cancellation. MCP uses `notifications/cancelled` with
      // params `{ requestId, reason? }`. We accept the LSP-style alias too
      // because some clients send that instead. Either way the action is the
      // same: abort the in-flight tool call so its sendToSocket read can
      // unwind instead of waiting for the per-attempt timeout to fire.
      case "notifications/cancelled":
      case "$/cancelRequest": {
        const requestId = (params as Record<string, unknown>).requestId as
          | number
          | string
          | undefined;
        if (requestId !== undefined) {
          const ac = this.inflight.get(requestId);
          if (ac) {
            ac.abort();
            this.inflight.delete(requestId);
          }
        }
        return;
      }

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
        const id = msg.id;
        const trackable = id !== undefined && id !== null;
        // Reject duplicate request id: a buggy peer (or an id collision)
        // would otherwise overwrite the existing AbortController and the
        // first call's `finally` would later delete the second call's
        // entry, silently breaking cancellation for it.
        if (trackable && this.inflight.has(id)) {
          this.respondError(
            id,
            -32600,
            `Duplicate request id: ${id} is already in flight`,
          );
          return;
        }
        const ac = new AbortController();
        if (trackable) this.inflight.set(id, ac);
        try {
          const result = await this.callTool(name, args, ac.signal);
          this.respond(msg.id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          });
        } catch (err) {
          const text = ac.signal.aborted
            ? "Cancelled by peer"
            : `Error: ${err instanceof Error ? err.message : String(err)}`;
          this.respond(msg.id, {
            content: [{ type: "text", text }],
            isError: true,
          });
        } finally {
          if (trackable) this.inflight.delete(id);
        }
        return;
      }

      default:
        this.respondError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    switch (name) {
      case "overmind_delegate":
        return await this.delegate(
          String(args.objective ?? ""),
          (args.mode as string) ?? "scout",
          typeof args.priority === "number" ? args.priority : 4,
          typeof args.dispatcher_mode === "string"
            ? args.dispatcher_mode
            : undefined,
          signal,
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
      case "overmind_pending_dispatches":
        return await this.pendingDispatches(String(args.run_id ?? ""));
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private async delegate(
    objective: string,
    modeRaw: string,
    _priority: number,
    dispatcherModeRaw: string | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const trimmed = objective.trim();
    if (!trimmed) {
      return { success: false, error: "objective is required" };
    }
    const mode = parseMode(modeRaw);
    if (!mode) {
      return { success: false, error: `invalid mode: ${modeRaw}` };
    }
    let dispatcherMode: "subprocess" | "client_side" | undefined;
    if (dispatcherModeRaw === "subprocess" || dispatcherModeRaw === "client_side") {
      dispatcherMode = dispatcherModeRaw;
    } else if (dispatcherModeRaw !== undefined) {
      return {
        success: false,
        error:
          `invalid dispatcher_mode: ${dispatcherModeRaw} (expected 'subprocess' or 'client_side')`,
      };
    }

    const runId = `run-${crypto.randomUUID()}`;
    const request: SocketRequest = {
      type: "mode_request",
      run_id: runId,
      mode,
      objective: trimmed,
      workspace: Deno.cwd(),
      dispatcher_mode: dispatcherMode,
      config_override: { max_fix_cycles: mode === Mode.Scout ? 0 : 3 },
    };

    // The daemon kicks off `executeMode` fire-and-forget the moment it
    // accepts the request. If the peer cancels mid-flight (or right after),
    // closing only the MCP-side socket leaves the kernel-side run churning
    // — agents continue, neural_link rooms stay open, brain tasks stay
    // open. Plumb the cancel back into the daemon's existing
    // `cancel_request` protocol so `kernel.cancelRun(runId)` fires on the
    // run we just kicked off. Best-effort: a failed cancel post-abort is
    // not surfaced to the peer (the peer already got "Cancelled by peer").
    if (signal) {
      const onAbort = () => {
        const cancelReq: SocketRequest = {
          type: "cancel_request",
          run_id: runId,
        };
        this.delegateSink(cancelReq, this.config.baseDir).catch(() => {
          // Best-effort: the peer's already been told it was cancelled.
        });
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const response = await this.delegateSink(
        request,
        this.config.baseDir,
        signal,
      );
      if (response.status === "accepted") {
        return { success: true, run_id: response.run_id, mode };
      }
      return {
        success: false,
        run_id: response.run_id,
        error: response.error ?? "unknown error",
      };
    } catch (err) {
      // When the caller aborted, surface that as a thrown error so the
      // `tools/call` handler sets isError + the "Cancelled by peer" body.
      // Other sink failures (daemon refused, malformed response, etc.)
      // continue to be reported as a structured failure result so the
      // peer can introspect them.
      if (signal?.aborted) {
        throw err;
      }
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

    // neural_link is HTTP-only — probe its /health endpoint.
    status.neural_link_available = await this.probe(
      `${this.config.neuralLinkBase}/health`,
    );

    // kernel_available must reflect the transport `overmind_delegate`
    // actually uses: the daemon's Unix socket. The HTTP /health endpoint
    // (port 8080) is a *separate*, best-effort surface — startHttp swallows
    // bind errors so the daemon can keep serving the socket even when HTTP
    // isn't up. Probing only HTTP produced false positives where status
    // reported the kernel up while delegate calls hit connection-refused
    // on the socket. Probe the socket directly, and surface HTTP as a
    // distinct diagnostic field so divergence between the two is visible.
    status.kernel_available = await isDaemonReachable(this.config.baseDir);
    status.kernel_http_available = await this.probe(
      `${this.config.kernelHttpUrl}/health`,
    );

    // Surface PID-file truth so a stale daemon.pid (process died without
    // SIGTERM, leaving the file behind) is observable without shelling out.
    const pidStatus = await daemonStatus(this.config.baseDir);
    status.daemon_pid = pidStatus.pid;
    status.daemon_pid_stale = pidStatus.stale;

    return status;
  }

  private async probe(url: string): Promise<boolean> {
    try {
      // Bounded probe — `overmind_status` calls this for both neural_link
      // and the kernel HTTP server. Without a timeout, a black-holed URL
      // (resolves but no SYN-ACK) wedges the entire MCP server's tools/call
      // for tens of seconds until the OS gives up.
      const resp = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return resp.ok;
    } catch {
      return false;
    }
  }

  private async cancel(objectiveId: string): Promise<unknown> {
    const trimmed = objectiveId.trim();
    if (!trimmed) {
      return { success: false, error: "objective_id is required" };
    }
    const request: SocketRequest = {
      type: "cancel_request",
      run_id: trimmed,
    };
    try {
      const response = await this.delegateSink(request, this.config.baseDir);
      if (response.status === "accepted") {
        return { success: true, run_id: response.run_id };
      }
      return {
        success: false,
        run_id: response.run_id,
        error: response.error ?? "unknown error",
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async roomJoin(
    _roomId: string,
    _displayName: string,
  ): Promise<unknown> {
    // Joining a neural_link coordination room requires a full JSON-RPC
    // tools/call exchange with neural_link's MCP server (initialize +
    // session id + tools/call name="room_join"). The legacy bridge tried
    // to POST a non-existent /room/join REST endpoint; rather than ship
    // another broken path, surface a clear "not yet supported" error.
    return {
      success: false,
      error:
        "room_join over neural_link MCP not yet supported — use neural_link's MCP server directly",
    };
  }

  private async pendingDispatches(runId: string): Promise<unknown> {
    const trimmed = runId.trim();
    if (!trimmed) {
      return { success: false, error: "run_id is required" };
    }
    const request: SocketRequest = {
      type: "drain_dispatches",
      run_id: trimmed,
    };
    try {
      const response = await this.delegateSink(request, this.config.baseDir);
      const dispatches =
        (response as unknown as Record<string, unknown>).dispatches ?? [];
      return { run_id: trimmed, dispatches };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
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

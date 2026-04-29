import type {
  InboxMessage,
  NeuralLinkConfig,
  NeuralLinkPort,
  RoomSummary,
  WaitForMessage,
} from "../../kernel/types.ts";

export enum MessageKind {
  Finding = "finding",
  Handoff = "handoff",
  Blocker = "blocker",
  Decision = "decision",
  Question = "question",
  Answer = "answer",
  ReviewRequest = "review_request",
  ReviewResult = "review_result",
  ArtifactRef = "artifact_ref",
  Summary = "summary",
  Challenge = "challenge",
  Proposal = "proposal",
  Escalation = "escalation",
}

export interface RoomOpenParams {
  title: string;
  participantId: string;
  displayName: string;
  /**
   * Optional caller-supplied room id. When provided, neural_link uses this
   * exact value (rather than auto-generating one). Must match the format
   * `^room_[a-f0-9]{16}$` (literal `room_` prefix + 16 lowercase hex chars).
   *
   * Use this to give every process that needs to converge on the same room
   * a deterministic key derived from a logical owner — e.g. an Overmind
   * `run_id`. Lets the MCP server return the room_id alongside the run_id
   * the moment a delegate is dispatched, with no registration round-trip.
   *
   * NOTE: no in-tree caller wires this field yet — the consumer wiring is
   * tracked as ovr-412 (overmind brain). The field is supported upstream
   * and will be wired by that task. Do not drop it.
   */
  id?: string;
  purpose?: string;
  externalRef?: string;
  tags?: string;
  brains?: string;
  interactionMode?: string;
}

export interface MessageSendParams {
  roomId: string;
  from: string;
  kind: MessageKind;
  summary: string;
  to?: string;
  body?: string;
  threadId?: string;
  persistHint?: string;
}

const FETCH_TIMEOUT_MS = 5_000;
const HEALTH_TIMEOUT_MS = 3_000;
const MCP_PROTOCOL_VERSION = "2024-11-05";

/**
 * Trim a trailing `/mcp` (and any trailing slashes) from a configured URL
 * so the adapter can append `/health` or `/mcp` to a clean base. Mirrors
 * `normalizeNeuralLinkBase` in cli/mcp_server.ts: historical configs
 * baked `/mcp` into the env var / TOML, and we want both shapes to work.
 */
export function normalizeNeuralLinkBase(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/mcp") ? trimmed.slice(0, -"/mcp".length) : trimmed;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Thin JSON-RPC client over neural_link's `POST /mcp` endpoint. Keeps the
 * `mcp-session-id` header from the initialize handshake and re-initializes
 * once when a request comes back 401 (sessions live in an in-memory actor
 * with a 1-hour ceiling, so an idle adapter outlives them).
 *
 * Encapsulated in this module — the adapter is the only caller; nothing
 * else needs the JSON-RPC plumbing.
 */
class NeuralLinkRpcClient {
  private sessionId: string | null = null;
  private nextId = 0;
  // Coalesces concurrent re-inits so N concurrent 401s trigger exactly one
  // initialize() round-trip rather than N parallel ones. Cleared when the
  // in-flight init settles (success or failure).
  private reinitInFlight: Promise<void> | null = null;

  constructor(private readonly httpUrl: string) {}

  getSessionId(): string | null {
    return this.sessionId;
  }

  /** One-time handshake. Idempotent; safe to call again on session expiry. */
  async initialize(): Promise<void> {
    const resp = await this.rawPost({
      jsonrpc: "2.0",
      id: this.allocateId(),
      method: "initialize",
      params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
    });
    try {
      if (!resp.ok) {
        throw new Error(
          `neural_link initialize failed: HTTP ${resp.status} from ${this.mcpUrl()}`,
        );
      }
      const sid = resp.headers.get("mcp-session-id");
      if (!sid) {
        throw new Error(
          "neural_link initialize response missing mcp-session-id header",
        );
      }
      this.sessionId = sid;
      // Drain the body so the connection can be reused — we don't need
      // anything from the initialize result, only the session header.
      await resp.body?.cancel();
    } finally {
      // Always drain on error paths too — an unread body counts as a leak
      // in test runs and holds a connection slot in production.
      if (resp.ok === false) {
        await resp.body?.cancel().catch(() => {});
      }
    }
  }

  /**
   * Coalesce concurrent re-inits behind a single shared Promise so N
   * concurrent 401 responses trigger exactly ONE initialize() round-trip.
   * The promise is cleared after it settles (success or error) so the next
   * call that needs a re-init starts fresh.
   */
  private async ensureFreshSession(): Promise<void> {
    if (!this.reinitInFlight) {
      this.reinitInFlight = this.initialize().finally(() => {
        this.reinitInFlight = null;
      });
    }
    return this.reinitInFlight;
  }

  /**
   * Invoke a tool. Returns the raw JSON-RPC `result` payload or null when
   * the call surfaced a JSON-RPC error / non-2xx that wasn't recoverable.
   * Maps neural_link's "Invalid session" 401 into a single auto re-init
   * + retry — beyond that, gives up.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = FETCH_TIMEOUT_MS,
  ): Promise<unknown | null> {
    const result = await this.callToolOnce(name, args, timeoutMs);
    if (result.kind === "ok") return result.value;
    if (result.kind === "session-expired") {
      // Coalesce concurrent re-inits — only one real initialize() goes out.
      try {
        await this.ensureFreshSession();
      } catch (err) {
        console.warn(
          `neural_link re-initialize failed after session expiry: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      }
      const retried = await this.callToolOnce(name, args, timeoutMs);
      if (retried.kind === "ok") return retried.value;
      if (retried.kind === "session-expired") {
        // Second 401 even after re-init — session mechanism is broken or
        // the server rejected our new session immediately. Log explicitly
        // so the issue is visible without a full packet trace.
        console.warn(
          `neural_link second 401 after re-init for ${name} at ${this.mcpUrl()}`,
        );
        return null;
      }
      this.warnFailure(name, retried);
      return null;
    }
    this.warnFailure(name, result);
    return null;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private allocateId(): number {
    this.nextId += 1;
    return this.nextId;
  }

  private mcpUrl(): string {
    return `${this.httpUrl}/mcp`;
  }

  private async rawPost(
    req: JsonRpcRequest,
    timeoutMs = FETCH_TIMEOUT_MS,
  ): Promise<Response> {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
    };
    return await fetch(this.mcpUrl(), {
      method: "POST",
      headers,
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  private async callToolOnce(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = FETCH_TIMEOUT_MS,
  ): Promise<CallResult> {
    let resp: Response;
    try {
      resp = await this.rawPost(
        {
          jsonrpc: "2.0",
          id: this.allocateId(),
          method: "tools/call",
          params: { name, arguments: args },
        },
        timeoutMs,
      );
    } catch (err) {
      return {
        kind: "transport-error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    if (resp.status === 401) {
      // Drain so the connection can be reused even though we're tossing
      // the body — fetch buffers in memory until the body is consumed.
      await resp.body?.cancel();
      return { kind: "session-expired" };
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { kind: "http-error", status: resp.status, body };
    }

    let payload: JsonRpcResponse;
    try {
      payload = await resp.json() as JsonRpcResponse;
    } catch (err) {
      return {
        kind: "parse-error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    if (payload.error) {
      return {
        kind: "rpc-error",
        code: payload.error.code,
        message: payload.error.message,
      };
    }
    return unwrapToolResult(payload.result);
  }

  private warnFailure(name: string, result: CallResult): void {
    if (result.kind === "ok" || result.kind === "session-expired") return;
    let detail: string;
    switch (result.kind) {
      case "transport-error":
        detail = `transport: ${result.message}`;
        break;
      case "http-error":
        detail = `HTTP ${result.status}${
          result.body ? `: ${result.body}` : ""
        }`;
        break;
      case "parse-error":
        detail = `malformed JSON-RPC response: ${result.message}`;
        break;
      case "rpc-error":
        detail = `JSON-RPC ${result.code}: ${result.message}`;
        break;
      case "tool-error":
        detail = `tool error: ${result.message}`;
        break;
    }
    console.warn(`neural_link ${name} failed at ${this.mcpUrl()} — ${detail}`);
  }
}

type CallResult =
  | { kind: "ok"; value: unknown }
  | { kind: "session-expired" }
  | { kind: "transport-error"; message: string }
  | { kind: "http-error"; status: number; body: string }
  | { kind: "parse-error"; message: string }
  | { kind: "rpc-error"; code: number; message: string }
  | { kind: "tool-error"; message: string };

/**
 * Pull the structured payload out of an MCP `tools/call` result envelope.
 * neural_link wraps every tool response as `{content: [{type: "text",
 * text: "<JSON-encoded data>"}], isError?: bool}` per the MCP protocol —
 * the adapter has to unwrap that to get back to the handler's actual
 * shape (e.g. `{room_id, ...}`). When `isError: true`, the text is a
 * plain error message rather than a JSON object.
 */
function unwrapToolResult(rawResult: unknown): CallResult {
  if (!isObject(rawResult) || !Array.isArray(rawResult.content)) {
    // Missing content array — malformed, not a tolerable "unwrapped" shape.
    return {
      kind: "parse-error",
      message: "tools/call result missing content array",
    };
  }
  const content = rawResult.content as unknown[];
  if (content.length !== 1) {
    return {
      kind: "parse-error",
      message:
        `tools/call expected exactly one content block, got ${content.length}`,
    };
  }
  const first = content[0];
  if (!isObject(first)) {
    return {
      kind: "parse-error",
      message: "tools/call content[0] is not an object",
    };
  }
  if (first.type !== "text") {
    return {
      kind: "parse-error",
      message: `tools/call content[0].type !== text, got ${
        typeof first.type === "string" ? first.type : JSON.stringify(first.type)
      }`,
    };
  }
  if (typeof first.text !== "string") {
    return {
      kind: "parse-error",
      message: "tools/call content[0] missing text field",
    };
  }
  if (rawResult.isError === true) {
    return { kind: "tool-error", message: first.text };
  }
  // Empty text is a valid no-op for tools that return nothing meaningful;
  // surface as an empty object rather than a parse error.
  if (first.text === "") {
    return { kind: "ok", value: {} };
  }
  try {
    return { kind: "ok", value: JSON.parse(first.text) };
  } catch (err) {
    return {
      kind: "parse-error",
      message: `tools/call text not JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

export class NeuralLinkAdapter implements NeuralLinkPort {
  private config: NeuralLinkConfig | null = null;
  private connected = false;
  private client: NeuralLinkRpcClient | null = null;

  async connect(config: NeuralLinkConfig): Promise<void> {
    if (!config.enabled) return;

    // Normalize the base URL so the adapter can confidently append
    // `/health` and `/mcp`. The shipped TOML and historical env vars
    // bake `/mcp` into the URL; without this normalize the health probe
    // hits `${url}/mcp/health` and 404s every time.
    const baseUrl = normalizeNeuralLinkBase(config.httpUrl);
    this.config = { ...config, httpUrl: baseUrl };

    // Health probe is bounded so a misconfigured httpUrl can't stall
    // kernel.start(). Logged loudly with the URL on failure so a typo
    // doesn't silently degrade to "running without coordination".
    try {
      const response = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      // Drain the body even on success — we only care about the status,
      // and an unread body counts as a leak in test runs and a connection
      // hold in production.
      await response.body?.cancel();
      if (!response.ok) {
        console.warn(
          `neural_link /health returned HTTP ${response.status} at ${baseUrl}/health — running without coordination`,
        );
        return;
      }
    } catch (err) {
      console.warn(
        `neural_link unreachable at ${baseUrl}/health (${
          err instanceof Error ? err.message : String(err)
        }) — running without coordination`,
      );
      return;
    }

    // Health is up — handshake. Failure here is also non-fatal: we log
    // and stay disconnected. The kernel's modes guard every call on
    // isConnected() and degrade gracefully.
    const client = new NeuralLinkRpcClient(baseUrl);
    try {
      await client.initialize();
    } catch (err) {
      console.warn(
        `neural_link initialize handshake failed at ${baseUrl}/mcp (${
          err instanceof Error ? err.message : String(err)
        }) — running without coordination`,
      );
      return;
    }
    this.client = client;
    this.connected = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getSessionId(): string | null {
    return this.client?.getSessionId() ?? null;
  }

  async roomOpen(params: RoomOpenParams): Promise<string | null> {
    if (!this.connected || !this.client) return null;

    const args: Record<string, unknown> = {
      title: params.title,
      participant_id: params.participantId,
      display_name: params.displayName,
    };
    // Only include optional fields when actually present — keeps the wire
    // payload minimal and lets neural_link's defaults apply server-side.
    if (params.id !== undefined) args.id = params.id;
    if (params.purpose !== undefined) args.purpose = params.purpose;
    if (params.externalRef !== undefined) {
      args.external_ref = params.externalRef;
    }
    if (params.tags !== undefined) args.tags = params.tags;
    if (params.brains !== undefined) args.brains = params.brains;
    if (params.interactionMode !== undefined) {
      args.interaction_mode = params.interactionMode;
    }

    const result = await this.client.callTool("room_open", args);
    if (!isObject(result)) return null;
    const roomId = result.room_id;
    return typeof roomId === "string" ? roomId : null;
  }

  async roomJoin(
    roomId: string,
    participantId: string,
    displayName: string,
    role = "member",
  ): Promise<boolean> {
    if (!this.connected || !this.client) return false;

    const result = await this.client.callTool("room_join", {
      room_id: roomId,
      participant_id: participantId,
      display_name: displayName,
      role,
    });
    return isObject(result) && result.joined === true;
  }

  async roomLeave(
    roomId: string,
    participantId: string,
    timeoutMs?: number,
  ): Promise<boolean> {
    if (!this.connected || !this.client) return false;

    const args: Record<string, unknown> = {
      room_id: roomId,
      participant_id: participantId,
    };
    // neural_link's tool schema declares timeout_ms as a string; encode
    // here so callers can keep using the natural `number` type.
    if (timeoutMs !== undefined) args.timeout_ms = String(timeoutMs);

    const result = await this.client.callTool("room_leave", args);
    // Pin to specific success tokens from handlers.gleam:572.
    // The real handler emits `status: "departed"` as the canonical success
    // signal; `left: true` is the legacy stub shape kept for backward compat.
    return isObject(result) &&
      (result.status === "departed" || result.left === true);
  }

  async messageSend(params: MessageSendParams): Promise<boolean> {
    if (!this.connected || !this.client) return false;

    const args: Record<string, unknown> = {
      room_id: params.roomId,
      from: params.from,
      kind: params.kind,
      summary: params.summary,
    };
    if (params.to !== undefined) args.to = params.to;
    if (params.body !== undefined) args.body = params.body;
    if (params.threadId !== undefined) args.thread_id = params.threadId;
    if (params.persistHint !== undefined) {
      args.persist_hint = params.persistHint;
    }

    const result = await this.client.callTool("message_send", args);
    // Pin to the real handler's success signal (handlers.gleam:644):
    // `message_id` as a string is the canonical success token.
    return isObject(result) && typeof result.message_id === "string";
  }

  async inboxRead(
    roomId: string,
    participantId: string,
  ): Promise<InboxMessage[]> {
    if (!this.connected || !this.client) return [];

    const result = await this.client.callTool("inbox_read", {
      room_id: roomId,
      participant_id: participantId,
    });
    // neural_link's inbox_read returns the raw array as the result, not
    // wrapped in `{messages: [...]}`.
    return Array.isArray(result) ? result as InboxMessage[] : [];
  }

  async messageAck(
    roomId: string,
    participantId: string,
    messageIds: string[],
  ): Promise<boolean> {
    if (!this.connected || !this.client) return false;

    const result = await this.client.callTool("message_ack", {
      room_id: roomId,
      participant_id: participantId,
      // neural_link's tool schema is comma-separated string, not array.
      message_ids: messageIds.join(","),
    });
    return isObject(result) && result.acked === true;
  }

  async roomClose(roomId: string, resolution: string): Promise<boolean> {
    if (!this.connected || !this.client) return false;

    const result = await this.client.callTool("room_close", {
      room_id: roomId,
      resolution,
    });
    // Pin to specific success tokens from handlers.gleam:907 region.
    // The real handler emits `status: "closed"` as the canonical success
    // signal; `closed: true` is the legacy stub shape kept for backward compat.
    return isObject(result) &&
      (result.status === "closed" || result.closed === true);
  }

  async waitFor(
    roomId: string,
    participantId: string,
    timeoutMs: number,
    kinds?: string[],
    from?: string[],
  ): Promise<WaitForMessage | null> {
    if (!this.connected || !this.client) return null;

    const args: Record<string, unknown> = {
      room_id: roomId,
      participant_id: participantId,
      timeout_ms: String(timeoutMs),
    };
    if (kinds && kinds.length > 0) args.kinds = kinds.join(",");
    if (from && from.length > 0) args.from = from.join(",");

    // waitFor legitimately blocks server-side up to 120 s. Apply a small
    // buffer above the server-side deadline so the client-side timeout
    // only fires if the server goes completely silent — not on normal
    // long-poll expiry.
    const result = await this.client.callTool(
      "wait_for",
      args,
      timeoutMs + 2_000,
    );
    if (!isObject(result)) return null;
    // neural_link returns the matched message directly (or signals "no
    // match" via a distinct shape — we treat any payload missing
    // `message_id` as "no match").
    if (typeof result.message_id !== "string") return null;
    return result as unknown as WaitForMessage;
  }

  async threadSummarize(
    roomId: string,
    threadId?: string,
  ): Promise<RoomSummary | null> {
    if (!this.connected || !this.client) return null;

    const args: Record<string, unknown> = { room_id: roomId };
    if (threadId !== undefined) args.thread_id = threadId;

    const result = await this.client.callTool("thread_summarize", args);
    if (!isObject(result)) return null;
    return result as unknown as RoomSummary;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

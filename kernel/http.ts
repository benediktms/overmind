import type { AcquireInput, LockRegistry } from "./locks.ts";

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB, matches the Unix socket cap.
const HARNESS_ENV_VAR = "OVERMIND_EDIT_HARNESS";
const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 8080;

export type EventSink = (event: unknown) => void | Promise<void>;

export interface HttpServerOptions {
  registry: LockRegistry;
  port?: number;
  hostname?: string;
  eventSink?: EventSink;
  harnessOn?: () => boolean;
}

interface ReleaseBody {
  path: string;
  taskId: string;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

/**
 * HTTP front for the kernel. Hosts /lock + /unlock against a LockRegistry and
 * accepts /event posts as a best-effort drop (matches the silent surface the
 * plugin's hook scripts already use). Localhost-only by default.
 */
export class OvermindHttpServer {
  private server: Deno.HttpServer<Deno.NetAddr> | null = null;
  private boundPort = 0;
  private readonly hostname: string;
  private readonly requestedPort: number;
  private readonly harnessOn: () => boolean;

  constructor(private readonly options: HttpServerOptions) {
    this.hostname = options.hostname ?? DEFAULT_HOSTNAME;
    this.requestedPort = options.port ?? DEFAULT_PORT;
    this.harnessOn = options.harnessOn ?? defaultHarnessOn;
  }

  start(): { port: number; hostname: string } {
    if (this.server) {
      throw new Error("OvermindHttpServer already started");
    }
    this.server = Deno.serve(
      {
        port: this.requestedPort,
        hostname: this.hostname,
        onListen: () => {},
      },
      (req) => this.handle(req),
    );
    this.boundPort = this.server.addr.port;
    return { port: this.boundPort, hostname: this.hostname };
  }

  async shutdown(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await server.shutdown();
  }

  port(): number {
    return this.boundPort;
  }

  private async handle(req: Request): Promise<Response> {
    // DNS-rebinding defense. Localhost HTTP services are reachable by any
    // browser tab via attacker-controlled domains that resolve to 127.0.0.1.
    // The Host header check rejects requests whose Host doesn't match the
    // bound address+port we're listening on.
    if (!this.isHostAllowed(req)) {
      await req.body?.cancel();
      return jsonResponse({ error: "forbidden" }, 403);
    }
    const url = new URL(req.url);
    if (req.method !== "POST") {
      await req.body?.cancel();
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    try {
      switch (url.pathname) {
        case "/lock":
          return await this.handleLock(req);
        case "/unlock":
          return await this.handleUnlock(req);
        case "/event":
          return await this.handleEvent(req);
        default:
          await req.body?.cancel();
          return jsonResponse({ error: "not_found" }, 404);
      }
    } catch (err) {
      if (err instanceof HttpError) {
        return jsonResponse({ error: err.code }, err.status);
      }
      // Log details server-side; never echo to the client. Avoids leaking
      // stack traces, file paths, and internal state to localhost callers.
      console.error("OvermindHttpServer handler error:", err);
      return jsonResponse({ error: "internal_error" }, 500);
    }
  }

  private isHostAllowed(req: Request): boolean {
    const host = req.headers.get("host");
    if (!host) return false;
    // Accept the bound port on either the literal IP or the localhost name.
    // Refuse anything else (e.g. attacker.example.com pointing to 127.0.0.1).
    const port = this.boundPort;
    const allowed = [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
    ];
    return allowed.includes(host);
  }

  private async handleLock(req: Request): Promise<Response> {
    if (!this.harnessOn()) {
      // Drain the body so the connection can close cleanly.
      await req.body?.cancel();
      return jsonResponse({ ok: true, harness: "off" });
    }
    const body = await readJsonBody(req);
    if (!isAcquireBody(body)) {
      return jsonResponse({ error: "invalid_body" }, 400);
    }
    const result = await this.options.registry.acquire(body);
    if (result.ok) return jsonResponse({ ok: true });
    return jsonResponse({ ok: false, holder: result.holder }, 409);
  }

  private async handleUnlock(req: Request): Promise<Response> {
    if (!this.harnessOn()) {
      await req.body?.cancel();
      return jsonResponse({ ok: true, harness: "off" });
    }
    const body = await readJsonBody(req);
    if (!isReleaseBody(body)) {
      return jsonResponse({ error: "invalid_body" }, 400);
    }
    const released = await this.options.registry.release(
      body.path,
      body.taskId,
    );
    if (!released) {
      return jsonResponse({ ok: false, error: "lock_held_by_other" }, 409);
    }
    return jsonResponse({ ok: true });
  }

  private async handleEvent(req: Request): Promise<Response> {
    let body: unknown = null;
    try {
      body = await readJsonBody(req);
    } catch {
      // /event is best-effort; never reject on payload errors.
      return jsonResponse({ ok: true });
    }
    if (this.options.eventSink) {
      try {
        await this.options.eventSink(body);
      } catch {
        // Sink errors are not surfaced; the event drop is best-effort.
      }
    }
    return jsonResponse({ ok: true });
  }
}

function defaultHarnessOn(): boolean {
  return Deno.env.get(HARNESS_ENV_VAR) === "1";
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // Defense-in-depth — POSTs with application/json already trigger CORS
      // preflight which lacks an Allow-Origin and so already fails in the
      // browser. The empty Allow-Origin makes that explicit and protects
      // future routes that might accept simple-CORS content types.
      "access-control-allow-origin": "null",
    },
  });
}

async function readJsonBody(req: Request): Promise<unknown> {
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "payload_too_large");
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released.
    }
  }
  if (total === 0) return null;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(merged));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

function isAcquireBody(value: unknown): value is AcquireInput {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return nonEmptyString(v.path) &&
    nonEmptyString(v.taskId) &&
    nonEmptyString(v.agentId) &&
    nonEmptyString(v.runId);
}

function isReleaseBody(value: unknown): value is ReleaseBody {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return nonEmptyString(v.path) && nonEmptyString(v.taskId);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

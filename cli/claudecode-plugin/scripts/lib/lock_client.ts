// Hook-side client for the kernel's `/lock` endpoint. Used by the PreToolUse
// enforcer to detect cross-agent file races in swarm/team runs.
//
// Contract (mirrors `src/plannings/edit-harness/lock-contract-redesign.md`):
//   - One-shot fetch, 300 ms hard cap. The PreToolUse hook itself has a 3 s
//     timeout in `cli/claudecode-plugin/hooks/hooks.json`; the lock check is
//     just one of several PreToolUse layers, so it must stay sub-second.
//   - Mode-gated: in `scout` and `relay` (single-writer modes) the call is
//     skipped before touching the network.
//   - Fail-open. Any non-409 path — timeout, network error, malformed body,
//     unexpected status — degrades to `kernel_unavailable`. The hook then
//     emits an `additionalContext` warning and lets the edit through. The
//     hash check (M1) and Bash bypass warning (M2) still apply; only the
//     cross-agent layer is offline.

export type Mode = "scout" | "relay" | "swarm" | "team" | string;

export interface TryAcquireInput {
  readonly url: string;
  readonly path: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly mode?: string;
  readonly timeoutMs?: number;
}

export interface LockHolder {
  readonly sessionId: string;
  readonly agentId: string;
}

export type TryAcquireResult =
  | { readonly status: "ok" }
  | { readonly status: "skipped" }
  | { readonly status: "conflict"; readonly holder: LockHolder }
  | { readonly status: "kernel_unavailable" };

const DEFAULT_TIMEOUT_MS = 300;

// Modes where only a single agent ever writes; the lock layer adds latency
// without adding safety. Anything outside this set runs the check, so a
// misconfigured `OVERMIND_MODE` errs on the safe side (do the check).
const SINGLE_WRITER_MODES: ReadonlySet<string> = new Set(["scout", "relay"]);

// SSRF guard. The kernel only listens on localhost; the hook should never
// post lock payloads anywhere else. An attacker who can poison the
// `OVERMIND_KERNEL_HTTP_URL` env var (e.g. via a malicious `.envrc` picked
// up by direnv in a cloned repo) would otherwise exfiltrate `path`,
// `sessionId`, and `agentId` to a remote target. Mirrors the kernel's own
// `isHostAllowed` check in `kernel/http.ts:118-130`.
const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
]);

function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return ALLOWED_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function shouldSkip(mode: string | undefined): boolean {
  if (!mode) return false;
  return SINGLE_WRITER_MODES.has(mode);
}

function parseHolder(value: unknown): LockHolder | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.sessionId !== "string" || v.sessionId.length === 0) return null;
  if (typeof v.agentId !== "string" || v.agentId.length === 0) return null;
  return { sessionId: v.sessionId, agentId: v.agentId };
}

export async function tryAcquire(
  input: TryAcquireInput,
): Promise<TryAcquireResult> {
  if (shouldSkip(input.mode)) return { status: "skipped" };

  // Refuse to talk to anything but localhost. A poisoned URL would otherwise
  // leak the lock payload (resolved file path + identity tuple) to a remote
  // target. Treated as `kernel_unavailable` so the hook fails open.
  if (!isLocalUrl(input.url)) return { status: "kernel_unavailable" };

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = `${input.url.replace(/\/$/, "")}/lock`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: input.path,
        sessionId: input.sessionId,
        agentId: input.agentId,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Timeout, DNS failure, connection refused, abort — every flavor of
    // "kernel didn't answer in time" lands here. Fail open.
    return { status: "kernel_unavailable" };
  }

  if (res.status === 200) {
    // Drain the body so the connection can close cleanly. We don't need the
    // payload; the status code is the answer.
    await res.body?.cancel();
    return { status: "ok" };
  }

  if (res.status === 409) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { status: "kernel_unavailable" };
    }
    if (!body || typeof body !== "object") {
      return { status: "kernel_unavailable" };
    }
    const holder = parseHolder((body as Record<string, unknown>).holder);
    if (!holder) return { status: "kernel_unavailable" };
    return { status: "conflict", holder };
  }

  // Anything else (500, 400, 404, harness-off-but-we-thought-it-was-on …)
  // is treated as "kernel can't answer right now" — fail open.
  await res.body?.cancel();
  return { status: "kernel_unavailable" };
}

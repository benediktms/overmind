#!/usr/bin/env -S deno run -A --quiet
/**
 * Overmind Pre-Tool Enforcer Hook
 * Pre-tool checks and safety enforcement.
 *
 * When `OVERMIND_EDIT_HARNESS=1`, also enforces the read-hash contract:
 * any `Edit` / `Write` whose target's current sha256 does not match the
 * sha256 captured at last `Read` is rejected with a structured stop reason.
 */

import { readStdin } from "./lib/stdin.ts";
import {
  type CacheEntry,
  computeSha256,
  enforceMaxBytes,
  getCachePath,
  getEntry,
  isTransientPath,
  loadCache,
  pruneStale,
  resolvePathSafely,
} from "./lib/read_hash_cache.ts";
import { isHarnessEnabled } from "./lib/harness_config.ts";
import { tryAcquire, type TryAcquireResult } from "./lib/lock_client.ts";

export { isHarnessEnabled };

export interface HookData {
  tool_name?: string;
  toolName?: string;
  tool_input?: Record<string, unknown>;
  toolInput?: Record<string, unknown>;
  cwd?: string;
  directory?: string;
  // CC's hook payload identity. Mirrors `post-tool-verifier.ts:35-37` and
  // the M1 hash-cache identity tuple. `agentId` (subagents) and `agent_type`
  // (some payload shapes) are equivalent — see `subagent-coordinator.ts`.
  session_id?: string;
  sessionId?: string;
  agentId?: string;
  agent_type?: string;
}

const DEFAULT_KERNEL_URL = "http://localhost:8080";

export type Decision =
  | { kind: "allow"; message?: string }
  | { kind: "deny"; reason: string };

// CC's file-mutating tools as of 2026. `Update` was added after `Edit`/`Write`
// — verified against a live CC session diff (Update(path) → Added/removed
// lines). `MultiEdit` is the legacy batched-edit tool; harmless if absent.
// Adding a name here that doesn't exist is a no-op (gate just never fires).
export const FILE_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "Update",
  "MultiEdit",
]);

function outputAllow(additionalContext?: string): void {
  const result: Record<string, unknown> = { continue: true };
  if (additionalContext) {
    result.hookSpecificOutput = {
      hookEventName: "PreToolUse",
      additionalContext,
    };
  } else {
    result.suppressOutput = true;
  }
  console.log(JSON.stringify(result));
}

function outputDeny(reason: string): void {
  console.log(JSON.stringify({ continue: false, stopReason: reason }));
}

export function evaluateBash(command: string): Decision {
  if (
    command.includes("rm -rf /") ||
    command.includes("rm -f /") ||
    command.includes(":(){ :|:& };:") ||
    command.includes("> /dev/sda")
  ) {
    return {
      kind: "allow",
      message:
        "[OVERMIND SAFETY] Dangerous command detected. Verify this is intentional before executing.",
    };
  }
  return { kind: "allow" };
}

// Quote-aware whitespace tokenizer. Single and double quotes balance and
// suppress whitespace splits inside them. Backslash-escaping is intentionally
// NOT handled — bash quoting is rich enough that a perfect parser would be
// its own module; we accept that exotic constructs may misparse and rely on
// the fail-open warn-not-block contract.
function tokenizeQuoteAware(s: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  for (const ch of s) {
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      buf += ch;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      buf += ch;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (buf) {
        tokens.push(buf);
        buf = "";
      }
      continue;
    }
    buf += ch;
  }
  if (buf) tokens.push(buf);
  return tokens;
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    return s.slice(1, -1);
  }
  return s;
}

// Split a command on top-level shell separators (|, ||, &, &&, ;) so that
// `sed -i ... file && other` doesn't pull tokens past the `&&`. Quote-aware.
function splitTopLevelSegments(command: string): string[] {
  const segments: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      buf += ch;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      buf += ch;
      continue;
    }
    if (!inSingle && !inDouble) {
      // Noclobber `>|` is a single redirect operator, not a pipe. Detect
      // by looking at the most recent non-whitespace char; if it's `>`,
      // keep the `|` attached to the buffer.
      if (ch === "|") {
        const prevNonSpace = buf.replace(/\s+$/, "");
        if (prevNonSpace.endsWith(">")) {
          buf += ch;
          continue;
        }
      }
      if (ch === "|" || ch === "&" || ch === ";") {
        if (buf.trim()) segments.push(buf);
        buf = "";
        // Skip the second char of "||" or "&&".
        if (command[i + 1] === ch) i++;
        continue;
      }
    }
    buf += ch;
  }
  if (buf.trim()) segments.push(buf);
  return segments;
}

// Redirect operator + path. Reused by parser to capture redirect targets and
// to strip redirects from segments before sed/awk file detection. The
// optional `\|` after `>{1,2}` matches the `>|` noclobber-override form.
// Also matches `>>|` (which is not valid bash) — harmless over-match per
// the fail-open warn-not-block contract.
const REDIRECT_RE =
  /(?:^|\s)(?:1|2|&)?>{1,2}\|?\s*("([^"]+)"|'([^']+)'|([^\s|;&<>()]+))/g;

function isSedExpressionLike(token: string): boolean {
  // Crude heuristic: sed substitution / transliteration / address forms.
  // Matches `s/x/y/`, `s|x|y|`, `y/abc/xyz/`, `1,$d`, `/regex/p`.
  if (/^[sy][/|]/.test(token)) return true;
  if (/^\d*[,;]/.test(token)) return true;
  if (token.startsWith("/") && token.endsWith("/p")) return true;
  return false;
}

function isDevNullLike(path: string): boolean {
  return path.startsWith("/dev/");
}

function tokenIsSedCommand(token: string): boolean {
  return token === "sed" || token.endsWith("/sed");
}

function tokenIsAwkCommand(token: string): boolean {
  return token === "awk" || token.endsWith("/awk");
}

// Parse a Bash command for tokens that look like file writes the harness
// won't see (sed -i, awk -i inplace, output redirection, tee). Permissive on
// purpose: we surface a warning, never block, so over-matching is preferred
// to under-matching. False positives are noisy; false negatives let stale
// writes through silently. Known limitations: no `bash -c '...'` recursion,
// no $() / backtick nesting tracking — both documented in ovr-396.23.1.
export function parseBashWriteCandidates(command: string): string[] {
  const found = new Set<string>();
  const addCandidate = (raw: string) => {
    const path = stripQuotes(raw);
    if (!path) return;
    if (isDevNullLike(path)) return;
    if (isSedExpressionLike(path)) return;
    found.add(path);
  };

  for (const segment of splitTopLevelSegments(command)) {
    // Strip redirect sequences before sed/awk file detection so that
    // `sed -i 'expr' file.txt > /dev/null` doesn't mis-pick `/dev/null`
    // as the sed file. Redirects are still captured separately below.
    const segmentNoRedir = segment.replace(REDIRECT_RE, "");
    const tokens = tokenizeQuoteAware(segmentNoRedir);

    // sed [-i|--in-place ...] <file>. Detection accepts `sed` or any
    // path ending in `/sed` (e.g., `/usr/bin/sed`).
    const sedIdx = tokens.findIndex(tokenIsSedCommand);
    if (sedIdx > -1) {
      const inPlaceIdx = tokens.findIndex((t, i) =>
        i > sedIdx && /^(?:-i\S*|--in-place\S*)$/.test(t)
      );
      if (inPlaceIdx > -1) {
        // Walk from the end; first token that is not a flag, not quoted,
        // and not sed-expression-like is the file.
        for (let i = tokens.length - 1; i > inPlaceIdx; i--) {
          const t = tokens[i];
          if (t.startsWith("-")) continue;
          if (t.startsWith("'") || t.startsWith('"')) continue;
          if (isSedExpressionLike(t)) continue;
          if (t) {
            addCandidate(t);
            break;
          }
        }
      }
    }

    // awk -i inplace 'PROGRAM' <file>
    const awkIdx = tokens.findIndex(tokenIsAwkCommand);
    if (
      awkIdx > -1 && tokens[awkIdx + 1] === "-i" &&
      tokens[awkIdx + 2] === "inplace"
    ) {
      for (let i = tokens.length - 1; i > awkIdx + 2; i--) {
        const t = tokens[i];
        if (t.startsWith("-")) continue;
        if (t.startsWith("'") || t.startsWith('"')) continue;
        if (t) {
          addCandidate(t);
          break;
        }
      }
    }

    // Output redirection. Match against the original segment (not stripped).
    for (const m of segment.matchAll(REDIRECT_RE)) {
      const candidate = m[2] ?? m[3] ?? m[4];
      if (candidate) addCandidate(candidate);
    }

    // tee [-a] <file> [<file> ...]
    const teeIdx = tokens.indexOf("tee");
    if (teeIdx > -1) {
      for (let i = teeIdx + 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.startsWith("-")) continue;
        if (t) addCandidate(t);
      }
    }
  }

  return Array.from(found);
}

export function evaluateEnvWrite(path: string): Decision {
  if (
    path.includes(".env") &&
    !path.includes(".env.example") &&
    !path.includes(".env.template")
  ) {
    return {
      kind: "allow",
      message:
        "[OVERMIND SAFETY] Writing to .env file. Ensure no secrets are exposed in the content.",
    };
  }
  return { kind: "allow" };
}

export interface StalenessInputs {
  toolName: string;
  filePath: string;
  currentSha: string | null;
  cachedEntry: CacheEntry | undefined;
  isTransient: boolean;
}

// Pure decision: given the tool name, current sha, and last-known cached
// sha, decide whether to allow the edit or deny with a stale-read reason.
//
// Fail-open by design. Every "I don't know enough" path returns `allow` —
// missing file, no cache entry yet, transient path, non-mutating tool. The
// harness is a defense-in-depth layer above CC's own read-before-edit
// enforcement; a corrupted/missing cache or unknown tool must NOT block
// edits, or it would be worse than no harness at all. Only an
// unambiguous mismatch between stored and current sha denies.
export function decideStaleness(input: StalenessInputs): Decision {
  if (!FILE_MUTATING_TOOLS.has(input.toolName)) {
    return { kind: "allow" };
  }
  if (!input.filePath) return { kind: "allow" };
  if (input.isTransient) return { kind: "allow" };
  if (input.currentSha === null) return { kind: "allow" }; // missing file — CC will surface
  if (!input.cachedEntry) return { kind: "allow" }; // never read this session
  if (input.cachedEntry.sha256 === input.currentSha) return { kind: "allow" };
  return {
    kind: "deny",
    reason:
      `Stale read detected. ${input.filePath} changed since you last read it. Re-read the file before editing.`,
  };
}

function extractFilePath(toolInput: Record<string, unknown> | string): string {
  if (typeof toolInput === "string") return toolInput;
  return (toolInput.file_path as string) ?? (toolInput.filePath as string) ??
    "";
}

export interface EvaluateOptions {
  home?: string;
  harnessOn?: boolean;
}

export async function evaluateHarness(
  data: HookData,
  opts: EvaluateOptions = {},
): Promise<Decision> {
  const harnessOn = opts.harnessOn ?? isHarnessEnabled();
  if (!harnessOn) return { kind: "allow" };

  const toolName = data.tool_name ?? data.toolName ?? "";
  if (!FILE_MUTATING_TOOLS.has(toolName)) return { kind: "allow" };

  const toolInput = data.tool_input ?? data.toolInput ?? {};
  const rawPath = extractFilePath(toolInput);
  if (!rawPath) return { kind: "allow" };

  const cwd = data.cwd ?? data.directory ?? Deno.cwd();
  const home = opts.home ?? Deno.env.get("HOME") ?? "/";
  const cachePath = getCachePath(cwd, home);
  const cacheDir = cachePath.substring(0, cachePath.lastIndexOf("/"));
  const filePath = await resolvePathSafely(rawPath, cwd);
  const cwdReal = await resolvePathSafely(cwd);

  if (isTransientPath(filePath, cacheDir, cwdReal)) return { kind: "allow" };

  // TOCTOU note: there is a small window between this sha256 read and CC's
  // actual Edit/Write apply. A concurrent writer could mutate the file in
  // that window. This is an inherent limitation of the hook approach
  // (Option B in edit-harness-spike.md); Option A (kernel-mediated tool)
  // would close it. Acceptable for M1.
  const cache = enforceMaxBytes(pruneStale(await loadCache(cachePath)));
  const cachedEntry = getEntry(cache, filePath);
  const currentSha = await computeSha256(filePath);

  return decideStaleness({
    toolName,
    filePath,
    currentSha,
    cachedEntry,
    isTransient: false,
  });
}

export interface LockClaimResult {
  readonly decision: Decision;
  // Surfaced when the kernel was unreachable / errored — main() prints it as
  // an `additionalContext` warning alongside any other message. Distinct from
  // `Decision.allow.message` so a deny path can still emit a nudge if needed.
  readonly warn?: string;
}

// Cross-agent lock check. Runs after the harness hash check passes for an
// Edit/Write/Update/MultiEdit. Posts to the kernel's /lock endpoint via the
// shared client; conflicts deny, errors fail open with a one-line warn.
// `OVERMIND_KERNEL_HTTP_URL` overrides the default; `OVERMIND_MODE` short-
// circuits the network call for scout/relay (single-writer).
export async function evaluateLockClaim(
  data: HookData,
  opts: EvaluateOptions & {
    env?: { get(key: string): string | undefined };
    fetcher?: typeof tryAcquire;
    // Injection seam for the identity-fallback log so tests can capture the
    // warn without spamming stderr. Defaults to `console.error` — stdout is
    // reserved for the JSON hook response.
    logger?: (message: string) => void;
  } = {},
): Promise<LockClaimResult> {
  const harnessOn = opts.harnessOn ?? isHarnessEnabled();
  if (!harnessOn) return { decision: { kind: "allow" } };

  const toolName = data.tool_name ?? data.toolName ?? "";
  if (!FILE_MUTATING_TOOLS.has(toolName)) {
    return { decision: { kind: "allow" } };
  }

  const toolInput = data.tool_input ?? data.toolInput ?? {};
  const rawPath = extractFilePath(toolInput);
  if (!rawPath) return { decision: { kind: "allow" } };

  const env = opts.env ?? Deno.env;
  const cwd = data.cwd ?? data.directory ?? Deno.cwd();
  const home = opts.home ?? env.get("HOME") ?? "/";
  const cachePath = getCachePath(cwd, home);
  const cacheDir = cachePath.substring(0, cachePath.lastIndexOf("/"));
  const filePath = await resolvePathSafely(rawPath, cwd);
  const cwdReal = await resolvePathSafely(cwd);

  // Mirror `evaluateHarness`: transient files (`/tmp`, `/var/folders/`, the
  // hash cache itself) are out of scope for the harness. Skipping them here
  // avoids a wasted localhost RTT and prevents two agents touching the same
  // /tmp scratch file from registering a spurious cross-agent conflict.
  if (isTransientPath(filePath, cacheDir, cwdReal)) {
    return { decision: { kind: "allow" } };
  }

  // Identity tuple: same fallbacks as the M1 hash cache so both layers fail
  // in the same direction. The redesign plan flags the fallback path as a
  // soft regression to "M1 only" — surface it on stderr so an operator can
  // see when the cross-agent guarantee silently degrades.
  const sessionIdRaw = data.session_id ?? data.sessionId;
  const agentIdRaw = data.agentId ?? data.agent_type;
  const sessionId = sessionIdRaw ?? "default";
  const agentId = agentIdRaw ?? "unknown";
  if (!sessionIdRaw || !agentIdRaw) {
    const log = opts.logger ?? ((m) => console.error(m));
    log(
      `[OVERMIND] Hook identity fallback: sessionId=${sessionId}, agentId=${agentId}. Cross-agent lock protection degraded.`,
    );
  }
  const url = env.get("OVERMIND_KERNEL_HTTP_URL") ?? DEFAULT_KERNEL_URL;
  const mode = env.get("OVERMIND_MODE");

  const acquire = opts.fetcher ?? tryAcquire;
  const result: TryAcquireResult = await acquire({
    url,
    path: filePath,
    sessionId,
    agentId,
    mode,
  });

  switch (result.status) {
    case "ok":
    case "skipped":
      return { decision: { kind: "allow" } };
    case "conflict":
      return {
        decision: {
          kind: "deny",
          reason:
            `File locked by agent ${result.holder.agentId} in session ${result.holder.sessionId}. Pick another file or wait.`,
        },
      };
    case "kernel_unavailable":
      return {
        decision: { kind: "allow" },
        warn:
          "[OVERMIND SAFETY] Lock check skipped: kernel unreachable. Cross-agent race protection is offline; the hash check still applies.",
      };
  }
}

// Warn (not block) when a Bash command appears to write to a path that's
// in the read-hash cache. The harness's PreToolUse hash check only sees
// Edit / Write; a `sed -i` or `>` redirect would silently bypass it. We
// surface a nudge so the agent knows to re-Read after.
export async function evaluateBashCacheBypass(
  command: string,
  data: HookData,
  opts: EvaluateOptions = {},
): Promise<Decision> {
  const harnessOn = opts.harnessOn ?? isHarnessEnabled();
  if (!harnessOn) return { kind: "allow" };
  if (!command) return { kind: "allow" };

  const candidates = parseBashWriteCandidates(command);
  if (candidates.length === 0) return { kind: "allow" };

  const cwd = data.cwd ?? data.directory ?? Deno.cwd();
  const home = opts.home ?? Deno.env.get("HOME") ?? "/";
  const cachePath = getCachePath(cwd, home);
  // Match evaluateHarness's pipeline (prune + cap) so a bloated cache file
  // doesn't blow up memory on the Bash check path.
  const cache = enforceMaxBytes(pruneStale(await loadCache(cachePath)));

  const hits: string[] = [];
  for (const raw of candidates) {
    const resolved = await resolvePathSafely(raw, cwd);
    if (getEntry(cache, resolved)) hits.push(raw);
  }
  if (hits.length === 0) return { kind: "allow" };

  const list = hits.map((p) => `\`${p}\``).join(", ");
  return {
    kind: "allow",
    message:
      `[OVERMIND SAFETY] Bash write detected on hash-cached path(s): ${list}. The edit harness won't see this; prefer Edit/Write, or Read the file again afterwards to refresh the cache.`,
  };
}

// Bash tool branch logic, extracted for testability. Precedence is fixed:
// dangerous-pattern message wins; cache-bypass nudge only fires when no
// danger note was emitted. Returns the message (or undefined for the silent
// allow path). The orchestrator never denies a Bash command — both checks
// are warn-only.
export async function handleBashTool(
  command: string,
  data: HookData,
  opts: EvaluateOptions = {},
): Promise<string | undefined> {
  const danger = evaluateBash(command);
  if (danger.kind === "allow" && danger.message) return danger.message;
  const bypass = await evaluateBashCacheBypass(command, data, opts);
  return bypass.kind === "allow" ? bypass.message : undefined;
}

async function main(): Promise<void> {
  const input = await readStdin();
  if (!input.trim()) {
    outputAllow();
    return;
  }

  let data: HookData = {};
  try {
    data = JSON.parse(input);
  } catch {
    outputAllow();
    return;
  }

  const harnessDecision = await evaluateHarness(data);
  if (harnessDecision.kind === "deny") {
    outputDeny(harnessDecision.reason);
    return;
  }

  // Cross-agent lock check (M4). Only fires for file-mutating tools and only
  // when the harness is on. Conflict denies; kernel-unavailable warns.
  const lockResult = await evaluateLockClaim(data);
  if (lockResult.decision.kind === "deny") {
    outputDeny(lockResult.decision.reason);
    return;
  }

  const toolName = data.tool_name ?? data.toolName ?? "";
  const toolInput = data.tool_input ?? data.toolInput ?? {};

  let message: string | undefined = lockResult.warn;

  switch (toolName) {
    case "Bash": {
      const command = typeof toolInput === "string"
        ? toolInput
        : (toolInput.command as string) ?? "";
      // Safe to overwrite: `evaluateLockClaim` only emits a warn for tools
      // in `FILE_MUTATING_TOOLS`, which excludes Bash. So `message` is
      // always undefined on entry to this branch. If Bash ever joins the
      // mutating set, switch to the newline-join pattern used by the
      // Edit/Write/Update/MultiEdit branch below.
      message = await handleBashTool(command, data);
      break;
    }

    case "Write":
    case "Edit":
    case "Update":
    case "MultiEdit": {
      const path = extractFilePath(toolInput);
      const envDecision = evaluateEnvWrite(path);
      if (envDecision.kind === "allow" && envDecision.message) {
        // Compose with any lock-check warn already in `message` so a
        // kernel-unreachable + .env-write combo surfaces both nudges.
        message = message
          ? `${message}\n${envDecision.message}`
          : envDecision.message;
      }
      break;
    }
  }

  outputAllow(message);
}

if (import.meta.main) main();

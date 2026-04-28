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

export interface HookData {
  tool_name?: string;
  toolName?: string;
  tool_input?: Record<string, unknown>;
  toolInput?: Record<string, unknown>;
  cwd?: string;
  directory?: string;
  session_id?: string;
  sessionId?: string;
}

export type Decision =
  | { kind: "allow"; message?: string }
  | { kind: "deny"; reason: string };

const HARNESS_ENV_VAR = "OVERMIND_EDIT_HARNESS";

export function isHarnessEnabled(env = Deno.env): boolean {
  return env.get(HARNESS_ENV_VAR) === "1";
}

function emitAllow(additionalContext?: string): void {
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

function emitDeny(reason: string): void {
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

export function decideStaleness(input: StalenessInputs): Decision {
  if (input.toolName !== "Edit" && input.toolName !== "Write") {
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
  if (toolName !== "Edit" && toolName !== "Write") return { kind: "allow" };

  const toolInput = data.tool_input ?? data.toolInput ?? {};
  const rawPath = extractFilePath(toolInput);
  if (!rawPath) return { kind: "allow" };

  const cwd = data.cwd ?? data.directory ?? Deno.cwd();
  const home = opts.home ?? Deno.env.get("HOME") ?? "/";
  const cachePath = getCachePath(cwd, home);
  const cacheDir = cachePath.substring(0, cachePath.lastIndexOf("/"));
  const filePath = await resolvePathSafely(rawPath);
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

async function main(): Promise<void> {
  const input = await readStdin();
  if (!input.trim()) {
    emitAllow();
    return;
  }

  let data: HookData = {};
  try {
    data = JSON.parse(input);
  } catch {
    emitAllow();
    return;
  }

  const harnessDecision = await evaluateHarness(data);
  if (harnessDecision.kind === "deny") {
    emitDeny(harnessDecision.reason);
    return;
  }

  const toolName = data.tool_name ?? data.toolName ?? "";
  const toolInput = data.tool_input ?? data.toolInput ?? {};

  let message: string | undefined;

  switch (toolName) {
    case "Bash": {
      const command = typeof toolInput === "string"
        ? toolInput
        : (toolInput.command as string) ?? "";
      const bashDecision = evaluateBash(command);
      if (bashDecision.kind === "allow") message = bashDecision.message;
      break;
    }

    case "Write":
    case "Edit": {
      const path = extractFilePath(toolInput);
      const envDecision = evaluateEnvWrite(path);
      if (envDecision.kind === "allow") message = envDecision.message;
      break;
    }
  }

  emitAllow(message);
}

if (import.meta.main) main();

#!/usr/bin/env -S deno run -A --quiet
/**
 * Overmind Post-Tool Verifier Hook
 * Tool output analysis, remember tags, brain sync
 */

import { readStdin } from "./lib/stdin.ts";
import {
  computeSha256,
  enforceMaxBytes,
  getCachePath,
  isTransientPath,
  loadCache,
  pruneStale,
  resolvePathSafely,
  saveCache,
  upsertEntry,
} from "./lib/read_hash_cache.ts";
import { isHarnessEnabled } from "./lib/harness_config.ts";
import type { BaseHookData } from "./lib/hook_data.ts";

export type { BaseHookData };

const OVERMIND_KERNEL_HTTP_URL = Deno.env.get("OVERMIND_KERNEL_HTTP_URL") ??
  "http://localhost:8080";

// PostToolUse-specific hook payload. Extends BaseHookData with tool output
// fields that are only present after a tool has executed.
export interface HookData extends BaseHookData {
  tool_response?: unknown;
  toolResponse?: unknown;
  tool_output?: unknown;
  toolOutput?: unknown;
}

export interface RefreshOptions {
  home?: string;
  harnessOn?: boolean;
}

const BASH_ERROR_PATTERNS = [
  /^error:/im,
  /permission denied/i,
  /command not found/i,
  /no such file or directory/i,
  /exit code: [1-9]/i,
  /exit status [1-9]/i,
  /^fatal:/im,
  /\baborted\b/i,
];

const WRITE_ERROR_PATTERNS = [
  /\berror:/i,
  /\bfailed to\b/i,
  /\bwrite failed\b/i,
  /\boperation failed\b/i,
  /permission denied/i,
  /read-only/i,
  /\bno such file\b/i,
  /\bdirectory not found\b/i,
];

export function detectBashFailure(output: string): boolean {
  return BASH_ERROR_PATTERNS.some((p) => p.test(output));
}

export function detectWriteFailure(output: string): boolean {
  return WRITE_ERROR_PATTERNS.some((p) => p.test(output));
}

function getToolOutputAsString(data: HookData): string {
  const raw = data.tool_response ?? data.toolResponse ?? data.tool_output ??
    data.toolOutput ?? "";
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

async function notifyKernel(
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await fetch(`${OVERMIND_KERNEL_HTTP_URL}/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event,
        data,
        timestamp: new Date().toISOString(),
      }),
    });
  } catch {
    // Kernel may not be running - silent
  }
}

export function processRememberTags(
  output: string,
): { priority: string[]; regular: string[] } {
  const priority: string[] = [];
  const regular: string[] = [];

  const priorityRegex = /<remember\s+priority>([\s\S]*?)<\/remember>/gi;
  let match;
  while ((match = priorityRegex.exec(output)) !== null) {
    const content = match[1].trim();
    if (content) priority.push(content);
  }

  const regularRegex = /<remember>([\s\S]*?)<\/remember>/gi;
  while ((match = regularRegex.exec(output)) !== null) {
    const content = match[1].trim();
    if (content) regular.push(content);
  }

  return { priority, regular };
}

export function generateMessage(
  toolName: string,
  toolOutput: string,
): string | undefined {
  switch (toolName) {
    case "Bash":
      if (detectBashFailure(toolOutput)) {
        return "Command failed. Please investigate the error and fix before continuing.";
      }
      break;

    case "Task":
    case "TaskCreate":
    case "TaskUpdate": {
      if (detectWriteFailure(toolOutput)) {
        return "Task delegation failed. Verify agent name and parameters.";
      }
      break;
    }

    case "Edit":
    case "Update":
    case "MultiEdit":
      if (detectWriteFailure(toolOutput)) {
        return "Edit operation failed. Verify file exists and content matches exactly.";
      }
      break;

    case "Write":
      if (detectWriteFailure(toolOutput)) {
        return "Write operation failed. Check file permissions and directory existence.";
      }
      break;

    case "TodoWrite":
      if (/created|added/i.test(toolOutput)) {
        return "Todo list updated. Proceed with next task on the list.";
      }
      if (/completed|done/i.test(toolOutput)) {
        return "Task marked complete. Continue with remaining todos.";
      }
      if (/in_progress/i.test(toolOutput)) {
        return "Task marked in progress. Focus on completing this task.";
      }
      break;

    case "Grep":
      if (/^0$|no matches/i.test(toolOutput)) {
        return "No matches found. Verify pattern syntax or try broader search.";
      }
      break;

    case "Glob":
      if (!toolOutput.trim() || /no files/i.test(toolOutput)) {
        return "No files matched pattern. Verify glob syntax and directory.";
      }
      break;
  }

  return undefined;
}

function outputHookResult(message?: string): void {
  const result: Record<string, unknown> = { continue: true };
  if (message) {
    result.hookSpecificOutput = {
      hookEventName: "PostToolUse",
      additionalContext: `[OVERMIND] ${message}`,
    };
  } else {
    result.suppressOutput = true;
  }
  console.log(JSON.stringify(result));
}

export async function refreshCacheIfApplicable(
  data: HookData,
  toolOutput: string,
  opts: RefreshOptions = {},
): Promise<void> {
  const harnessOn = opts.harnessOn ?? isHarnessEnabled();
  if (!harnessOn) return;
  const toolName = data.tool_name ?? data.toolName ?? "";
  // Cache-relevant tools: Read populates, Edit/Write/Update/MultiEdit refresh
  // after a successful mutation. Update was added to CC after Edit/Write —
  // missing it here would silently leave the cache stale post-Update.
  if (
    toolName !== "Read" && toolName !== "Edit" && toolName !== "Write" &&
    toolName !== "Update" && toolName !== "MultiEdit"
  ) {
    return;
  }
  if (detectWriteFailure(toolOutput)) return;

  const toolInput = data.tool_input ?? data.toolInput ?? {};
  const rawPath = (toolInput.file_path as string) ??
    (toolInput.filePath as string) ?? "";
  if (!rawPath) return;

  const cwd = data.cwd ?? data.directory ?? Deno.cwd();
  const home = opts.home ?? Deno.env.get("HOME") ?? "/";
  const sessionId = data.session_id ?? data.sessionId ?? "default";
  const cachePath = getCachePath(cwd, home);
  const cacheDir = cachePath.substring(0, cachePath.lastIndexOf("/"));
  const cwdReal = await resolvePathSafely(cwd);
  const filePath = await resolvePathSafely(rawPath, cwdReal);

  if (isTransientPath(filePath, cacheDir, cwdReal)) return;

  const sha = await computeSha256(filePath);
  if (sha === null) return;

  const existing = pruneStale(await loadCache(cachePath));
  const updated = enforceMaxBytes(
    upsertEntry(existing, filePath, sha, sessionId),
  );
  await saveCache(cachePath, updated);
}

async function main(): Promise<void> {
  const input = await readStdin();
  if (!input.trim()) {
    outputHookResult();
    return;
  }

  let data: HookData = {};
  try {
    data = JSON.parse(input);
  } catch {
    outputHookResult();
    return;
  }

  const toolName = data.tool_name ?? data.toolName ?? "";
  const toolOutput = getToolOutputAsString(data);
  const directory = data.cwd ?? data.directory ?? Deno.cwd();
  const sessionId = data.session_id ?? data.sessionId ?? "unknown";

  // Cache refresh runs before remember-tag handling so a slow kernel POST
  // never blocks a hash-cache update.
  await refreshCacheIfApplicable(data, toolOutput);

  // Process remember tags and sync to kernel
  const { priority, regular } = processRememberTags(toolOutput);
  if (priority.length > 0 || regular.length > 0) {
    await notifyKernel("remember_tags", {
      priority,
      regular,
      directory,
      sessionId,
    });
  }

  // Generate contextual message
  const message = generateMessage(toolName, toolOutput);
  outputHookResult(message);
}

if (import.meta.main) main();

#!/usr/bin/env -S deno run -A --quiet
/**
 * Overmind Post-Tool Use Failure Hook
 * Handles tool execution failures
 */

import { readStdin } from "./lib/stdin.ts";

const OVERMIND_KERNEL_HTTP_URL =
  Deno.env.get("OVERMIND_KERNEL_HTTP_URL") ?? "http://localhost:8080";

interface HookData {
  tool_name?: string;
  toolName?: string;
  tool_error?: string;
  toolError?: string;
  tool_input?: Record<string, unknown>;
  toolInput?: Record<string, unknown>;
  cwd?: string;
  directory?: string;
  session_id?: string;
  sessionId?: string;
}

async function notifyKernel(
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await fetch(`${OVERMIND_KERNEL_HTTP_URL}/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, data, timestamp: new Date().toISOString() }),
    });
  } catch {
    // Kernel may not be running - silent
  }
}

function outputHookResult(additionalContext?: string): void {
  const result: Record<string, unknown> = { continue: true };
  if (additionalContext) {
    result.hookSpecificOutput = {
      hookEventName: "PostToolUseFailure",
      additionalContext,
    };
  } else {
    result.suppressOutput = true;
  }
  console.log(JSON.stringify(result));
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

  const toolName = data.tool_name ?? data.toolName ?? "unknown";
  const error = data.tool_error ?? data.toolError ?? "unknown error";
  const directory = data.cwd ?? data.directory ?? Deno.cwd();
  const sessionId = data.session_id ?? data.sessionId ?? "unknown";

  // Notify kernel of tool failure
  await notifyKernel("tool_failure", {
    toolName,
    error,
    directory,
    sessionId,
    timestamp: new Date().toISOString(),
  });

  // Generate helpful message based on tool type
  let message: string | undefined;
  switch (toolName) {
    case "Bash":
      message =
        "[OVERMIND] Command failed. Check the error output, fix the issue, and retry.";
      break;
    case "Read":
    case "Glob":
    case "Grep":
      message =
        "[OVERMIND] File operation failed. Verify the file exists and path is correct.";
      break;
    case "Edit":
    case "Write":
      message =
        "[OVERMIND] Write/edit failed. Check file permissions and try again.";
      break;
    case "Task":
    case "TaskCreate":
      message =
        "[OVERMIND] Task operation failed. Verify agent configuration and parameters.";
      break;
    default:
      message = `[OVERMIND] Tool "${toolName}" failed: ${error}`;
  }

  outputHookResult(message);
}

main();

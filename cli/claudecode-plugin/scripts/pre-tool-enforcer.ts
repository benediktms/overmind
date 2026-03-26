#!/usr/bin/env -S deno run -A --quiet
/**
 * Overmind Pre-Tool Enforcer Hook
 * Pre-tool checks and safety enforcement
 */

import { readStdin } from "./lib/stdin.ts";

interface HookData {
  tool_name?: string;
  toolName?: string;
  tool_input?: Record<string, unknown>;
  toolInput?: Record<string, unknown>;
}

function outputHookResult(additionalContext?: string): void {
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
  const toolInput = data.tool_input ?? data.toolInput ?? {};

  let additionalContext: string | undefined;

  switch (toolName) {
    case "Bash": {
      const command =
        typeof toolInput === "string"
          ? toolInput
          : (toolInput.command as string) ?? "";
      if (
        command.includes("rm -rf /") ||
        command.includes("rm -f /") ||
        command.includes(":(){ :|:& };:") ||
        command.includes("> /dev/sda")
      ) {
        additionalContext =
          "[OVERMIND SAFETY] Dangerous command detected. Verify this is intentional before executing.";
      }
      break;
    }

    case "Write":
    case "Edit": {
      const path =
        typeof toolInput === "string"
          ? toolInput
          : (toolInput.file_path as string) ?? (toolInput.filePath as string) ?? "";
      if (
        path.includes(".env") &&
        !path.includes(".env.example") &&
        !path.includes(".env.template")
      ) {
        additionalContext =
          "[OVERMIND SAFETY] Writing to .env file. Ensure no secrets are exposed in the content.";
      }
      break;
    }

    default:
      break;
  }

  outputHookResult(additionalContext);
}

main();

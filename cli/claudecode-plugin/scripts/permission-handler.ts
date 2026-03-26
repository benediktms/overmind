#!/usr/bin/env -S deno run -A --quiet
/**
 * Overmind Permission Handler Hook
 * Bash permission handling
 */

import { readStdin } from "./lib/stdin.ts";

interface HookData {
  tool_name?: string;
  toolName?: string;
  permission?: string;
  command?: string;
}

function outputHookResult(additionalContext?: string): void {
  const result: Record<string, unknown> = { continue: true };
  if (additionalContext) {
    result.hookSpecificOutput = {
      hookEventName: "PermissionRequest",
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

  const permission = data.permission ?? "Bash";
  const command = data.command ?? "";

  // Add context about Overmind's coordination
  const additionalContext =
    `[OVERMIND] Executing: ${command.slice(0, 100)}${command.length > 100 ? "..." : ""}`;

  outputHookResult(additionalContext);
}

main();

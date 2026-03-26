#!/usr/bin/env -S deno run -A --quiet
/**
 * Overmind Context Safety Hook (ExitPlanMode)
 * Safety checks when exiting plan mode
 */

import { readStdin } from "./lib/stdin.ts";

interface HookData {
  cwd?: string;
  directory?: string;
  session_id?: string;
  sessionId?: string;
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
  let data: HookData = {};
  try {
    data = JSON.parse(input);
  } catch {
    outputHookResult();
    return;
  }

  const directory = data.cwd ?? data.directory ?? Deno.cwd();

  // Check if Overmind modes are active
  let activeMode: string | undefined;
  try {
    const statePath = `${directory}/.overmind/state`;
    for await (const entry of Deno.readDir(statePath)) {
      if (entry.isFile && entry.name.endsWith("-state.json")) {
        const content = await Deno.readTextFile(`${statePath}/${entry.name}`);
        const state = JSON.parse(content);
        if (state.active) {
          activeMode = entry.name.replace("-state.json", "");
          break;
        }
      }
    }
  } catch {
    // No state
  }

  if (activeMode) {
    outputHookResult(
      `[OVERMIND ${activeMode.toUpperCase()} MODE ACTIVE] ` +
        `You are about to exit plan mode. ` +
        `Execute the ${activeMode} plan through the proper workflow.`,
    );
  } else {
    outputHookResult();
  }
}

main();

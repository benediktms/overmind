#!/usr/bin/env -S deno run -A --quiet
/**
 * Overmind Context Safety Hook (ExitPlanMode)
 * Safety checks when exiting plan mode
 */

import { readStdin } from "./lib/stdin.ts";
import { readActiveModeState } from "../../../kernel/persistence.ts";

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

  const activeState = await readActiveModeState(directory);

  if (activeState?.active) {
    const persistenceMode = activeState.persistence.brain.available
      ? "Brain-backed durability active"
      : "local-only degraded persistence";
    outputHookResult(
      `[OVERMIND ${activeState.mode.toUpperCase()} MODE ACTIVE] ` +
        `You are about to exit plan mode. ` +
        `Execute the ${activeState.mode} plan through the proper workflow. ` +
        `${persistenceMode}.`,
    );
  } else {
    outputHookResult();
  }
}

main();

#!/usr/bin/env -S deno run -A --quiet
/**
 * Overmind Setup Init Hook
 * First-run initialization
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
      hookEventName: "SessionStart",
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

  // Create .overmind/state directory
  try {
    await Deno.mkdir(`${directory}/.overmind/state`, { recursive: true });
  } catch {
    // Directory may already exist
  }

  outputHookResult(
    `[OVERMIND] Initialized. Overmind orchestration is active.\n` +
      `Use scout/relay/swarm keywords to activate coordination modes.`,
  );
}

main();

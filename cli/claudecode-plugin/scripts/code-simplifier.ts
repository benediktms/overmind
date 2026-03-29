#!/usr/bin/env -S deno run -A --quiet
/**
 * Overmind Code Simplifier Hook
 * Context simplification suggestions before stop
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
      hookEventName: "Stop",
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

  // Check for incomplete work that needs summarization
  const messages: string[] = [];

  const activeState = await readActiveModeState(directory);
  if (activeState?.active && activeState.original_prompt) {
    const resumeHint = activeState.persistence.brain.available
      ? "Brain checkpointing is active for resume support."
      : "Local-only fallback is active; preserve a concise summary before exiting.";
    messages.push(
      `[OVERMIND ${activeState.mode.toUpperCase()} MODE]` +
        `\n  Task: ${activeState.original_prompt}` +
        `\n  ${resumeHint}`,
    );
  }

  if (messages.length > 0) {
    outputHookResult(
      `[OVERMIND STOP HOOK]\n\nBefore ending, consider:\n${messages.join("\n\n")}\n\nUse brain records to persist state for next session.`,
    );
  } else {
    outputHookResult();
  }
}

main();

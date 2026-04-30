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

function outputHookResult(systemMessage?: string): void {
  const result: Record<string, unknown> = { continue: true };
  if (systemMessage) {
    result.systemMessage = systemMessage;
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
  const sessionId = data.session_id ?? data.sessionId ?? "";

  // Check for incomplete work that needs summarization
  const messages: string[] = [];

  // Scope to this session: don't surface another session's in-flight
  // run as if the user about to stop owns it. See readActiveModeState
  // doc-comment for the missing-session_id backwards-compat behaviour.
  const activeState = await readActiveModeState(
    directory,
    sessionId || undefined,
  );
  if (activeState?.active && activeState.original_prompt) {
    const resumeHint = activeState.persistence.brain.available
      ? "Brain checkpointing is active for resume support."
      : "Local-only fallback is active; preserve a concise summary before exiting.";
    const firstLine = activeState.original_prompt.split("\n", 1)[0].trim();
    const taskSummary = firstLine.length > 160
      ? `${firstLine.slice(0, 157)}...`
      : firstLine;
    messages.push(
      `[OVERMIND ${activeState.mode.toUpperCase()} MODE]` +
        `\n  Task: ${taskSummary}` +
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

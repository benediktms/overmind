#!/usr/bin/env -S deno run -A --quiet
/**
 * Overmind Code Simplifier Hook
 * Context simplification suggestions before stop
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

  try {
    const statePath = `${directory}/.overmind/state`;
    for await (const entry of Deno.readDir(statePath)) {
      if (entry.isFile && entry.name.endsWith("-state.json")) {
        const content = await Deno.readTextFile(`${statePath}/${entry.name}`);
        const state = JSON.parse(content);
        if (state.active && state.original_prompt) {
          const modeName = entry.name.replace("-state.json", "");
          messages.push(
            `[OVERMIND ${modeName.toUpperCase()} MODE]` +
              `\n  Task: ${state.original_prompt}` +
              `\n  Consider: Use brain to record progress and resume next session.`,
          );
        }
      }
    }
  } catch {
    // No state files
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

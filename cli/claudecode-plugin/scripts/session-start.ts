#!/usr/bin/env -S deno run -A --quiet
/**
 * Overmind Session Start Hook
 * Restores active modes, checks version, notifies kernel
 */

import { readStdin } from "./lib/stdin.ts";

const OVERMIND_PLUGIN_ROOT = Deno.env.get("OVERMIND_PLUGIN_ROOT") ?? "";
const OVERMIND_KERNEL_HTTP_URL = Deno.env.get("OVERMIND_KERNEL_HTTP_URL") ?? "http://localhost:8080";

interface HookData {
  cwd?: string;
  directory?: string;
  session_id?: string;
  sessionId?: string;
}

async function notifyKernel(event: string, data: Record<string, unknown>): Promise<void> {
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
  const sessionId = data.session_id ?? data.sessionId ?? "";
  const messages: string[] = [];

  // Notify kernel of session start
  await notifyKernel("session_start", {
    directory,
    sessionId,
    timestamp: new Date().toISOString(),
  });

  // Check for active Overmind modes from state files
  const statePath = `${directory}/.overmind/state`;
  try {
    const stateDir = new URL(`file://${statePath}`);
    for await (const entry of Deno.readDir(stateDir)) {
      if (entry.isFile && entry.name.endsWith("-state.json")) {
        const content = await Deno.readTextFile(`${statePath}/${entry.name}`);
        const state = JSON.parse(content);
        if (state.active) {
          const modeName = entry.name.replace("-state.json", "");
          messages.push(
            `[OVERMIND ${modeName.toUpperCase()} MODE RESTORED]\n` +
            `Active since: ${state.started_at}\n` +
            `Original task: ${state.original_prompt ?? "unknown"}\n`
          );
        }
      }
    }
  } catch {
    // No state directory yet - fresh session
  }

  if (messages.length > 0) {
    outputHookResult(
      `<session-restore>\n\n${messages.join("\n\n")}\n</session-restore>\n`
    );
  } else {
    outputHookResult();
  }
}

main();

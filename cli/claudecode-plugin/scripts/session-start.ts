#!/usr/bin/env -S deno run -A --quiet
/**
 * Overmind Session Start Hook
 * Restores active modes, checks version, notifies kernel
 */

import { readStdin } from "./lib/stdin.ts";
import { readActiveModeState } from "../../../kernel/persistence.ts";

const CLAUDE_PLUGIN_ROOT = Deno.env.get("CLAUDE_PLUGIN_ROOT") ?? "";
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

  // Scope active-state lookup to this session: only restore state
  // for runs originated by THIS Claude Code session, not for runs from
  // a different session that happens to share the workspace. Pre-upgrade
  // state files without session_id are still surfaced (treated as
  // "global") so existing in-flight runs aren't silently dropped.
  const activeState = await readActiveModeState(
    directory,
    sessionId || undefined,
  );
  if (activeState?.active) {
    const persistenceLine = activeState.persistence.brain.available
      ? `Persistence: Brain checkpointing active (${activeState.persistence.brain.brainName})`
      : `Persistence: local-only fallback (${activeState.persistence.brain.status})`;

    const prompt = activeState.original_prompt ?? "";
    const firstLine = prompt.split("\n", 1)[0].trim();
    const taskSummary = firstLine.length > 160
      ? `${firstLine.slice(0, 157)}...`
      : (firstLine || "unknown");

    messages.push(
      `[OVERMIND ${activeState.mode.toUpperCase()} MODE RESTORED]\n` +
      `Active since: ${activeState.started_at}\n` +
      `Original task: ${taskSummary}\n` +
      `${persistenceLine}\n`,
    );
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

#!/usr/bin/env -S deno run -A --quiet
/**
 * Overmind TeammateIdle Hook
 * Fires when a teammate is about to go idle in agent-team mode.
 * Requires CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 to be active.
 *
 * TODO(ovr-396.23.13.1): add real quality gates (e.g. verify teammate left
 *   no blocking tasks open, emit a neural_link finding, etc.)
 */

import { readStdin } from "./lib/stdin.ts";

const AGENT_TEAMS_ENABLED =
  Deno.env.get("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS") === "1";

export interface TeammateIdlePayload {
  teammate_id?: string;
  teammateId?: string;
  session_id?: string;
  sessionId?: string;
  reason?: string;
}

export function parsePayload(raw: string): TeammateIdlePayload {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function buildSummary(payload: TeammateIdlePayload): string {
  const id = payload.teammate_id ?? payload.teammateId ?? "unknown";
  const reason = payload.reason ?? "no reason given";
  return `[TeammateIdle] teammate=${id} reason="${reason}"`;
}

function outputPassThrough(): void {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

async function main(): Promise<void> {
  if (!AGENT_TEAMS_ENABLED) {
    outputPassThrough();
    return;
  }

  const raw = await readStdin();
  const payload = parsePayload(raw);
  const summary = buildSummary(payload);
  console.error(summary);
  outputPassThrough();
}

if (import.meta.main) main();

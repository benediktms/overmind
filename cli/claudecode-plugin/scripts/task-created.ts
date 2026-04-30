#!/usr/bin/env -S deno run -A --quiet
/**
 * Overmind TaskCreated Hook
 * Fires when a task is being created on the shared task list in agent-team mode.
 * Requires CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 to be active.
 *
 * TODO(ovr-396.23.13.2): add real quality gates (e.g. reject tasks with no
 *   description, enforce title length, validate required labels, etc.)
 */

import { readStdin } from "./lib/stdin.ts";

const AGENT_TEAMS_ENABLED =
  Deno.env.get("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS") === "1";

export interface TaskCreatedPayload {
  task_id?: string;
  taskId?: string;
  title?: string;
  description?: string;
  session_id?: string;
  sessionId?: string;
}

export function parsePayload(raw: string): TaskCreatedPayload {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function buildSummary(payload: TaskCreatedPayload): string {
  const id = payload.task_id ?? payload.taskId ?? "unknown";
  const title = payload.title ?? "(no title)";
  return `[TaskCreated] task_id=${id} title="${title}"`;
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

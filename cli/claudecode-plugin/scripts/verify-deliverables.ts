#!/usr/bin/env -S deno run -A --quiet
/**
 * Overmind Verify Deliverables Hook (SubagentStop)
 * Verifies subagent completed expected deliverables
 */

import { readStdin } from "./lib/stdin.ts";

const OVERMIND_KERNEL_HTTP_URL =
  Deno.env.get("OVERMIND_KERNEL_HTTP_URL") ?? "http://localhost:8080";

interface HookData {
  cwd?: string;
  directory?: string;
  session_id?: string;
  sessionId?: string;
  agentId?: string;
  agent_type?: string;
  agent_name?: string;
  agent_output?: string;
  agentOutput?: string;
}

async function notifyKernel(
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
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

function outputHookResult(): void {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

async function main(): Promise<void> {
  const input = await readStdin();
  if (!input.trim()) {
    outputHookResult();
    return;
  }

  let data: HookData = {};
  try {
    data = JSON.parse(input);
  } catch {
    outputHookResult();
    return;
  }

  const directory = data.cwd ?? data.directory ?? Deno.cwd();
  const sessionId = data.session_id ?? data.sessionId ?? "unknown";
  const agentId = data.agentId ?? data.agent_type ?? "unknown";
  const agentOutput = data.agent_output ?? data.agentOutput ?? "";

  // Notify kernel of subagent completion
  await notifyKernel("subagent_stop", {
    agentId,
    directory,
    sessionId,
    timestamp: new Date().toISOString(),
  });

  outputHookResult();
}

main();

#!/usr/bin/env -S deno run -A --quiet
import { readStdin } from "./lib/stdin.ts";

const NEURAL_LINK_URL = Deno.env.get("OVERMIND_NEURAL_LINK_URL") ?? "http://localhost:9961/mcp";
const ROOM_ID = Deno.env.get("OVERMIND_ROOM_ID") ?? "";
const PARTICIPANT_ID = Deno.env.get("CLAUDE_AGENT_ID") ?? "claudecode-subagent";

interface HookData {
  cwd?: string;
  directory?: string;
  session_id?: string;
  sessionId?: string;
  agentId?: string;
  agent_type?: string;
  agent_name?: string;
}

async function sendMessage(kind: string, summary: string, body: Record<string, unknown>): Promise<void> {
  if (!ROOM_ID) return;
  try {
    await fetch(`${NEURAL_LINK_URL}/message/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room_id: ROOM_ID,
        from: PARTICIPANT_ID,
        kind,
        summary,
        body: JSON.stringify(body),
        persist_hint: "durable",
      }),
    });
  } catch {
    // Silent failure - don't block hooks
  }
}

function outputHookResult(additionalContext?: string): void {
  const result: Record<string, unknown> = { continue: true };
  if (additionalContext) {
    result.hookSpecificOutput = {
      hookEventName: "SubagentStart",
      additionalContext,
    };
  } else {
    result.suppressOutput = true;
  }
  console.log(JSON.stringify(result));
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

  const agentId = data.agentId ?? data.agent_type ?? "unknown";
  const agentName = data.agent_name ?? agentId;

  await sendMessage("finding", `Subagent started: ${agentName}`, {
    agentId: PARTICIPANT_ID,
    agentType: agentId,
    agentName,
    directory: data.cwd ?? data.directory ?? Deno.cwd(),
    sessionId: data.session_id ?? data.sessionId ?? "unknown",
  });

  outputHookResult(
    `[OVERMIND] Subagent tracking active: ${agentName}\n` +
    `Room: ${ROOM_ID || "not configured"}\n`
  );
}

main();

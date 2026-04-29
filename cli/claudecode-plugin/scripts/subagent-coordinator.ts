#!/usr/bin/env -S deno run -A --quiet
import { readStdin } from "./lib/stdin.ts";

const NEURAL_LINK_URL = Deno.env.get("OVERMIND_NEURAL_LINK_URL") ?? "http://localhost:9961/mcp";
const ROOM_ID = Deno.env.get("OVERMIND_ROOM_ID") ?? "";
const PARTICIPANT_ID = Deno.env.get("CLAUDE_AGENT_ID") ?? "claudecode-subagent";

export interface HookData {
  cwd?: string;
  directory?: string;
  session_id?: string;
  sessionId?: string;
  agentId?: string;
  agent_type?: string;
  agent_name?: string;
}

export interface CoordinatorAction {
  messageKind: "finding" | "handoff";
  summary: string;
  hookEventName: string;
  contextPrefix: string;
}

export function buildCoordinatorAction(action: string, agentName: string): CoordinatorAction {
  if (action === "stop") {
    return {
      messageKind: "handoff",
      summary: `Subagent completed: ${agentName}`,
      hookEventName: "SubagentStop",
      contextPrefix: `[OVERMIND] Subagent completed: ${agentName}`,
    };
  }
  return {
    messageKind: "finding",
    summary: `Subagent started: ${agentName}`,
    hookEventName: "SubagentStart",
    contextPrefix: `[OVERMIND] Subagent tracking active: ${agentName}`,
  };
}

export function resolveAgentInfo(data: HookData): { agentId: string; agentName: string } {
  const agentId = data.agentId ?? data.agent_type ?? "unknown";
  const agentName = data.agent_name ?? agentId;
  return { agentId, agentName };
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

function outputHookResult(systemMessage?: string, _eventName = "SubagentStart"): void {
  const result: Record<string, unknown> = { continue: true };
  if (systemMessage) {
    result.systemMessage = systemMessage;
  } else {
    result.suppressOutput = true;
  }
  console.log(JSON.stringify(result));
}

async function main(): Promise<void> {
  const action = Deno.args[0] ?? "start";
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

  const { agentId, agentName } = resolveAgentInfo(data);
  const directory = data.cwd ?? data.directory ?? Deno.cwd();
  const sessionId = data.session_id ?? data.sessionId ?? "unknown";
  const coordAction = buildCoordinatorAction(action, agentName);

  await sendMessage(coordAction.messageKind, coordAction.summary, {
    agentId: PARTICIPANT_ID,
    agentType: agentId,
    agentName,
    directory,
    sessionId,
  });
  outputHookResult(
    `${coordAction.contextPrefix}\nRoom: ${ROOM_ID || "not configured"}\n`,
    coordAction.hookEventName,
  );
}

if (import.meta.main) main();

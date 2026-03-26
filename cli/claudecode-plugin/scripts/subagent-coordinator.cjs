const NEURAL_LINK_URL = process.env.OVERMIND_NEURAL_LINK_URL ?? "http://localhost:9961/mcp";
const ROOM_ID = process.env.OVERMIND_ROOM_ID ?? "";
const PARTICIPANT_ID = process.env.CLAUDE_AGENT_ID ?? "claudecode-subagent";

async function sendMessage(kind, summary, body) {
  if (!ROOM_ID) return;
  await fetch(`${NEURAL_LINK_URL}/message/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room_id: ROOM_ID, from: PARTICIPANT_ID, kind, summary, body: JSON.stringify(body), persist_hint: "durable" }),
  });
}

const command = process.argv[2];
if (command === "start") {
  await sendMessage("finding", "Subagent started", { agentId: PARTICIPANT_ID });
} else if (command === "stop") {
  await sendMessage("handoff", "Subagent completed", { agentId: PARTICIPANT_ID });
}

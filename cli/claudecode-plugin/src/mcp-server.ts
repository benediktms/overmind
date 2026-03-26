import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const NEURAL_LINK_URL = process.env.OVERMIND_NEURAL_LINK_URL ?? "http://localhost:9961/mcp";
const ROOM_ID = process.env.OVERMIND_ROOM_ID ?? "";
const PARTICIPANT_ID = process.env.OVERMIND_PARTICIPANT_ID ?? "claudecode";

interface ToolArg { objective?: string; mode?: string; context?: Record<string, string> }

async function sendToOvermind(kind: string, body: unknown): Promise<boolean> {
  if (!ROOM_ID) return false;
  try {
    const resp = await fetch(`${NEURAL_LINK_URL}/message/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room_id: ROOM_ID, from: PARTICIPANT_ID, kind, summary: "Claude Code", body: JSON.stringify(body), persist_hint: "durable" }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

const server = new Server(
  { name: "overmind-claudecode", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "overmind_delegate",
      description: "Delegate work to Overmind swarm coordinator",
      inputSchema: {
        type: "object",
        properties: {
          objective: { type: "string", description: "The objective to delegate" },
          mode: { type: "string", enum: ["scout", "relay", "swarm"], default: "scout" },
        },
        required: ["objective"],
      },
    },
    {
      name: "overmind_status",
      description: "Get Overmind swarm status",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const { objective, mode, context } = args as ToolArg;

  if (name === "overmind_delegate") {
    const ok = await sendToOvermind("proposal", { objective, mode: mode ?? "scout" });
    return { content: [{ type: "text", text: JSON.stringify({ success: ok }) }] };
  }

  if (name === "overmind_status") {
    return { content: [{ type: "text", text: JSON.stringify({ configured: !!ROOM_ID, roomId: ROOM_ID }) }] };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
});

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);

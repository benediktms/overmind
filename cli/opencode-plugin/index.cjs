/**
 * Overmind OpenCode Plugin
 *
 * Provides overmind_delegate tool for OpenCode, sending work to the Overmind swarm
 * via neural_link HTTP API.
 */

"use strict";

const NEURAL_LINK_URL = process.env.OVERMIND_NEURAL_LINK_URL || "http://localhost:9961/mcp";
const ROOM_ID = process.env.OVERMIND_ROOM_ID || "";
const PARTICIPANT_ID = process.env.OVERMIND_PARTICIPANT_ID || "opencode";

async function sendToOvermind(kind, body) {
  if (!ROOM_ID) {
    // Try to open a room first
    try {
      const openResp = await fetch(`${NEURAL_LINK_URL}/room/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `overmind-${Date.now()}`,
          participant_id: PARTICIPANT_ID,
          display_name: "OpenCode",
          purpose: "Overmind swarm coordination",
        }),
      });

      if (!openResp.ok) {
        return { success: false, error: "neural_link not available" };
      }

      const openData = await openResp.json();
      const newRoomId = openData.room_id;
      const sessionId = openData.session_id || null;

      const sendResp = await fetch(`${NEURAL_LINK_URL}/message/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
        },
        body: JSON.stringify({
          room_id: newRoomId,
          from: PARTICIPANT_ID,
          kind,
          summary: "OpenCode message",
          body: JSON.stringify(body),
          persist_hint: "durable",
        }),
      });

      return sendResp.ok ? { success: true, room_id: newRoomId } : { success: false };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // Room pre-configured - send directly
  try {
    const resp = await fetch(`${NEURAL_LINK_URL}/message/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room_id: ROOM_ID,
        from: PARTICIPANT_ID,
        kind,
        summary: "OpenCode delegation",
        body: JSON.stringify(body),
        persist_hint: "durable",
      }),
    });
    return resp.ok ? { success: true, room_id: ROOM_ID } : { success: false };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** @param {import("@opencode-ai/plugin").PluginInput} input */
async function overmindPlugin(input) {
  return {
    tool: {
      overmind_delegate: {
        description: "Delegate work to the Overmind swarm coordinator",
        inputSchema: {
          type: "object",
          properties: {
            objective: {
              type: "string",
              description: "The objective to accomplish",
            },
            mode: {
              type: "string",
              enum: ["scout", "relay", "swarm"],
              description: "Execution mode",
              default: "scout",
            },
          },
          required: ["objective"],
        },
        async execute({ objective, mode }) {
          const result = await sendToOvermind("proposal", { objective, mode: mode ?? "scout" });
          return JSON.stringify(result);
        },
      },
      overmind_status: {
        description: "Check Overmind swarm status",
        inputSchema: { type: "object", properties: {} },
        async execute() {
          return JSON.stringify({
            configured: !!ROOM_ID,
            roomId: ROOM_ID || null,
            neuralLinkUrl: NEURAL_LINK_URL,
          });
        },
      },
    },
    "chat.message": async (input, output) => {
      if (input.agent === "overmind") {
        output.parts.push({
          type: "text",
          text: "[Overmind plugin ready. Use overmind_delegate to dispatch work to the swarm.]",
        });
      }
    },
  };
}

module.exports = overmindPlugin;

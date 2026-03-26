import { tool } from "@opencode-ai/plugin";
import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";

export interface OvermindPluginConfig {
  neuralLinkUrl?: string;
  roomId?: string;
  participantId?: string;
}

export function createPlugin(config: OvermindPluginConfig): Plugin {
  return async function overmindPlugin(_input: PluginInput): Promise<Hooks> {
    async function sendToOvermind(kind: string, body: unknown): Promise<boolean> {
      if (!config.neuralLinkUrl || !config.roomId) return false;
      try {
        const resp = await fetch(`${config.neuralLinkUrl}/message/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            room_id: config.roomId,
            from: config.participantId ?? "opencode",
            kind,
            summary: "OpenCode message",
            body: JSON.stringify(body),
            persist_hint: "durable",
          }),
        });
        return resp.ok;
      } catch {
        return false;
      }
    }

    return {
      tool: {
        overmind_delegate: tool({
          description: "Delegate work to the Overmind swarm coordinator",
          parameters: {
            type: "object",
            properties: {
              objective: {
                type: "string",
                description: "The objective to delegate",
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
            const ok = await sendToOvermind("proposal", { objective, mode: mode ?? "scout" });
            return JSON.stringify({ success: ok });
          },
        }),
        overmind_status: tool({
          description: "Check Overmind swarm status",
          parameters: { type: "object", properties: {} },
          async execute() {
            return JSON.stringify({
              configured: !!(config.neuralLinkUrl && config.roomId),
              roomId: config.roomId ?? null,
            });
          },
        }),
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
  };
}

export type { Plugin, PluginInput, Hooks };

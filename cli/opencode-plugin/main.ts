import { createPlugin } from "./index.ts";

const plugin = createPlugin({
  neuralLinkUrl: process.env.OVERMIND_NEURAL_LINK_URL ?? "http://localhost:9961/mcp",
  roomId: process.env.OVERMIND_ROOM_ID,
  participantId: process.env.OVERMIND_PARTICIPANT_ID ?? "opencode-plugin",
});

export default plugin;

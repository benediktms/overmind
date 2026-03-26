import { assertEquals } from "@std/assert";
import {
  buildCoordinatorAction,
  type HookData,
  resolveAgentInfo,
} from "./subagent-coordinator.ts";

// --- buildCoordinatorAction ---

Deno.test("start action produces finding message", () => {
  const action = buildCoordinatorAction("start", "test-agent");
  assertEquals(action.messageKind, "finding");
  assertEquals(action.summary, "Subagent started: test-agent");
  assertEquals(action.hookEventName, "SubagentStart");
  assertEquals(action.contextPrefix.includes("tracking active"), true);
});

Deno.test("stop action produces handoff message", () => {
  const action = buildCoordinatorAction("stop", "test-agent");
  assertEquals(action.messageKind, "handoff");
  assertEquals(action.summary, "Subagent completed: test-agent");
  assertEquals(action.hookEventName, "SubagentStop");
  assertEquals(action.contextPrefix.includes("completed"), true);
});

Deno.test("unknown action defaults to start behavior", () => {
  const action = buildCoordinatorAction("restart", "agent-x");
  assertEquals(action.messageKind, "finding");
  assertEquals(action.hookEventName, "SubagentStart");
});

Deno.test("empty action defaults to start behavior", () => {
  const action = buildCoordinatorAction("", "agent-x");
  assertEquals(action.messageKind, "finding");
});

// --- resolveAgentInfo ---

Deno.test("resolveAgentInfo prefers agentId field", () => {
  const data: HookData = { agentId: "custom-id", agent_type: "fallback", agent_name: "Named" };
  const { agentId, agentName } = resolveAgentInfo(data);
  assertEquals(agentId, "custom-id");
  assertEquals(agentName, "Named");
});

Deno.test("resolveAgentInfo falls back to agent_type", () => {
  const data: HookData = { agent_type: "explorer" };
  const { agentId, agentName } = resolveAgentInfo(data);
  assertEquals(agentId, "explorer");
  assertEquals(agentName, "explorer");
});

Deno.test("resolveAgentInfo defaults to unknown", () => {
  const { agentId, agentName } = resolveAgentInfo({});
  assertEquals(agentId, "unknown");
  assertEquals(agentName, "unknown");
});

Deno.test("resolveAgentInfo uses agent_name when present", () => {
  const data: HookData = { agent_name: "My Agent" };
  const { agentName } = resolveAgentInfo(data);
  assertEquals(agentName, "My Agent");
});

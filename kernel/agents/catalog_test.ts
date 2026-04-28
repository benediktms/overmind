import { assertEquals, assertExists, assertStrictEquals } from "@std/assert";

import {
  AGENT_CATALOG,
  getAgent,
  getAgentsByModel,
  getAgentsByTier,
} from "./catalog.ts";

Deno.test("catalog has exactly 14 agents", () => {
  assertEquals(AGENT_CATALOG.size, 14);
});

Deno.test("getAgent returns the cortex definition", () => {
  const agent = getAgent("cortex");

  assertExists(agent);
  assertEquals(agent.name, "cortex");
  assertEquals(agent.tier, "worker");
  assertEquals(agent.model, "opus");
  assertEquals(agent.spawns, []);
});

Deno.test("getAgent returns undefined for an unknown agent", () => {
  assertStrictEquals(getAgent("unknown-agent"), undefined);
});

Deno.test("getAgentsByTier returns the coordinator subset", () => {
  const agents = getAgentsByTier("coordinator");

  assertEquals(agents.map((agent) => agent.name), ["planner"]);
});

Deno.test("getAgentsByTier returns all worker agents", () => {
  const agents = getAgentsByTier("worker");

  assertEquals(agents.length, 13);
  assertEquals(agents.some((agent) => agent.name === "planner"), false);
});

Deno.test("getAgentsByModel returns the opus subset", () => {
  const agents = getAgentsByModel("opus");

  assertEquals(agents.map((agent) => agent.name), [
    "cortex",
    "planner",
    "architect",
    "sentinel",
  ]);
});

Deno.test("catalog entries keep their declared dispatch triggers", () => {
  const planner = getAgent("planner");

  assertExists(planner);
  assertEquals(planner.dispatchTriggers, [
    "multi-step objectives",
    "unclear implementation path",
    "dependency-heavy delivery planning",
    "execution sequencing requests",
  ]);
});

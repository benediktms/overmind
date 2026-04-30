import { assertEquals } from "jsr:@std/assert";
import { ClientSideDispatcher } from "./client_side.ts";
import type { AgentDispatchRequest } from "../agent_dispatcher.ts";

const RUN_A = "run-00000000-0000-0000-0000-000000000001";
const RUN_B = "run-00000000-0000-0000-0000-000000000002";

function makeRequest(
  runId: string,
  agentId: string,
): AgentDispatchRequest {
  return {
    agentId: `${runId}-${agentId}`,
    role: "drone",
    prompt: `prompt-${agentId}`,
    roomId: "room-1",
    participantId: `participant-${agentId}`,
    workspace: "/tmp",
  };
}

Deno.test("dispatch records to per-runId queue; multiple agents under same runId accumulate", async () => {
  const d = new ClientSideDispatcher();
  const r1 = makeRequest(RUN_A, "agent-1");
  const r2 = makeRequest(RUN_A, "agent-2");

  const res1 = await d.dispatch(r1);
  const res2 = await d.dispatch(r2);

  assertEquals(res1, { launched: true });
  assertEquals(res2, { launched: true });
  assertEquals(d.getPendingCount(RUN_A), 2);
});

Deno.test("drainPending returns and clears the queue", async () => {
  const d = new ClientSideDispatcher();
  const r1 = makeRequest(RUN_A, "agent-1");
  const r2 = makeRequest(RUN_A, "agent-2");
  await d.dispatch(r1);
  await d.dispatch(r2);

  const drained = d.drainPending(RUN_A);
  assertEquals(drained.length, 2);
  assertEquals(drained[0].agentId, r1.agentId);
  assertEquals(drained[1].agentId, r2.agentId);
  assertEquals(d.getPendingCount(RUN_A), 0);
});

Deno.test("drainPending on empty/unknown runId returns empty array", () => {
  const d = new ClientSideDispatcher();
  assertEquals(d.drainPending("run-00000000-0000-0000-0000-000000000099"), []);
});

Deno.test("cancelRun clears the queue", async () => {
  const d = new ClientSideDispatcher();
  await d.dispatch(makeRequest(RUN_A, "agent-1"));
  await d.dispatch(makeRequest(RUN_A, "agent-2"));
  assertEquals(d.getPendingCount(RUN_A), 2);

  d.cancelRun(RUN_A);
  assertEquals(d.getPendingCount(RUN_A), 0);
});

Deno.test("isAvailable always returns true", () => {
  const d = new ClientSideDispatcher();
  assertEquals(d.isAvailable(), true);
});

Deno.test("agentIds in different runIds are isolated", async () => {
  const d = new ClientSideDispatcher();
  await d.dispatch(makeRequest(RUN_A, "agent-a1"));
  await d.dispatch(makeRequest(RUN_B, "agent-b1"));
  await d.dispatch(makeRequest(RUN_B, "agent-b2"));

  const drainedA = d.drainPending(RUN_A);
  assertEquals(drainedA.length, 1);
  assertEquals(drainedA[0].agentId, `${RUN_A}-agent-a1`);

  // RUN_B queue untouched
  assertEquals(d.getPendingCount(RUN_B), 2);
});

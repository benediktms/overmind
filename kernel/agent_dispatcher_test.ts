import { assertEquals } from "@std/assert";

import { NoopDispatcher, MockDispatcher, type AgentDispatchRequest } from "./agent_dispatcher.ts";

function makeRequest(overrides: Partial<AgentDispatchRequest> = {}): AgentDispatchRequest {
  return {
    agentId: "agent-1",
    role: "probe",
    prompt: "Explore the codebase",
    roomId: "room-1",
    participantId: "probe-1",
    workspace: "/tmp/overmind",
    ...overrides,
  };
}

Deno.test("NoopDispatcher.dispatch records request and returns not launched", async () => {
  const dispatcher = new NoopDispatcher();
  const request = makeRequest();

  const result = await dispatcher.dispatch(request);

  assertEquals(result.launched, false);
  assertEquals(typeof result.error, "string");
  assertEquals(dispatcher.dispatched.length, 1);
  assertEquals(dispatcher.dispatched[0], request);
});

Deno.test("NoopDispatcher.isAvailable returns false", () => {
  const dispatcher = new NoopDispatcher();
  assertEquals(dispatcher.isAvailable(), false);
});

Deno.test("MockDispatcher.dispatch records request and returns launched", async () => {
  const dispatcher = new MockDispatcher();
  const request = makeRequest();

  const result = await dispatcher.dispatch(request);

  assertEquals(result.launched, true);
  assertEquals(result.error, undefined);
  assertEquals(dispatcher.dispatched.length, 1);
  assertEquals(dispatcher.dispatched[0], request);
});

Deno.test("MockDispatcher.isAvailable returns true", () => {
  const dispatcher = new MockDispatcher();
  assertEquals(dispatcher.isAvailable(), true);
});

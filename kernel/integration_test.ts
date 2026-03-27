import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";

import { type BrainAdapter } from "../adapters/brain/adapter.ts";
import { MessageKind, type NeuralLinkAdapter } from "../adapters/neural_link/adapter.ts";
import { AdapterRegistry } from "./adapters.ts";
import { OvermindDaemon } from "./daemon.ts";
import { Kernel } from "./kernel.ts";
import { MockBrainAdapter, type MockCall } from "./test_helpers/mock_brain.ts";
import { MockNeuralLinkAdapter } from "./test_helpers/mock_neural_link.ts";
import { Mode } from "./types.ts";

const MODE_EXECUTION_WAIT_MS = 100;

interface TestPaths {
  baseDir: string;
  pidPath: string;
  socketPath: string;
}

interface IntegrationHarness {
  tempDir: string;
  daemon: OvermindDaemon;
  kernel: Kernel;
  brain: MockBrainAdapter;
  neuralLink: MockNeuralLinkAdapter;
  paths: TestPaths;
}

function createTestPaths(tempDir: string): TestPaths {
  const baseDir = `${tempDir}/.overmind`;
  return {
    baseDir,
    pidPath: `${baseDir}/daemon.pid`,
    socketPath: `${baseDir}/daemon.sock`,
  };
}

async function sendRawSocketRequest(socketPath: string, requestBody: string): Promise<string> {
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  try {
    await conn.write(encoder.encode(requestBody));
    const buf = new Uint8Array(4096);
    const n = await conn.read(buf);
    return decoder.decode(buf.subarray(0, n ?? 0));
  } finally {
    conn.close();
  }
}

function callsByMethod(calls: MockCall[], method: string): MockCall[] {
  return calls.filter((call) => call.method === method);
}

function mockWaitForQueue(neuralLink: MockNeuralLinkAdapter, values: Array<unknown | null>): void {
  const queue = [...values];
  neuralLink.waitFor = async (
    roomId: string,
    participantId: string,
    timeoutMs: number,
    kinds?: string[],
    from?: string[],
  ): Promise<unknown | null> => {
    neuralLink.calls.push({ method: "waitFor", args: [roomId, participantId, timeoutMs, kinds, from] });
    return queue.shift() ?? null;
  };
}

function mockWaitForAlwaysPassing(neuralLink: MockNeuralLinkAdapter): void {
  neuralLink.waitFor = async (
    roomId: string,
    participantId: string,
    timeoutMs: number,
    kinds?: string[],
    from?: string[],
  ): Promise<unknown | null> => {
    neuralLink.calls.push({ method: "waitFor", args: [roomId, participantId, timeoutMs, kinds, from] });

    if (kinds?.includes(MessageKind.ReviewResult)) {
      return { passed: true, details: "verify passed" };
    }

    return { from: "mock-agent", summary: "handoff complete" };
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) {
      return;
    }
    await delay(20);
  }

  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function assertPathRemoved(path: string): Promise<void> {
  try {
    await Deno.stat(path);
    throw new Error(`Expected ${path} to be removed`);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createHarness(): Promise<IntegrationHarness> {
  const tempDir = await Deno.makeTempDir();
  const paths = createTestPaths(tempDir);
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();

  const seedKernel = new Kernel();
  const registry = new AdapterRegistry(seedKernel, {
    brain: brain as unknown as BrainAdapter,
    neuralLink: neuralLink as unknown as NeuralLinkAdapter,
  });
  const kernel = new Kernel({ registry });
  await kernel.start();

  const daemon = new OvermindDaemon({ baseDir: paths.baseDir, kernel });
  await daemon.start();

  return {
    tempDir,
    daemon,
    kernel,
    brain,
    neuralLink,
    paths,
  };
}

async function shutdownHarness(harness: IntegrationHarness): Promise<void> {
  await harness.daemon.shutdown();
  await harness.kernel.shutdown();
  await Deno.remove(harness.tempDir, { recursive: true });
}

Deno.test("integration: scout lifecycle via daemon completes brain and neural_link flow", async () => {
  const harness = await createHarness();
  mockWaitForQueue(harness.neuralLink, [
    { from: "probe-1", summary: "angle 1" },
    { from: "probe-2", summary: "angle 2" },
    { from: "probe-3", summary: "angle 3" },
  ]);

  try {
    const responseText = await sendRawSocketRequest(
      harness.paths.socketPath,
      JSON.stringify({
        type: "mode_request",
        run_id: "run-integration-scout",
        mode: Mode.Scout,
        objective: "Validate scout daemon integration",
        workspace: harness.tempDir,
      }),
    );
    const response = JSON.parse(responseText) as { status: string; run_id: string; error: string | null };

    assertEquals(response.status, "accepted");
    assertEquals(response.run_id, "run-integration-scout");
    assertEquals(response.error, null);

    await delay(MODE_EXECUTION_WAIT_MS);
    await waitFor(() => callsByMethod(harness.brain.calls, "taskComplete").length === 1);

    assertEquals(callsByMethod(harness.brain.calls, "taskCreate").length, 1);
    assertEquals(callsByMethod(harness.brain.calls, "taskAddExternalId").length, 1);
    assertEquals(callsByMethod(harness.brain.calls, "memoryEpisode").length, 1);
    assertEquals(callsByMethod(harness.brain.calls, "taskComplete").length, 1);
    assertEquals(callsByMethod(harness.neuralLink.calls, "roomOpen").length, 1);
    assertEquals(callsByMethod(harness.neuralLink.calls, "roomClose").length, 1);
  } finally {
    await shutdownHarness(harness);
  }
});

Deno.test("integration: relay lifecycle via daemon enforces sequential execute and verify gates", async () => {
  const harness = await createHarness();
  mockWaitForQueue(harness.neuralLink, [
    { from: "cortex", summary: "Step 1 handoff complete" },
    { passed: true, details: "Step 1 verify passed" },
    { from: "probe", summary: "Step 2 handoff complete" },
    { passed: true, details: "Step 2 verify passed" },
    { from: "liaison", summary: "Step 3 handoff complete" },
    { passed: true, details: "Step 3 verify passed" },
  ]);

  try {
    const responseText = await sendRawSocketRequest(
      harness.paths.socketPath,
      JSON.stringify({
        type: "mode_request",
        run_id: "run-integration-relay",
        mode: Mode.Relay,
        objective: "Validate relay daemon integration",
        workspace: harness.tempDir,
      }),
    );
    const response = JSON.parse(responseText) as { status: string; run_id: string; error: string | null };

    assertEquals(response.status, "accepted");
    assertEquals(response.run_id, "run-integration-relay");
    assertEquals(response.error, null);

    await delay(MODE_EXECUTION_WAIT_MS);
    await waitFor(() => callsByMethod(harness.brain.calls, "taskComplete").length === 1);

    const relevantCalls = harness.neuralLink.calls.filter((call) => {
      if (call.method === "waitFor") {
        return true;
      }
      if (call.method !== "messageSend") {
        return false;
      }
      const params = call.args[0] as { summary: string };
      return params.summary.startsWith("Execute") || params.summary.startsWith("Verify");
    });

    const lifecycle = relevantCalls.map((call) => {
      if (call.method === "waitFor") {
        const kinds = call.args[3] as string[] | undefined;
        return kinds?.[0] === MessageKind.Handoff ? "wait_handoff" : "wait_review";
      }

      const params = call.args[0] as { summary: string };
      return params.summary.startsWith("Execute") ? "execute" : "verify";
    });

    assertEquals(lifecycle, [
      "execute",
      "wait_handoff",
      "verify",
      "wait_review",
      "execute",
      "wait_handoff",
      "verify",
      "wait_review",
      "execute",
      "wait_handoff",
      "verify",
      "wait_review",
    ]);

    assertEquals(callsByMethod(harness.brain.calls, "taskComplete").length, 1);
    assertEquals(callsByMethod(harness.neuralLink.calls, "roomClose").length, 1);
  } finally {
    await shutdownHarness(harness);
  }
});

Deno.test("integration: swarm lifecycle via daemon dispatches parallel wave and completes verify pass", async () => {
  const harness = await createHarness();
  mockWaitForQueue(harness.neuralLink, [
    { from: "cortex", summary: "Task 1 done" },
    { from: "probe", summary: "Task 2 done" },
    { from: "liaison", summary: "Task 3 done" },
    { from: "probe-2", summary: "Task 4 done" },
    { from: "cortex-2", summary: "Task 5 done" },
    { passed: true, details: "integration checks passed" },
  ]);

  try {
    const responseText = await sendRawSocketRequest(
      harness.paths.socketPath,
      JSON.stringify({
        type: "mode_request",
        run_id: "run-integration-swarm",
        mode: Mode.Swarm,
        objective: "Validate swarm daemon integration",
        workspace: harness.tempDir,
      }),
    );
    const response = JSON.parse(responseText) as { status: string; run_id: string; error: string | null };

    assertEquals(response.status, "accepted");
    assertEquals(response.run_id, "run-integration-swarm");
    assertEquals(response.error, null);

    await delay(MODE_EXECUTION_WAIT_MS);
    await waitFor(() => callsByMethod(harness.brain.calls, "taskComplete").length === 1);

    const executeDispatches = callsByMethod(harness.neuralLink.calls, "messageSend").filter((call) => {
      const params = call.args[0] as { summary: string; kind: MessageKind };
      return params.kind === MessageKind.Finding && params.summary.startsWith("Execute");
    });
    assertEquals(executeDispatches.length, 5);

    const firstWaitIndex = harness.neuralLink.calls.findIndex((call) => call.method === "waitFor");
    const executeIndexes = harness.neuralLink.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => {
        if (call.method !== "messageSend") {
          return false;
        }
        const params = call.args[0] as { summary: string };
        return params.summary.startsWith("Execute");
      })
      .map(({ index }) => index);

    assertEquals(executeIndexes.every((index) => index < firstWaitIndex), true);
    assertEquals(callsByMethod(harness.neuralLink.calls, "roomClose").length, 1);
    assertEquals(callsByMethod(harness.brain.calls, "taskComplete").length, 1);
  } finally {
    await shutdownHarness(harness);
  }
});

Deno.test("integration: malformed daemon request returns error response", async () => {
  const harness = await createHarness();

  try {
    const responseText = await sendRawSocketRequest(harness.paths.socketPath, "{bad-json");
    const response = JSON.parse(responseText) as { status: string; run_id: string; error: string | null };

    assertEquals(response.status, "error");
    assertEquals(response.run_id, "");
    assertStringIncludes(response.error ?? "", "Malformed request");
  } finally {
    await shutdownHarness(harness);
  }
});

Deno.test("integration: concurrent scout and swarm requests are accepted with distinct run IDs", async () => {
  const harness = await createHarness();
  mockWaitForAlwaysPassing(harness.neuralLink);

  try {
    const [scoutResponseText, swarmResponseText] = await Promise.all([
      sendRawSocketRequest(
        harness.paths.socketPath,
        JSON.stringify({
          type: "mode_request",
          run_id: "run-concurrent-scout",
          mode: Mode.Scout,
          objective: "Concurrent scout flow",
          workspace: harness.tempDir,
        }),
      ),
      sendRawSocketRequest(
        harness.paths.socketPath,
        JSON.stringify({
          type: "mode_request",
          run_id: "run-concurrent-swarm",
          mode: Mode.Swarm,
          objective: "Concurrent swarm flow",
          workspace: harness.tempDir,
        }),
      ),
    ]);

    const scoutResponse = JSON.parse(scoutResponseText) as { status: string; run_id: string; error: string | null };
    const swarmResponse = JSON.parse(swarmResponseText) as { status: string; run_id: string; error: string | null };

    assertEquals(scoutResponse.status, "accepted");
    assertEquals(swarmResponse.status, "accepted");
    assertNotEquals(scoutResponse.run_id, swarmResponse.run_id);
    assertEquals(scoutResponse.error, null);
    assertEquals(swarmResponse.error, null);

    await delay(MODE_EXECUTION_WAIT_MS);
    await waitFor(() => callsByMethod(harness.brain.calls, "taskComplete").length >= 2);

    assertEquals(callsByMethod(harness.brain.calls, "taskCreate").length, 2);
    assertEquals(callsByMethod(harness.neuralLink.calls, "roomOpen").length, 2);
  } finally {
    await shutdownHarness(harness);
  }
});

Deno.test("integration: daemon shutdown cleans up PID and socket files", async () => {
  const harness = await createHarness();

  const pidInfo = await Deno.stat(harness.paths.pidPath);
  const socketInfo = await Deno.stat(harness.paths.socketPath);
  assert(pidInfo.isFile);
  assert(socketInfo.isSocket);

  await harness.daemon.shutdown();
  await harness.kernel.shutdown();

  await assertPathRemoved(harness.paths.pidPath);
  await assertPathRemoved(harness.paths.socketPath);

  await Deno.remove(harness.tempDir, { recursive: true });
});

Deno.test("integration: valid JSON with invalid mode returns error response", async () => {
  const harness = await createHarness();

  try {
    const responseText = await sendRawSocketRequest(
      harness.paths.socketPath,
      JSON.stringify({
        type: "mode_request",
        run_id: "run-invalid-mode",
        mode: "unknown-mode",
        objective: "Should fail mode validation",
        workspace: harness.tempDir,
      }),
    );
    const response = JSON.parse(responseText) as { status: string; run_id: string; error: string | null };

    assertEquals(response.status, "error");
    assertEquals(response.run_id, "");
    assertStringIncludes(response.error ?? "", "Invalid request");
  } finally {
    await shutdownHarness(harness);
  }
});

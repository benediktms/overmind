import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";

import { type BrainAdapter } from "../adapters/brain/adapter.ts";
import {
  MessageKind,
  type NeuralLinkAdapter,
} from "../adapters/neural_link/adapter.ts";
import { AdapterRegistry } from "./adapters.ts";
import { OvermindDaemon } from "./daemon.ts";
import { Kernel } from "./kernel.ts";
import { MockBrainAdapter, type MockCall } from "./test_helpers/mock_brain.ts";
import { MockNeuralLinkAdapter } from "./test_helpers/mock_neural_link.ts";
import { Mode, RunState } from "./types.ts";
import type { WaitForMessage } from "./types.ts";
import { tryAcquire } from "../cli/claudecode-plugin/scripts/lib/lock_client.ts";

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

async function sendRawSocketRequest(
  socketPath: string,
  requestBody: string,
): Promise<string> {
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  try {
    // Send with NDJSON framing
    await conn.write(encoder.encode(requestBody + "\n"));

    // Read until newline delimiter
    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(4096);
    while (true) {
      const n = await conn.read(buf);
      if (n === null) break;
      const chunk = buf.slice(0, n);
      chunks.push(chunk);
      if (chunk.includes(0x0a)) break;
    }

    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }

    const raw = decoder.decode(merged);
    const newlineIndex = raw.indexOf("\n");
    return newlineIndex >= 0 ? raw.slice(0, newlineIndex) : raw;
  } finally {
    conn.close();
  }
}

function callsByMethod(calls: MockCall[], method: string): MockCall[] {
  return calls.filter((call) => call.method === method);
}

function mockWaitForQueue(
  neuralLink: MockNeuralLinkAdapter,
  values: Array<unknown>,
): void {
  const queue = [...values];
  neuralLink.waitFor = async (
    roomId: string,
    participantId: string,
    timeoutMs: number,
    kinds?: string[],
    from?: string[],
  ): Promise<WaitForMessage | null> => {
    neuralLink.calls.push({
      method: "waitFor",
      args: [roomId, participantId, timeoutMs, kinds, from],
    });
    return (queue.shift() ?? null) as WaitForMessage | null;
  };
}

function mockWaitForAlwaysPassing(neuralLink: MockNeuralLinkAdapter): void {
  neuralLink.waitFor = async (
    roomId: string,
    participantId: string,
    timeoutMs: number,
    kinds?: string[],
    from?: string[],
  ): Promise<WaitForMessage | null> => {
    neuralLink.calls.push({
      method: "waitFor",
      args: [roomId, participantId, timeoutMs, kinds, from],
    });

    if (kinds?.includes(MessageKind.ReviewResult)) {
      return {
        passed: true,
        details: "verify passed",
      } as unknown as WaitForMessage;
    }

    return {
      from: "mock-agent",
      summary: "handoff complete",
    } as unknown as WaitForMessage;
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

  const daemon = new OvermindDaemon({
    baseDir: paths.baseDir,
    kernel,
    // Bind to an ephemeral port so tests never collide on 8080.
    httpPort: 0,
  });
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
    const response = JSON.parse(responseText) as {
      status: string;
      run_id: string;
      error: string | null;
    };

    assertEquals(response.status, "accepted");
    assertEquals(response.run_id, "run-integration-scout");
    assertEquals(response.error, null);

    await delay(MODE_EXECUTION_WAIT_MS);
    await waitFor(() =>
      callsByMethod(harness.brain.calls, "taskComplete").length === 1
    );

    assertEquals(callsByMethod(harness.brain.calls, "taskCreate").length, 1);
    assertEquals(
      callsByMethod(harness.brain.calls, "taskAddExternalId").length,
      1,
    );
    assertEquals(callsByMethod(harness.brain.calls, "memoryEpisode").length, 1);
    assertEquals(callsByMethod(harness.brain.calls, "taskComplete").length, 1);
    assertEquals(callsByMethod(harness.neuralLink.calls, "roomOpen").length, 1);
    assertEquals(
      callsByMethod(harness.neuralLink.calls, "roomClose").length,
      1,
    );
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
    const response = JSON.parse(responseText) as {
      status: string;
      run_id: string;
      error: string | null;
    };

    assertEquals(response.status, "accepted");
    assertEquals(response.run_id, "run-integration-relay");
    assertEquals(response.error, null);

    await delay(MODE_EXECUTION_WAIT_MS);
    await waitFor(() =>
      callsByMethod(harness.brain.calls, "taskComplete").length === 1
    );

    const relevantCalls = harness.neuralLink.calls.filter((call) => {
      if (call.method === "waitFor") {
        return true;
      }
      if (call.method !== "messageSend") {
        return false;
      }
      const params = call.args[0] as { summary: string };
      return params.summary.startsWith("Execute") ||
        params.summary.startsWith("Verify");
    });

    const lifecycle = relevantCalls.map((call) => {
      if (call.method === "waitFor") {
        const kinds = call.args[3] as string[] | undefined;
        return kinds?.[0] === MessageKind.Handoff
          ? "wait_handoff"
          : "wait_review";
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
    assertEquals(
      callsByMethod(harness.neuralLink.calls, "roomClose").length,
      1,
    );
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
    const response = JSON.parse(responseText) as {
      status: string;
      run_id: string;
      error: string | null;
    };

    assertEquals(response.status, "accepted");
    assertEquals(response.run_id, "run-integration-swarm");
    assertEquals(response.error, null);

    await delay(MODE_EXECUTION_WAIT_MS);
    await waitFor(() =>
      callsByMethod(harness.brain.calls, "taskComplete").length === 1
    );

    const executeDispatches = callsByMethod(
      harness.neuralLink.calls,
      "messageSend",
    ).filter((call) => {
      const params = call.args[0] as { summary: string; kind: MessageKind };
      return params.kind === MessageKind.Finding &&
        params.summary.startsWith("Execute");
    });
    assertEquals(executeDispatches.length, 5);

    // Wave 0 (Task 1, no deps) is dispatched before the first waitFor.
    // Subsequent waves are dispatched after their preceding wave's handoffs are collected.
    const firstWaitIndex = harness.neuralLink.calls.findIndex((call) =>
      call.method === "waitFor"
    );
    const wave0ExecuteIndexes = harness.neuralLink.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call, index }) => {
        if (call.method !== "messageSend") {
          return false;
        }
        const params = call.args[0] as { summary: string };
        return params.summary.startsWith("Execute") && index < firstWaitIndex;
      })
      .map(({ index }) => index);

    // Wave 0 contains exactly 1 task (Task 1 has no dependencies)
    assertEquals(wave0ExecuteIndexes.length, 1);
    assertEquals(
      callsByMethod(harness.neuralLink.calls, "roomClose").length,
      1,
    );
    assertEquals(callsByMethod(harness.brain.calls, "taskComplete").length, 1);
  } finally {
    await shutdownHarness(harness);
  }
});

Deno.test("integration: malformed daemon request returns error response", async () => {
  const harness = await createHarness();

  try {
    const responseText = await sendRawSocketRequest(
      harness.paths.socketPath,
      "{bad-json",
    );
    const response = JSON.parse(responseText) as {
      status: string;
      run_id: string;
      error: string | null;
    };

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

    const scoutResponse = JSON.parse(scoutResponseText) as {
      status: string;
      run_id: string;
      error: string | null;
    };
    const swarmResponse = JSON.parse(swarmResponseText) as {
      status: string;
      run_id: string;
      error: string | null;
    };

    assertEquals(scoutResponse.status, "accepted");
    assertEquals(swarmResponse.status, "accepted");
    assertNotEquals(scoutResponse.run_id, swarmResponse.run_id);
    assertEquals(scoutResponse.error, null);
    assertEquals(swarmResponse.error, null);

    await delay(MODE_EXECUTION_WAIT_MS);
    await waitFor(() =>
      callsByMethod(harness.brain.calls, "taskComplete").length >= 2
    );

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
    const response = JSON.parse(responseText) as {
      status: string;
      run_id: string;
      error: string | null;
    };

    assertEquals(response.status, "error");
    assertEquals(response.run_id, "");
    assertStringIncludes(response.error ?? "", "Invalid request");
  } finally {
    await shutdownHarness(harness);
  }
});

Deno.test("integration: scout continues with local persistence when brain task creation is unavailable", async () => {
  const harness = await createHarness();
  mockWaitForQueue(harness.neuralLink, [
    { from: "probe-1", summary: "angle 1" },
    { from: "probe-2", summary: "angle 2" },
    { from: "probe-3", summary: "angle 3" },
  ]);
  harness.brain.taskCreateResult = null;

  try {
    const responseText = await sendRawSocketRequest(
      harness.paths.socketPath,
      JSON.stringify({
        type: "mode_request",
        run_id: "run-integration-scout-local",
        mode: Mode.Scout,
        objective: "Validate local persistence fallback",
        workspace: harness.tempDir,
      }),
    );
    const response = JSON.parse(responseText) as {
      status: string;
      run_id: string;
      error: string | null;
    };

    assertEquals(response.status, "accepted");

    await delay(MODE_EXECUTION_WAIT_MS);

    let persistedState: { active: boolean; state: string } | null = null;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        const content = await Deno.readTextFile(
          `${harness.tempDir}/.overmind/state/scout-state.json`,
        );
        const state = JSON.parse(content) as { active: boolean; state: string };
        if (state.active === false && state.state === RunState.Completed) {
          persistedState = state;
          break;
        }
      } catch {
        persistedState = null;
      }
      await delay(20);
    }

    assert(persistedState);

    assertEquals(callsByMethod(harness.brain.calls, "taskComplete").length, 0);
  } finally {
    await shutdownHarness(harness);
  }
});

Deno.test("integration: /release-session-locks frees every lock owned by a session", async () => {
  const harness = await createHarness();
  const previousHarnessFlag = Deno.env.get("OVERMIND_EDIT_HARNESS");
  Deno.env.set("OVERMIND_EDIT_HARNESS", "1");

  try {
    const port = harness.daemon.getHttpPort();
    assertNotEquals(port, 0, "expected daemon HTTP server to be running");
    const baseUrl = `http://127.0.0.1:${port}`;
    const sessionId = "session-integration-locks";

    // Two locks bound to the same session — different agents, simulating an
    // orchestrator + worker pair within one CC session.
    for (
      const [path, agentId] of [
        ["/foo.ts", "A"],
        ["/bar.ts", "B"],
      ]
    ) {
      const res = await fetch(`${baseUrl}/lock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, sessionId, agentId }),
      });
      assertEquals(res.status, 200);
      await res.body?.cancel();
    }

    // One unrelated lock in a sibling session — must be untouched by the
    // release-session-locks call.
    const sibling = await fetch(`${baseUrl}/lock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "/sibling.ts",
        sessionId: "session-other",
        agentId: "C",
      }),
    });
    assertEquals(sibling.status, 200);
    await sibling.body?.cancel();

    const registry = harness.daemon.getLockRegistry();
    assert(registry, "expected lock registry to be attached to daemon");
    assertEquals(registry.snapshot().length, 3);

    // SessionEnd-style cleanup. This is what the hook posts when CC fires
    // SessionEnd; the canonical auto-release trigger under the new contract.
    const release = await fetch(`${baseUrl}/release-session-locks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    assertEquals(release.status, 200);
    const body = await release.json();
    assertEquals(body.ok, true);
    assertEquals(body.released, 2);

    const remaining = registry.snapshot();
    assertEquals(remaining.length, 1);
    assertEquals(remaining[0].path, "/sibling.ts");
    assertEquals(remaining[0].sessionId, "session-other");
  } finally {
    if (previousHarnessFlag === undefined) {
      Deno.env.delete("OVERMIND_EDIT_HARNESS");
    } else {
      Deno.env.set("OVERMIND_EDIT_HARNESS", previousHarnessFlag);
    }
    await shutdownHarness(harness);
  }
});

Deno.test("integration: HTTP /lock returns 409 with holder on cross-session contention", async () => {
  const harness = await createHarness();
  const previousHarnessFlag = Deno.env.get("OVERMIND_EDIT_HARNESS");
  Deno.env.set("OVERMIND_EDIT_HARNESS", "1");

  try {
    const baseUrl = `http://127.0.0.1:${harness.daemon.getHttpPort()}`;

    const first = await fetch(`${baseUrl}/lock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "/contested.ts",
        sessionId: "session-A",
        agentId: "agent-1",
      }),
    });
    assertEquals(first.status, 200);
    await first.body?.cancel();

    const second = await fetch(`${baseUrl}/lock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "/contested.ts",
        sessionId: "session-B",
        agentId: "agent-2",
      }),
    });
    assertEquals(second.status, 409);
    const body = await second.json();
    assertEquals(body.ok, false);
    assertEquals(body.holder, {
      sessionId: "session-A",
      agentId: "agent-1",
    });
  } finally {
    if (previousHarnessFlag === undefined) {
      Deno.env.delete("OVERMIND_EDIT_HARNESS");
    } else {
      Deno.env.set("OVERMIND_EDIT_HARNESS", previousHarnessFlag);
    }
    await shutdownHarness(harness);
  }
});

Deno.test("integration: kernel /lock normalizes symlinked paths so cross-agent races are caught", async () => {
  // End-to-end: drone A acquires under the symlink path, drone B acquires
  // under the canonical target path. Without kernel-side path normalization
  // the registry stored two distinct keys for the same file and B was
  // wrongly told "ok" — a silent multi-agent overwrite vector.
  const harness = await createHarness();
  const previousHarnessFlag = Deno.env.get("OVERMIND_EDIT_HARNESS");
  Deno.env.set("OVERMIND_EDIT_HARNESS", "1");

  const fileDir = await Deno.makeTempDir();
  try {
    const baseUrl = `http://127.0.0.1:${harness.daemon.getHttpPort()}`;
    const realFilePath = `${fileDir}/contested.ts`;
    const linkPath = `${fileDir}/contested-link.ts`;
    await Deno.writeTextFile(realFilePath, "");
    await Deno.symlink(realFilePath, linkPath);

    const first = await tryAcquire({
      url: baseUrl,
      path: linkPath,
      sessionId: "session-A",
      agentId: "drone-A",
      mode: "swarm",
    });
    assertEquals(first.status, "ok");

    const second = await tryAcquire({
      url: baseUrl,
      path: realFilePath,
      sessionId: "session-B",
      agentId: "drone-B",
      mode: "swarm",
    });
    assertEquals(second.status, "conflict");
    if (second.status === "conflict") {
      assertEquals(second.holder.sessionId, "session-A");
      assertEquals(second.holder.agentId, "drone-A");
    }

    const registry = harness.daemon.getLockRegistry();
    assert(registry, "expected lock registry");
    // Exactly one canonical entry — not two divergent representations.
    assertEquals(registry.snapshot().length, 1);
  } finally {
    await Deno.remove(fileDir, { recursive: true });
    if (previousHarnessFlag === undefined) {
      Deno.env.delete("OVERMIND_EDIT_HARNESS");
    } else {
      Deno.env.set("OVERMIND_EDIT_HARNESS", previousHarnessFlag);
    }
    await shutdownHarness(harness);
  }
});

Deno.test("integration: swarm two-agent race via lock_client", async () => {
  // M4 end-to-end: drives the hook-side `tryAcquire` against a real kernel
  // HTTP listener. Proves the full plumbing — wire-format, conflict body
  // shape, holder parsing, and SessionEnd-style release — is intact.
  const harness = await createHarness();
  const previousHarnessFlag = Deno.env.get("OVERMIND_EDIT_HARNESS");
  Deno.env.set("OVERMIND_EDIT_HARNESS", "1");

  try {
    const baseUrl = `http://127.0.0.1:${harness.daemon.getHttpPort()}`;
    const path = "/swarm-race.ts";

    // Drone-A acquires the lock.
    const first = await tryAcquire({
      url: baseUrl,
      path,
      sessionId: "session-A",
      agentId: "drone-A",
      mode: "swarm",
    });
    assertEquals(first.status, "ok");

    // Drone-B (different session, different agent) tries the same path and
    // must observe the conflict with drone-A's identity surfaced.
    const second = await tryAcquire({
      url: baseUrl,
      path,
      sessionId: "session-B",
      agentId: "drone-B",
      mode: "swarm",
    });
    assertEquals(second.status, "conflict");
    if (second.status === "conflict") {
      assertEquals(second.holder.sessionId, "session-A");
      assertEquals(second.holder.agentId, "drone-A");
    }

    // Drone-A's CC session ends — the SessionEnd hook posts to
    // /release-session-locks. Simulate that POST directly.
    const release = await fetch(`${baseUrl}/release-session-locks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "session-A" }),
    });
    assertEquals(release.status, 200);
    await release.body?.cancel();

    // Drone-B retries and now wins.
    const retry = await tryAcquire({
      url: baseUrl,
      path,
      sessionId: "session-B",
      agentId: "drone-B",
      mode: "swarm",
    });
    assertEquals(retry.status, "ok");

    // Scout / relay short-circuit: a third agent in single-writer mode never
    // even hits the kernel. Verified by reading the registry — no new lock.
    const registry = harness.daemon.getLockRegistry();
    assert(registry, "expected lock registry");
    const beforeScout = registry.snapshot().length;
    const scoutResult = await tryAcquire({
      url: baseUrl,
      path: "/scout-only.ts",
      sessionId: "session-C",
      agentId: "scout-1",
      mode: "scout",
    });
    assertEquals(scoutResult.status, "skipped");
    assertEquals(registry.snapshot().length, beforeScout);
  } finally {
    if (previousHarnessFlag === undefined) {
      Deno.env.delete("OVERMIND_EDIT_HARNESS");
    } else {
      Deno.env.set("OVERMIND_EDIT_HARNESS", previousHarnessFlag);
    }
    await shutdownHarness(harness);
  }
});

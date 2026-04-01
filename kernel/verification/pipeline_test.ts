import { assertEquals } from "@std/assert";
import { VerificationPipeline, createVerificationPipeline } from "./pipeline.ts";
import type { LspAdapter, BashAdapter } from "./strategies.ts";
import type { Diagnostic } from "./types.ts";

const mockLsp: LspAdapter = {
  diagnostics: async (_file: string): Promise<Diagnostic[]> => [],
};

const mockBashPass: BashAdapter = {
  run: async (_cmd: string, _cwd?: string) => ({
    success: true,
    exitCode: 0,
    output: "Build succeeded",
    duration_ms: 100,
  }),
};

const mockBashFail: BashAdapter = {
  run: async (_cmd: string, _cwd?: string) => ({
    success: false,
    exitCode: 1,
    output: "Build failed: error",
    duration_ms: 100,
  }),
};

Deno.test("VerificationPipeline passes when all strategies pass", async () => {
  const pipeline = createVerificationPipeline(
    [{ type: "build", command: "echo success" }],
    { workspace: "/tmp", objective: "test", runId: "run-1" },
    { bash: mockBashPass },
  );

  const result = await pipeline.verify();

  assertEquals(result.outcome, "passed");
});

Deno.test("VerificationPipeline fails when any strategy fails", async () => {
  const pipeline = createVerificationPipeline(
    [{ type: "build", command: "exit 1" }],
    { workspace: "/tmp", objective: "test", runId: "run-1" },
    { bash: mockBashFail },
  );

  const result = await pipeline.verify();

  assertEquals(result.outcome !== "passed", true);
});

Deno.test("VerificationPipeline returns evidence on success", async () => {
  const pipeline = createVerificationPipeline(
    [{ type: "lsp", files: ["/tmp/test.ts"] }],
    { workspace: "/tmp", objective: "test", runId: "run-1" },
    { lsp: mockLsp },
  );

  const result = await pipeline.verify();

  assertEquals(result.outcome, "passed");
  assertEquals(result.confidence, 1.0);
  assertEquals(result.evidence.diagnostics.length, 0);
});

Deno.test("VerificationPipeline returns failed tasks on failure", async () => {
  const pipeline = createVerificationPipeline(
    [{ type: "build", command: "exit 1" }],
    { workspace: "/tmp", objective: "test", runId: "run-1" },
    { bash: mockBashFail },
  );

  const result = await pipeline.verify();

  assertEquals(result.outcome !== "passed", true);
  assertEquals(result.failedTasks.length, 1);
  assertEquals(result.failedTasks[0].taskId, "build");
});

Deno.test("VerificationPipeline uses agent strategy", async () => {
  let messageSent = false;
  const mockNeuralLink = {
    messageSend: async () => {
      messageSent = true;
      return true;
    },
    waitFor: async () => ({ passed: true, details: "Agent verification passed" }),
  };

  const pipeline = createVerificationPipeline(
    [{ type: "agent", agentRole: "verifier", prompt: "Verify output" }],
    { workspace: "/tmp", objective: "test", runId: "run-1" },
    {
      neuralLink: mockNeuralLink as never,
      roomId: "room-1",
      participantId: "lead",
      timeoutMs: 5000,
    },
  );

  const result = await pipeline.verify();

  assertEquals(messageSent, true);
  assertEquals(result.outcome, "passed");
});

Deno.test("VerificationPipeline composes multiple strategies with AND logic", async () => {
  const pipeline = createVerificationPipeline(
    [
      { type: "build", command: "echo success" },
      { type: "test", command: "echo passed" },
    ],
    { workspace: "/tmp", objective: "test", runId: "run-1" },
    { bash: mockBashPass },
  );

  const result = await pipeline.verify();

  assertEquals(result.outcome, "passed");
});

Deno.test("VerificationPipeline failFast skips agent when deterministic fails", async () => {
  let agentCalled = false;
  const mockNeuralLink = {
    messageSend: async () => {
      agentCalled = true;
      return true;
    },
    waitFor: async () => ({ passed: true, details: "ok" }),
  };

  const pipeline = createVerificationPipeline(
    [
      { type: "build", command: "exit 1" },
      { type: "agent", agentRole: "verifier", prompt: "Verify" },
    ],
    { workspace: "/tmp", objective: "test", runId: "run-1" },
    {
      bash: mockBashFail,
      neuralLink: mockNeuralLink as never,
      roomId: "room-1",
      participantId: "lead",
      timeoutMs: 5000,
    },
    undefined,
    { failFast: true },
  );

  const result = await pipeline.verify();

  assertEquals(result.outcome !== "passed", true);
  assertEquals(agentCalled, false, "Agent strategy should not run when deterministic gates fail with failFast");
});

Deno.test("VerificationPipeline failFast=false runs agent even when deterministic fails", async () => {
  let agentCalled = false;
  const mockNeuralLink = {
    messageSend: async () => {
      agentCalled = true;
      return true;
    },
    waitFor: async () => ({ passed: true, details: "ok" }),
  };

  const pipeline = createVerificationPipeline(
    [
      { type: "build", command: "exit 1" },
      { type: "agent", agentRole: "verifier", prompt: "Verify" },
    ],
    { workspace: "/tmp", objective: "test", runId: "run-1" },
    {
      bash: mockBashFail,
      neuralLink: mockNeuralLink as never,
      roomId: "room-1",
      participantId: "lead",
      timeoutMs: 5000,
    },
    undefined,
    { failFast: false },
  );

  const result = await pipeline.verify();

  assertEquals(result.outcome !== "passed", true);
  assertEquals(agentCalled, true, "Agent strategy should run when failFast=false");
});

Deno.test("VerificationPipeline runs deterministic strategies in parallel", async () => {
  const callOrder: string[] = [];
  const parallelBash: BashAdapter = {
    run: async (cmd: string, _cwd?: string) => {
      callOrder.push(`start:${cmd}`);
      // Simulate async work
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push(`end:${cmd}`);
      return { success: true, exitCode: 0, output: "ok", duration_ms: 10 };
    },
  };

  const pipeline = createVerificationPipeline(
    [
      { type: "build", command: "build" },
      { type: "test", command: "test" },
    ],
    { workspace: "/tmp", objective: "test", runId: "run-1" },
    { bash: parallelBash },
  );

  const result = await pipeline.verify();

  assertEquals(result.outcome, "passed");
  // Both should start before either ends (parallel execution)
  assertEquals(callOrder[0], "start:build");
  assertEquals(callOrder[1], "start:test");
});

Deno.test("VerificationPipeline failFast defaults to true", async () => {
  let agentCalled = false;
  const mockNeuralLink = {
    messageSend: async () => {
      agentCalled = true;
      return true;
    },
    waitFor: async () => ({ passed: true, details: "ok" }),
  };

  // No failFast option passed — should default to true
  const pipeline = createVerificationPipeline(
    [
      { type: "build", command: "exit 1" },
      { type: "agent", agentRole: "verifier", prompt: "Verify" },
    ],
    { workspace: "/tmp", objective: "test", runId: "run-1" },
    {
      bash: mockBashFail,
      neuralLink: mockNeuralLink as never,
      roomId: "room-1",
      participantId: "lead",
      timeoutMs: 5000,
    },
  );

  const result = await pipeline.verify();

  assertEquals(result.outcome !== "passed", true);
  assertEquals(agentCalled, false, "Agent should be skipped by default failFast=true");
});

Deno.test("VerificationPipeline in-flight guard rejects concurrent verification", async () => {
  // Use a slow bash adapter to keep verification running
  const slowBash: BashAdapter = {
    run: async (_cmd: string, _cwd?: string) => {
      await new Promise((r) => setTimeout(r, 100));
      return { success: true, exitCode: 0, output: "ok", duration_ms: 100 };
    },
  };

  const pipeline = createVerificationPipeline(
    [{ type: "build", command: "slow" }],
    { workspace: "/tmp", objective: "test", runId: "run-1" },
    { bash: slowBash },
  );

  // Start first verification (will take ~100ms)
  const first = pipeline.verify();
  // Immediately start second — should be rejected
  const second = await pipeline.verify();

  assertEquals(second.outcome, "failed");
  assertEquals(second.details, "Verification already in flight");

  // First should still complete successfully
  const firstResult = await first;
  assertEquals(firstResult.outcome, "passed");
});

Deno.test("VerificationPipeline detects stuck on same failure", async () => {
  const pipeline = createVerificationPipeline(
    [{ type: "build", command: "exit 1" }],
    { workspace: "/tmp", objective: "test", runId: "run-1" },
    { bash: mockBashFail },
    {
      maxAttempts: 10,
      baseDelayMs: 0,
      maxDelayMs: 0,
      exponentialBase: 1,
      jitterFactor: 0,
      sameFailureThreshold: 3,
    },
  );

  const result = await pipeline.verify();

  assertEquals(result.outcome !== "passed", true);
  assertEquals(result.details.startsWith("Stuck:"), true, `Expected 'Stuck:' prefix, got: ${result.details}`);
});

// --- Outcome model tests ---

Deno.test("outcome is 'passed' when all strategies pass", async () => {
  const pipeline = createVerificationPipeline(
    [{ type: "build", command: "echo success" }],
    { workspace: "/tmp", objective: "test", runId: "run-1" },
    { bash: mockBashPass },
  );

  const result = await pipeline.verify();

  assertEquals(result.outcome, "passed");
});

Deno.test("outcome is 'failed' when strategy fails", async () => {
  const pipeline = createVerificationPipeline(
    [{ type: "build", command: "exit 1" }],
    { workspace: "/tmp", objective: "test", runId: "run-1" },
    { bash: mockBashFail },
    {
      maxAttempts: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      exponentialBase: 1,
      jitterFactor: 0,
    },
  );

  const result = await pipeline.verify();

  assertEquals(result.outcome, "failed");
});

Deno.test("outcome is 'stuck' on same failure detection", async () => {
  const pipeline = createVerificationPipeline(
    [{ type: "build", command: "exit 1" }],
    { workspace: "/tmp", objective: "test", runId: "run-1" },
    { bash: mockBashFail },
    {
      maxAttempts: 10,
      baseDelayMs: 0,
      maxDelayMs: 0,
      exponentialBase: 1,
      jitterFactor: 0,
      sameFailureThreshold: 3,
    },
  );

  const result = await pipeline.verify();

  assertEquals(result.outcome, "stuck");
});

Deno.test("outcome is 'timeout' when maxTotalTimeMs exceeded", async () => {
  const slowBash: BashAdapter = {
    run: async (_cmd: string, _cwd?: string) => {
      await new Promise((r) => setTimeout(r, 50));
      return { success: false, exitCode: 1, output: "fail", duration_ms: 50 };
    },
  };

  const pipeline = createVerificationPipeline(
    [{ type: "build", command: "slow" }],
    { workspace: "/tmp", objective: "test", runId: "run-1" },
    { bash: slowBash },
    {
      maxAttempts: 100,
      baseDelayMs: 0,
      maxDelayMs: 0,
      exponentialBase: 1,
      jitterFactor: 0,
      maxTotalTimeMs: 1, // 1ms — will timeout immediately on second attempt
    },
  );

  const result = await pipeline.verify();

  assertEquals(result.outcome, "timeout");
});

Deno.test("outcome is always a valid VerificationOutcome value", async () => {
  const validOutcomes = new Set(["passed", "failed", "timeout", "stuck"]);

  const passPipeline = createVerificationPipeline(
    [{ type: "build", command: "echo ok" }],
    { workspace: "/tmp", objective: "test", runId: "run-1" },
    { bash: mockBashPass },
  );
  const passResult = await passPipeline.verify();
  assertEquals(validOutcomes.has(passResult.outcome), true);

  const failPipeline = createVerificationPipeline(
    [{ type: "build", command: "exit 1" }],
    { workspace: "/tmp", objective: "test", runId: "run-1" },
    { bash: mockBashFail },
    { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, exponentialBase: 1, jitterFactor: 0 },
  );
  const failResult = await failPipeline.verify();
  assertEquals(validOutcomes.has(failResult.outcome), true);
});

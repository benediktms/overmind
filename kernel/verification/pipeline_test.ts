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

  assertEquals(result.passed, true);
});

Deno.test("VerificationPipeline fails when any strategy fails", async () => {
  const pipeline = createVerificationPipeline(
    [{ type: "build", command: "exit 1" }],
    { workspace: "/tmp", objective: "test", runId: "run-1" },
    { bash: mockBashFail },
  );

  const result = await pipeline.verify();

  assertEquals(result.passed, false);
});

Deno.test("VerificationPipeline returns evidence on success", async () => {
  const pipeline = createVerificationPipeline(
    [{ type: "lsp", files: ["/tmp/test.ts"] }],
    { workspace: "/tmp", objective: "test", runId: "run-1" },
    { lsp: mockLsp },
  );

  const result = await pipeline.verify();

  assertEquals(result.passed, true);
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

  assertEquals(result.passed, false);
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
  assertEquals(result.passed, true);
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

  assertEquals(result.passed, true);
});

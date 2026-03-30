import type {
  AgentStrategy,
  BuildOutput,
  BuildStrategy,
  CompositeStrategy,
  Diagnostic,
  EvidenceArtifact,
  LspStrategy,
  TestResultSummary,
  TestStrategy,
  VerificationEvidence,
  VerificationResult,
  VerificationStrategy,
} from "./types.ts";

export interface VerificationContext {
  workspace: string;
  objective: string;
  runId: string;
}

export interface LspAdapter {
  diagnostics(filePath: string): Promise<Diagnostic[]>;
}

export interface BashAdapter {
  run(command: string, cwd?: string): Promise<BuildOutput>;
}

export interface NeuralLinkAdapter {
  messageSend(params: {
    roomId: string;
    from: string;
    kind: string;
    summary: string;
    to?: string;
    body?: string;
  }): Promise<boolean>;
  waitFor(
    roomId: string,
    participantId: string,
    timeoutMs: number,
    kinds?: string[],
  ): Promise<unknown | null>;
}

export async function executeLspStrategy(
  strategy: LspStrategy,
  context: VerificationContext,
  lsp: LspAdapter,
): Promise<{ evidence: EvidenceArtifact[]; diagnostics: Diagnostic[] }> {
  const allDiagnostics: Diagnostic[] = [];
  const artifacts: EvidenceArtifact[] = [];

  for (const file of strategy.files) {
    const fileDiagnostics = await lsp.diagnostics(file);
    allDiagnostics.push(...fileDiagnostics);

    const errorCount = fileDiagnostics.filter((d) => d.severity === "error").length;
    const warningCount = fileDiagnostics.filter((d) => d.severity === "warning").length;

    artifacts.push({
      type: "diagnostic",
      path: file,
      summary: `${errorCount} errors, ${warningCount} warnings`,
    });
  }

  return { evidence: artifacts, diagnostics: allDiagnostics };
}

export async function executeBuildStrategy(
  strategy: BuildStrategy,
  context: VerificationContext,
  bash: BashAdapter,
): Promise<{ evidence: EvidenceArtifact; buildOutput: BuildOutput }> {
  const result = await bash.run(strategy.command, strategy.cwd ?? context.workspace);

  const artifact: EvidenceArtifact = {
    type: "build",
    path: strategy.command,
    summary: result.success ? `Build succeeded (${result.duration_ms}ms)` : `Build failed: ${result.output}`,
  };

  return { evidence: artifact, buildOutput: result };
}

export async function executeTestStrategy(
  strategy: TestStrategy,
  context: VerificationContext,
  bash: BashAdapter,
): Promise<{ evidence: EvidenceArtifact; testResults: TestResultSummary }> {
  const result = await bash.run(strategy.command, strategy.cwd ?? context.workspace);

  const testResults = parseTestOutput(result);

  const artifact: EvidenceArtifact = {
    type: "test",
    path: strategy.command,
    summary: `${testResults.passed} passed, ${testResults.failed} failed, ${testResults.skipped} skipped`,
  };

  return { evidence: artifact, testResults };
}

function parseTestOutput(output: BuildOutput): TestResultSummary {
  const passed = (output.output.match(/\u2713|passed|PASS/g) || []).length;
  const failed = (output.output.match(/\u2717|failed|FAIL/g) || []).length;
  const skipped = (output.output.match(/skipped|SKIP/g) || []).length;

  return {
    passed,
    failed,
    skipped,
    duration_ms: output.duration_ms,
    output: output.output,
  };
}

export async function executeAgentStrategy(
  strategy: AgentStrategy,
  context: VerificationContext,
  neuralLink: NeuralLinkAdapter,
  roomId: string,
  participantId: string,
  timeoutMs: number,
): Promise<{ evidence: EvidenceArtifact; passed: boolean; details: string }> {
  await neuralLink.messageSend({
    roomId,
    from: participantId,
    kind: "review_request",
    summary: `Agent verification: ${strategy.agentRole}`,
    to: strategy.agentRole,
    body: strategy.prompt,
  });

  const response = await neuralLink.waitFor(roomId, participantId, timeoutMs, ["review_result"]);

  const passed = isReviewResultPassed(response);
  const details = extractReviewDetails(response);

  const artifact: EvidenceArtifact = {
    type: "diagnostic",
    summary: `Agent ${strategy.agentRole}: ${passed ? "passed" : "failed"} - ${details}`,
  };

  return { evidence: artifact, passed, details };
}

function isReviewResultPassed(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (value as Record<string, unknown>).passed === true;
}

function extractReviewDetails(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return "no response";
  }
  const record = value as Record<string, unknown>;
  if (typeof record.details === "string") {
    return record.details;
  }
  return "verification completed";
}

export async function executeCompositeStrategy(
  strategy: CompositeStrategy,
  context: VerificationContext,
  deps: {
    lsp?: LspAdapter;
    bash?: BashAdapter;
    neuralLink?: NeuralLinkAdapter;
    roomId?: string;
    participantId?: string;
    timeoutMs?: number;
  },
  executeSingle: (s: VerificationStrategy) => Promise<VerificationResult>,
): Promise<VerificationResult> {
  const results: VerificationResult[] = [];

  for (const sub of strategy.strategies) {
    const result = await executeSingle(sub);
    results.push(result);
  }

  const passed = strategy.mode === "all"
    ? results.every((r) => r.passed)
    : results.some((r) => r.passed);

  const allEvidence = results.flatMap((r) => [r.evidence]);
  const allFailedTasks = results.flatMap((r) => r.failedTasks);
  const allRecommendations = results.flatMap((r) => r.recommendations);

  const confidence = strategy.mode === "all"
    ? Math.min(...results.map((r) => r.confidence))
    : results.find((r) => r.passed)?.confidence ?? 0;

  return {
    passed,
    confidence,
    details: `${strategy.mode} mode: ${passed ? "all strategies passed" : "some strategies failed"}`,
    evidence: {
      trigger: { type: "automated", source: "agent" },
      timestamp: new Date().toISOString(),
      duration_ms: 0,
      artifacts: [],
      diagnostics: [],
    },
    failedTasks: allFailedTasks,
    recommendations: allRecommendations,
  };
}

export function mergeEvidenceResults(
  results: VerificationResult[],
  trigger: { type: "manual" | "automated" | "scheduled"; source: "agent" | "lsp" | "build" | "test" },
): VerificationEvidence {
  const allArtifacts: EvidenceArtifact[] = [];
  const allDiagnostics: Diagnostic[] = [];
  let totalDuration = 0;
  let testResults: TestResultSummary | undefined;
  let buildOutput: BuildOutput | undefined;

  for (const result of results) {
    allArtifacts.push(...result.evidence.artifacts);
    allDiagnostics.push(...result.evidence.diagnostics);
    totalDuration += result.evidence.duration_ms;
    if (result.evidence.testResults) {
      testResults = result.evidence.testResults;
    }
    if (result.evidence.buildOutput) {
      buildOutput = result.evidence.buildOutput;
    }
  }

  return {
    trigger,
    timestamp: new Date().toISOString(),
    duration_ms: totalDuration,
    artifacts: allArtifacts,
    diagnostics: allDiagnostics,
    testResults,
    buildOutput,
  };
}

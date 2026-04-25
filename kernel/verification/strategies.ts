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
import { isObject } from "../utils.ts";

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
  const text = output.output;

  const summaryMatch = text.match(/(\d+)\s+(?:test(?:s)?\s+)?passed/i)
    || text.match(/(?:^|\s)(\d+)\s+(?:passed|ok)/im);
  const failedMatch = text.match(/(\d+)\s+(?:test(?:s)?\s+)?failed/i)
    || text.match(/(?:^|\s)(\d+)\s+(?:failed|FAIL)/im);
  const skippedMatch = text.match(/(\d+)\s+(?:test(?:s)?\s+)?skipped/i)
    || text.match(/(?:^|\s)(\d+)\s+(?:skipped|SKIP)/im);

  const passed = summaryMatch ? parseInt(summaryMatch[1], 10) : (output.success ? 0 : 0);
  const failed = failedMatch ? parseInt(failedMatch[1], 10) : (!output.success ? 1 : 0);
  const skipped = skippedMatch ? parseInt(skippedMatch[1], 10) : 0;

  return {
    passed,
    failed,
    skipped,
    duration_ms: output.duration_ms,
    output: text,
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
  if (!isObject(value)) {
    return false;
  }
  return value.passed === true;
}

function extractReviewDetails(value: unknown): string {
  if (!isObject(value)) {
    return "no response";
  }
  if (typeof value.details === "string") {
    return value.details;
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

  const allPassed = strategy.mode === "all"
    ? results.every((r) => r.outcome === "passed")
    : results.some((r) => r.outcome === "passed");

  const allFailedTasks = results.flatMap((r) => r.failedTasks);
  const allRecommendations = results.flatMap((r) => r.recommendations);

  const confidence = strategy.mode === "all"
    ? (results.length === 0 ? 0 : Math.min(...results.map((r) => r.confidence)))
    : (results.find((r) => r.outcome === "passed")?.confidence ?? 0);

  const evidence = mergeEvidenceResults(results, { type: "automated", source: "agent" });

  return {
    outcome: allPassed ? "passed" : "failed",
    confidence,
    details: `${strategy.mode} mode: ${allPassed ? "all strategies passed" : "some strategies failed"}`,
    evidence,
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

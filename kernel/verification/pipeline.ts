import type {
  AgentStrategy,
  BuildStrategy,
  CompositeStrategy,
  LspStrategy,
  RetryPolicy,
  RetryState,
  TestStrategy,
  VerificationEvidence,
  VerificationPipelineConfig,
  VerificationResult,
  VerificationStrategy,
} from "./types.ts";
import { DEFAULT_RETRY_POLICY } from "./types.ts";
import {
  canAttemptFromHalfOpen,
  computeDelayMs,
  createRetryState,
  incrementAttempt,
  isEvidenceStale,
  isStuckOnSameFailure,
  recordFailure,
  recordNormalizedFailure,
  recordSuccess,
  shouldAttemptNow,
  shouldRetry,
  sleep,
  transitionToHalfOpen,
} from "./retry.ts";
import {
  executeAgentStrategy,
  executeBuildStrategy,
  executeCompositeStrategy,
  executeLspStrategy,
  executeTestStrategy,
  mergeEvidenceResults,
  type BashAdapter,
  type LspAdapter,
  type NeuralLinkAdapter,
  type VerificationContext,
} from "./strategies.ts";

export class VerificationPipeline {
  private readonly config: VerificationPipelineConfig;
  private readonly context: VerificationContext;
  private readonly deps: {
    lsp?: LspAdapter;
    bash?: BashAdapter;
    neuralLink?: NeuralLinkAdapter;
    roomId?: string;
    participantId?: string;
    timeoutMs?: number;
  };

  constructor(
    config: VerificationPipelineConfig,
    context: VerificationContext,
    deps: {
      lsp?: LspAdapter;
      bash?: BashAdapter;
      neuralLink?: NeuralLinkAdapter;
      roomId?: string;
      participantId?: string;
      timeoutMs?: number;
    },
  ) {
    this.config = config;
    this.context = context;
    this.deps = deps;
  }

  private _isVerifying = false;

  async verify(): Promise<VerificationResult> {
    // In-flight guard: reject concurrent verification
    if (this._isVerifying) {
      return this.createErrorResult("Verification already in flight");
    }
    this._isVerifying = true;

    try {
      return await this._verifyLoop();
    } finally {
      this._isVerifying = false;
    }
  }

  private async _verifyLoop(): Promise<VerificationResult> {
    const startTime = Date.now();
    let retryState = createRetryState();

    while (true) {
      const elapsed = Date.now() - startTime;
      const maxTotal = this.config.retry.maxTotalTimeMs ?? 600000;
      if (elapsed >= maxTotal) {
        return this.createTimeoutResult(retryState, elapsed);
      }

      if (retryState.circuitState === "open") {
        const lastAttemptMs = new Date(retryState.lastAttempt).getTime();
        if (!shouldAttemptNow(retryState, this.config.retry, lastAttemptMs)) {
          return this.createOpenCircuitResult(retryState);
        }
        retryState = transitionToHalfOpen(retryState);
      }

      if (retryState.circuitState === "half-open") {
        if (!canAttemptFromHalfOpen(retryState, this.config.retry)) {
          return this.createOpenCircuitResult(retryState);
        }
      }

      const result = await this.executeStrategies();

      if (result.passed) {
        // Evidence staleness check: warn if evidence is old
        const maxAge = this.config.maxEvidenceAgeMs ?? 300_000;
        if (isEvidenceStale(result.evidence.timestamp, maxAge)) {
          result.recommendations.push("Evidence is stale — consider re-running verification");
        }
        retryState = recordSuccess(retryState);
        return result;
      }

      retryState = recordNormalizedFailure(retryState, result.details);
      retryState = recordFailure(retryState, this.config.retry);
      retryState = incrementAttempt(retryState);

      // Same-failure detection: stop early if stuck
      if (isStuckOnSameFailure(retryState, this.config.retry)) {
        return this.createStuckResult(result, retryState);
      }

      const delayMs = computeDelayMs(retryState, this.config.retry);
      retryState = {
        ...retryState,
        totalDelayMs: retryState.totalDelayMs + delayMs,
        totalWallClockMs: elapsed + delayMs,
      };

      if (!shouldRetry(retryState, this.config.retry)) {
        return this.enhanceResultWithRetryContext(result, retryState);
      }

      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  private async executeStrategies(): Promise<VerificationResult> {
    const { deterministic, agent, composite } = this.partitionStrategies();
    const failFast = this.config.failFast ?? true;
    const allResults: VerificationResult[] = [];

    // Phase 1: Run deterministic strategies (LSP, Build, Test) in parallel
    if (deterministic.length > 0) {
      const settled = await Promise.allSettled(
        deterministic.map((s) => this.executeSingleStrategy(s)),
      );
      for (const outcome of settled) {
        allResults.push(
          outcome.status === "fulfilled"
            ? outcome.value
            : this.createErrorResult(`Strategy error: ${outcome.reason}`),
        );
      }

      // Fail-fast: skip agent strategies if deterministic gates failed
      if (failFast && allResults.some((r) => !r.passed)) {
        return this.aggregateResults(allResults);
      }
    }

    // Phase 2: Run agent strategies sequentially (only if deterministic passed or failFast=false)
    for (const strategy of agent) {
      allResults.push(await this.executeSingleStrategy(strategy));
    }

    // Phase 3: Run composite strategies
    for (const strategy of composite) {
      allResults.push(await this.executeSingleStrategy(strategy));
    }

    return this.aggregateResults(allResults);
  }

  private partitionStrategies(): {
    deterministic: VerificationStrategy[];
    agent: VerificationStrategy[];
    composite: VerificationStrategy[];
  } {
    const deterministic: VerificationStrategy[] = [];
    const agent: VerificationStrategy[] = [];
    const composite: VerificationStrategy[] = [];

    for (const s of this.config.strategies) {
      if (s.type === "lsp" || s.type === "build" || s.type === "test") {
        deterministic.push(s);
      } else if (s.type === "agent") {
        agent.push(s);
      } else {
        composite.push(s);
      }
    }

    return { deterministic, agent, composite };
  }

  private aggregateResults(results: VerificationResult[]): VerificationResult {
    const passed = results.every((r) => r.passed);
    const confidence = results.length === 0 ? 0 : Math.min(...results.map((r) => r.confidence));
    const details = passed
      ? `All ${results.length} strategies passed`
      : `Failed strategies: ${results.filter((r) => !r.passed).map((r) => r.details).join("; ")}`;

    const evidence = mergeEvidenceResults(results, { type: "automated", source: "agent" });
    const failedTasks = results.flatMap((r) => r.failedTasks);
    const recommendations = results.flatMap((r) => r.recommendations);

    return {
      passed,
      confidence,
      details,
      evidence,
      failedTasks,
      recommendations,
    };
  }

  private async executeSingleStrategy(strategy: VerificationStrategy): Promise<VerificationResult> {
    const startTime = Date.now();

    try {
      if (strategy.type === "lsp") {
        return await this.executeLsp(strategy);
      } else if (strategy.type === "build") {
        return await this.executeBuild(strategy);
      } else if (strategy.type === "test") {
        return await this.executeTest(strategy);
      } else if (strategy.type === "agent") {
        return await this.executeAgent(strategy);
      } else if (strategy.type === "composite") {
        return await this.executeComposite(strategy);
      }

      return this.createErrorResult(`Unknown strategy type: ${(strategy as { type: string }).type}`);
    } catch (error) {
      const duration = Date.now() - startTime;
      return {
        passed: false,
        confidence: 0,
        details: `Strategy execution error: ${error instanceof Error ? error.message : String(error)}`,
        evidence: {
          trigger: { type: "automated", source: "agent" },
          timestamp: new Date().toISOString(),
          duration_ms: duration,
          artifacts: [],
          diagnostics: [],
        },
        failedTasks: [],
        recommendations: ["Check strategy configuration and dependencies"],
      };
    }
  }

  private async executeLsp(strategy: LspStrategy): Promise<VerificationResult> {
    if (!this.deps.lsp) {
      return this.createErrorResult("LSP adapter not configured");
    }

    const { diagnostics, evidence } = await executeLspStrategy(strategy, this.context, this.deps.lsp);
    const errors = diagnostics.filter((d) => d.severity === "error");

    return {
      passed: errors.length === 0,
      confidence: errors.length === 0 ? 1.0 : 0.5,
      details: errors.length === 0
        ? "No LSP errors found"
        : `Found ${errors.length} LSP errors`,
      evidence: {
        trigger: { type: "automated", source: "lsp" },
        timestamp: new Date().toISOString(),
        duration_ms: 0,
        artifacts: evidence,
        diagnostics,
      },
      failedTasks: errors.length > 0
        ? [{ taskId: "lsp", reason: `${errors.length} errors`, evidence: [] }]
        : [],
      recommendations: [],
    };
  }

  private async executeBuild(strategy: BuildStrategy): Promise<VerificationResult> {
    if (!this.deps.bash) {
      return this.createErrorResult("Bash adapter not configured");
    }

    const { buildOutput, evidence } = await executeBuildStrategy(strategy, this.context, this.deps.bash);

    return {
      passed: buildOutput.success,
      confidence: 1.0,
      details: buildOutput.success
        ? `Build succeeded in ${buildOutput.duration_ms}ms`
        : `Build failed: ${buildOutput.output}`,
      evidence: {
        trigger: { type: "automated", source: "build" },
        timestamp: new Date().toISOString(),
        duration_ms: buildOutput.duration_ms,
        artifacts: [evidence],
        diagnostics: [],
        buildOutput,
      },
      failedTasks: buildOutput.success
        ? []
        : [{ taskId: "build", reason: `Exit code ${buildOutput.exitCode}`, evidence: [evidence] }],
      recommendations: buildOutput.success ? [] : ["Check build configuration and dependencies"],
    };
  }

  private async executeTest(strategy: TestStrategy): Promise<VerificationResult> {
    if (!this.deps.bash) {
      return this.createErrorResult("Bash adapter not configured");
    }

    const { testResults, evidence } = await executeTestStrategy(strategy, this.context, this.deps.bash);
    const passed = testResults.failed === 0;

    return {
      passed,
      confidence: 0.9,
      details: passed
        ? `All tests passed (${testResults.passed} passed, ${testResults.skipped} skipped)`
        : `${testResults.failed} tests failed, ${testResults.passed} passed`,
      evidence: {
        trigger: { type: "automated", source: "test" },
        timestamp: new Date().toISOString(),
        duration_ms: testResults.duration_ms,
        artifacts: [evidence],
        diagnostics: [],
        testResults,
      },
      failedTasks: passed
        ? []
        : [{ taskId: "tests", reason: `${testResults.failed} failed`, evidence: [evidence] }],
      recommendations: passed ? [] : ["Review failed tests and fix underlying issues"],
    };
  }

  private async executeAgent(strategy: AgentStrategy): Promise<VerificationResult> {
    if (!this.deps.neuralLink || !this.deps.roomId || !this.deps.participantId || !this.deps.timeoutMs) {
      return this.createErrorResult("NeuralLink adapter not configured for agent verification");
    }

    const { evidence, passed, details } = await executeAgentStrategy(
      strategy,
      this.context,
      this.deps.neuralLink,
      this.deps.roomId,
      this.deps.participantId,
      this.deps.timeoutMs,
    );

    return {
      passed,
      confidence: 0.8,
      details,
      evidence: {
        trigger: { type: "automated", source: "agent" },
        timestamp: new Date().toISOString(),
        duration_ms: 0,
        artifacts: [evidence],
        diagnostics: [],
      },
      failedTasks: passed ? [] : [{ taskId: strategy.agentRole, reason: details, evidence: [evidence] }],
      recommendations: passed ? [] : ["Review agent verification feedback and address issues"],
    };
  }

  private async executeComposite(strategy: CompositeStrategy): Promise<VerificationResult> {
    return executeCompositeStrategy(strategy, this.context, this.deps, async (s) => this.executeSingleStrategy(s));
  }

  private createErrorResult(message: string): VerificationResult {
    return {
      passed: false,
      confidence: 0,
      details: message,
      evidence: {
        trigger: { type: "manual", source: "agent" },
        timestamp: new Date().toISOString(),
        duration_ms: 0,
        artifacts: [],
        diagnostics: [],
      },
      failedTasks: [{ taskId: "pipeline", reason: message, evidence: [] }],
      recommendations: ["Check pipeline configuration"],
    };
  }

  private createOpenCircuitResult(retryState: RetryState): VerificationResult {
    return {
      passed: false,
      confidence: 0,
      details: `Circuit breaker open: ${retryState.consecutiveFailures} consecutive failures`,
      evidence: {
        trigger: { type: "manual", source: "agent" },
        timestamp: new Date().toISOString(),
        duration_ms: 0,
        artifacts: [],
        diagnostics: [],
      },
      failedTasks: [{ taskId: "circuit-breaker", reason: "Open circuit", evidence: [] }],
      recommendations: ["Circuit breaker is open - manual intervention required"],
    };
  }

  private createStuckResult(lastResult: VerificationResult, retryState: RetryState): VerificationResult {
    const threshold = this.config.retry.sameFailureThreshold ?? 3;
    return {
      ...lastResult,
      details: `Stuck: same failure repeated ${threshold} times — ${lastResult.details}`,
      recommendations: [
        ...lastResult.recommendations,
        "Same failure detected repeatedly — manual intervention or a different approach is needed",
      ],
    };
  }

  private createTimeoutResult(retryState: RetryState, elapsedMs: number): VerificationResult {
    return {
      passed: false,
      confidence: 0,
      details: `Verification timed out after ${elapsedMs}ms (${retryState.attempt} attempts)`,
      evidence: {
        trigger: { type: "manual", source: "agent" },
        timestamp: new Date().toISOString(),
        duration_ms: elapsedMs,
        artifacts: [],
        diagnostics: [],
      },
      failedTasks: [{ taskId: "timeout", reason: `Timed out after ${elapsedMs}ms`, evidence: [] }],
      recommendations: ["Increase maxTotalTimeMs or reduce retry policy"],
    };
  }

  private enhanceResultWithRetryContext(result: VerificationResult, retryState: RetryState): VerificationResult {
    return {
      ...result,
      details: `${result.details} (after ${retryState.attempt} attempts, ${retryState.totalDelayMs}ms total delay)`,
    };
  }
}

export function createVerificationPipeline(
  strategies: VerificationStrategy[],
  context: VerificationContext,
  deps: {
    lsp?: LspAdapter;
    bash?: BashAdapter;
    neuralLink?: NeuralLinkAdapter;
    roomId?: string;
    participantId?: string;
    timeoutMs?: number;
  },
  retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
  options?: { failFast?: boolean },
): VerificationPipeline {
  return new VerificationPipeline(
    { strategies, retry: retryPolicy, collectEvidence: true, failFast: options?.failFast },
    context,
    deps,
  );
}

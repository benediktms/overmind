/**
 * Verification evidence and result types for the verification pipeline.
 */

export interface VerificationTrigger {
  type: "manual" | "automated" | "scheduled";
  source: "agent" | "lsp" | "build" | "test";
}

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  source: string;
  message: string;
  file?: string;
  line?: number;
}

export interface EvidenceArtifact {
  type: "file" | "diagnostic" | "test" | "build";
  path?: string;
  content?: string;
  summary: string;
}

export interface TestResultSummary {
  passed: number;
  failed: number;
  skipped: number;
  duration_ms: number;
  output?: string;
}

export interface BuildOutput {
  success: boolean;
  exitCode: number;
  output: string;
  duration_ms: number;
}

export interface VerificationEvidence {
  trigger: VerificationTrigger;
  timestamp: string;
  duration_ms: number;
  artifacts: EvidenceArtifact[];
  diagnostics: Diagnostic[];
  testResults?: TestResultSummary;
  buildOutput?: BuildOutput;
}

export interface FailedTask {
  taskId: string;
  reason: string;
  evidence: EvidenceArtifact[];
}

export interface VerificationResult {
  passed: boolean;
  confidence: number; // 0.0 - 1.0
  details: string;
  evidence: VerificationEvidence;
  failedTasks: FailedTask[];
  recommendations: string[];
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  exponentialBase: number;
  jitterFactor: number;
  maxTotalTimeMs?: number;
  circuitBreaker?: CircuitBreakerConfig;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxAttempts: number;
}

export type CircuitState = "closed" | "open" | "half-open";

export interface RetryState {
  attempt: number;
  totalDelayMs: number;
  lastAttempt: string;
  circuitState: CircuitState;
  consecutiveFailures: number;
  totalWallClockMs: number;
}

export type VerificationStrategy =
  | LspStrategy
  | BuildStrategy
  | TestStrategy
  | AgentStrategy
  | CompositeStrategy;

export interface LspStrategy {
  type: "lsp";
  files: string[];
}

export interface BuildStrategy {
  type: "build";
  command: string;
  cwd?: string;
}

export interface TestStrategy {
  type: "test";
  command: string;
  cwd?: string;
  coverage?: boolean;
}

export interface AgentStrategy {
  type: "agent";
  agentRole: string;
  prompt: string;
}

export interface CompositeStrategy {
  type: "composite";
  strategies: VerificationStrategy[];
  mode: "all" | "any";
}

export interface VerificationPipelineConfig {
  strategies: VerificationStrategy[];
  retry: RetryPolicy;
  collectEvidence: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  exponentialBase: 2,
  jitterFactor: 0.1,
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeoutMs: 60000,
    halfOpenMaxAttempts: 2,
  },
};

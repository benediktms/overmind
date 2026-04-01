import { Mode } from "../types.ts";
import type { AgentRole } from "../agents/roles.ts";

export interface TaskNode {
  id: string;
  title: string;
  description: string;
  agentRole: AgentRole;
  dependencies: string[];
  acceptanceCriteria: string[];
  estimatedEffort?: "small" | "medium" | "large";
}

export interface TaskGraph {
  tasks: TaskNode[];
  parallelGroups: string[][];
  entryPoints: string[];
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  fileReferenceCoverage?: number;
  acceptanceCriteriaCoverage?: number;
}

export interface ValidationIssue {
  severity: "error" | "warning" | "info";
  taskId?: string;
  message: string;
}

export interface PlanContext {
  objective: string;
  workspace: string;
  interviewResponses?: Array<{ question: string; answer: string }>;
  previousAttempts?: TaskGraph[];
}

export interface Planner {
  plan(context: PlanContext): Promise<TaskGraph>;
  validate(graph: TaskGraph): Promise<ValidationResult>;
}

export function isScoutPattern(graph: TaskGraph): boolean {
  const hasNoDependencies = graph.tasks.every((t) => t.dependencies.length === 0);
  const isExplorationFocused = graph.tasks.some((t) =>
    /\b(explore|investigate|research|find|map)\b/i.test(t.title)
  );
  return hasNoDependencies && isExplorationFocused;
}

export function isRelayPattern(graph: TaskGraph): boolean {
  const hasSequentialDeps = graph.tasks.some((t) => t.dependencies.length > 0
  );
  const hasVerification = graph.tasks.some((t) =>
    /\b(verify|validate|test|check)\b/i.test(t.title)
  );
  return hasSequentialDeps && hasVerification;
}

export function isSwarmPattern(graph: TaskGraph): boolean {
  const hasParallelStructure = graph.parallelGroups.length > 0;
  const hasGlobalVerification = graph.tasks.some((t) =>
    t.dependencies.length > 1 &&
    /\b(verify|validate|integrate)\b/i.test(t.title)
  );
  return hasParallelStructure && hasGlobalVerification;
}

export function determineExecutionMode(graph: TaskGraph): Mode {
  if (isScoutPattern(graph)) return Mode.Scout;
  if (isRelayPattern(graph)) return Mode.Relay;
  if (isSwarmPattern(graph)) return Mode.Swarm;

  const parallelTasks = graph.tasks.filter((t) => t.dependencies.length === 0)
    .length;
  const totalTasks = graph.tasks.length;

  if (parallelTasks === totalTasks) return Mode.Scout;
  if (parallelTasks <= 2 && totalTasks > 3) return Mode.Relay;
  return Mode.Swarm;
}

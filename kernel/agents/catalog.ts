import type { BaseAgentRole } from "./roles.ts";

export type AgentTier = "worker" | "coordinator";
export type ModelTier = "haiku" | "sonnet" | "opus";

export interface AgentDefinition {
  name: BaseAgentRole;
  tier: AgentTier;
  model: ModelTier;
  spawns: BaseAgentRole[];
  capabilities: string[];
  dispatchTriggers: string[];
}

const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    name: "cortex",
    tier: "worker",
    model: "opus",
    spawns: [],
    capabilities: [
      "architecture analysis",
      "complex debugging",
      "root-cause investigation",
      "system tradeoff evaluation",
    ],
    dispatchTriggers: [
      "architecture-heavy debugging",
      "cross-system tradeoff analysis",
      "integration-risk evaluation",
      "root-cause investigation for complex failures",
    ],
  },
  {
    name: "archivist",
    tier: "worker",
    model: "sonnet",
    spawns: [],
    capabilities: [
      "documentation synthesis",
      "codebase exploration",
      "module boundary mapping",
      "knowledge preservation",
    ],
    dispatchTriggers: [
      "repository mapping",
      "module boundary discovery",
      "documentation synthesis",
      "knowledge preservation for future contributors",
    ],
  },
  {
    name: "probe",
    tier: "worker",
    model: "haiku",
    spawns: [],
    capabilities: [
      "fast reconnaissance",
      "usage tracing",
      "import graph discovery",
      "lightweight symbol lookup",
    ],
    dispatchTriggers: [
      "fast symbol lookup",
      "usage tracing",
      "import/dependency reconnaissance",
      "first-pass codebase search",
    ],
  },
  {
    name: "liaison",
    tier: "worker",
    model: "sonnet",
    spawns: [],
    capabilities: [
      "frontend implementation",
      "UX and design decisions",
      "accessibility-sensitive changes",
      "external API integration",
    ],
    dispatchTriggers: [
      "frontend implementation",
      "UX/design decisions",
      "accessibility-sensitive changes",
      "user-facing external API integration",
    ],
  },
  {
    name: "drone",
    tier: "worker",
    model: "sonnet",
    spawns: [],
    capabilities: [
      "scoped implementation",
      "pattern-matched code changes",
      "function-level delivery",
      "tested code production",
    ],
    dispatchTriggers: [
      "clear implementation tasks",
      "scoped code changes",
      "direct feature coding",
      "function-level delivery",
    ],
  },
  {
    name: "verifier",
    tier: "worker",
    model: "sonnet",
    spawns: [],
    capabilities: [
      "acceptance validation",
      "quality gate review",
      "pass fail assessment",
      "implementation verification",
    ],
    dispatchTriggers: [
      "post-implementation validation",
      "acceptance checks",
      "quality-gate handoff",
      "release-readiness review",
    ],
  },
  {
    name: "planner",
    tier: "coordinator",
    model: "opus",
    spawns: ["probe", "archivist"],
    capabilities: [
      "work decomposition",
      "execution sequencing",
      "dependency analysis",
      "implementation planning",
    ],
    dispatchTriggers: [
      "multi-step objectives",
      "unclear implementation path",
      "dependency-heavy delivery planning",
      "execution sequencing requests",
    ],
  },
  {
    name: "architect",
    tier: "worker",
    model: "opus",
    spawns: [],
    capabilities: [
      "system design",
      "API contract definition",
      "data model design",
      "boundary setting",
    ],
    dispatchTriggers: [
      "high-level system design",
      "API and data model definition",
      "architecture tradeoff evaluation",
      "boundary-setting decisions",
    ],
  },
  {
    name: "debugger",
    tier: "worker",
    model: "sonnet",
    spawns: [],
    capabilities: [
      "defect reproduction",
      "root-cause isolation",
      "small safe fixes",
      "regression verification",
    ],
    dispatchTriggers: [
      "defect triage and remediation",
      "failing tests investigation",
      "runtime error diagnosis",
      "regression repair",
    ],
  },
  {
    name: "code-reviewer",
    tier: "worker",
    model: "sonnet",
    spawns: [],
    capabilities: [
      "correctness review",
      "logic error detection",
      "edge case review",
      "pattern adherence checking",
    ],
    dispatchTriggers: [
      "code review requests",
      "diff inspection tasks",
      "correctness validation",
      "pre-merge review",
    ],
  },
  {
    name: "sentinel",
    tier: "worker",
    model: "opus",
    spawns: [],
    capabilities: [
      "security auditing",
      "auth and authz checks",
      "secret exposure detection",
      "unsafe pattern review",
    ],
    dispatchTriggers: [
      "security audits",
      "auth checks",
      "vulnerability triage",
      "OWASP-focused reviews",
    ],
  },
  {
    name: "guardian",
    tier: "worker",
    model: "sonnet",
    spawns: [],
    capabilities: [
      "test authoring",
      "coverage gap analysis",
      "regression test design",
      "test strategy planning",
    ],
    dispatchTriggers: [
      "test authoring",
      "coverage gap analysis",
      "regression test requests",
      "test planning",
    ],
  },
  {
    name: "style-reviewer",
    tier: "worker",
    model: "haiku",
    spawns: [],
    capabilities: [
      "style consistency checks",
      "naming audits",
      "formatting review",
      "lint follow-up",
    ],
    dispatchTriggers: [
      "lint follow-up",
      "style consistency checks",
      "naming audits",
      "formatting conformance",
    ],
  },
  {
    name: "gauge",
    tier: "worker",
    model: "sonnet",
    spawns: [],
    capabilities: [
      "performance regression review",
      "algorithmic analysis",
      "scalability checks",
      "hot path inspection",
    ],
    dispatchTriggers: [
      "performance regressions",
      "profiling follow-up",
      "algorithmic review",
      "scalability checks",
    ],
  },
];

export const AGENT_CATALOG: ReadonlyMap<string, AgentDefinition> = new Map(
  AGENT_DEFINITIONS.map((agent) => [agent.name, agent]),
);

export function getAgent(name: string): AgentDefinition | undefined {
  return AGENT_CATALOG.get(name);
}

export function getAgentsByTier(tier: AgentTier): AgentDefinition[] {
  return AGENT_DEFINITIONS.filter((agent) => agent.tier === tier);
}

export function getAgentsByModel(model: ModelTier): AgentDefinition[] {
  return AGENT_DEFINITIONS.filter((agent) => agent.model === model);
}

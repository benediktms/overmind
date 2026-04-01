/** Base agent role names — the canonical catalog of agent identities. */
export type BaseAgentRole =
  | "cortex"
  | "archivist"
  | "probe"
  | "liaison"
  | "executor"
  | "verifier"
  | "planner"
  | "architect"
  | "debugger"
  | "code-reviewer"
  | "security-reviewer"
  | "test-engineer"
  | "style-reviewer"
  | "performance-reviewer";

/** An agent role, optionally suffixed with a numeric instance index (e.g. "probe-2"). */
export type AgentRole = BaseAgentRole | `${BaseAgentRole}-${number}`;

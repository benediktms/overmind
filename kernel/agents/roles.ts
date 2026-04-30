/** Base agent role names — the canonical catalog of agent identities. */
export type BaseAgentRole =
  | "cortex"
  | "archivist"
  | "probe"
  | "liaison"
  | "drone"
  | "verifier"
  | "planner"
  | "architect"
  | "debugger"
  | "code-reviewer"
  | "sentinel"
  | "guardian"
  | "style-reviewer"
  | "gauge"
  | "weaver"
  | "scribe"
  | "evolver"
  | "arbiter"
  | "contrarian"
  | "inquisitor"
  | "lacuna"
  | "neocortex"
  | "oculus"
  | "pruner";

/** An agent role, optionally suffixed with a numeric instance index (e.g. "probe-2"). */
export type AgentRole = BaseAgentRole | `${BaseAgentRole}-${number}`;

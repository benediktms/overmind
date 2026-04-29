---
name: overmind-reference
description: Quick-reference map of Overmind capabilities, modes, agents, MCP endpoints, and configuration. Use when asked what Overmind can do, which mode to pick, or which endpoint to call.
triggers:
  - overmind help
  - what can overmind do
  - available modes
  - overmind capabilities
  - how to use overmind
---

## Modes

| Mode  | Shape                              | Best for                                           |
| ----- | ---------------------------------- | -------------------------------------------------- |
| scout | Parallel Probe agents, synthesize  | Early discovery, unknown scope, dependency mapping |
| relay | Sequential Plan→Execute→Verify→Fix | Clear requirements, ordered gates, step-by-step    |
| swarm | Parallel waves + verify/fix loops  | Large scope with independent, parallelizable lanes |

Invoke all modes via
`mcp__overmind__overmind_delegate(objective, mode, priority?)`.

## Specialist agents

Full catalog in `kernel/agents/catalog.ts` (`BaseAgentRole`). Most-used roles:

| Agent          | Tier        | Model  | Role                                                          |
| -------------- | ----------- | ------ | ------------------------------------------------------------- |
| cortex         | worker      | opus   | Architecture, complex debugging, root-cause investigation     |
| archivist      | worker      | sonnet | Codebase exploration, module mapping, documentation synthesis |
| probe          | worker      | haiku  | Fast reconnaissance, usage tracing, symbol lookup             |
| liaison        | worker      | sonnet | Frontend, UX, accessibility, external API integration         |
| drone          | worker      | sonnet | Scoped implementation, pattern-matched changes                |
| verifier       | worker      | sonnet | Acceptance validation, quality-gate review                    |
| planner        | coordinator | opus   | Decomposition, sequencing, dependency analysis                |
| architect      | worker      | opus   | System design, API contracts, data models                     |
| debugger       | worker      | sonnet | Defect repro, root-cause isolation, regression repair         |
| code-reviewer  | worker      | sonnet | Correctness review, edge cases, pattern adherence             |
| sentinel       | worker      | opus   | OWASP Top 10, auth, secrets, supply-chain                     |
| guardian       | worker      | sonnet | Test authoring, coverage gaps, regression test design         |
| style-reviewer | worker      | haiku  | Style consistency, naming, formatting                         |
| gauge          | worker      | sonnet | Hot-path inspection, complexity, scalability                  |

## Overmind MCP endpoints

| Endpoint                            | Purpose                                               |
| ----------------------------------- | ----------------------------------------------------- |
| `mcp__overmind__overmind_delegate`  | Start coordinated work in scout, relay, or swarm mode |
| `mcp__overmind__overmind_status`    | Inspect current orchestration state                   |
| `mcp__overmind__overmind_cancel`    | Stop an active objective                              |
| `mcp__overmind__overmind_room_join` | Join a neural_link room from the Overmind side        |

## Brain MCP endpoints

| Endpoint                           | Purpose                             |
| ---------------------------------- | ----------------------------------- |
| `mcp__brain__tasks_create`         | Create tracked work items           |
| `mcp__brain__tasks_apply_event`    | Update task state or attach notes   |
| `mcp__brain__tasks_close`          | Mark tracked work complete          |
| `mcp__brain__memory_write_episode` | Record durable context or decisions |

## Configuration

| Setting                    | Meaning                              |
| -------------------------- | ------------------------------------ |
| `OVERMIND_NEURAL_LINK_URL` | MCP URL for neural_link coordination |
| `OVERMIND_ROOM_ID`         | Preconfigured room identifier        |
| `OVERMIND_KERNEL_HTTP_URL` | Direct kernel HTTP endpoint          |
| `OVERMIND_PARTICIPANT_ID`  | Swarm participant identity           |

## Quick decision path

1. Objective shape unknown → scout.
2. Clear step order, verification gates needed → relay.
3. Large scope, independent lanes → swarm.
4. Hard problem needing deep reasoning → cortex.
5. Discovery or repo mapping → probe or archivist.
6. Work needs tracking across sessions → brain tasks.
7. Multi-agent coordination required → neural_link room.

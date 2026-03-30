# Planner and Intent-Gate Architecture Design

## Research Summary

Based on analysis of **oh-my-opencode** (OMO, also known as **oh-my-openagent** or OMA),
this document outlines a planner-driven orchestration architecture to replace Overmind's
hardcoded mode templates.

Overmind draws inspiration from both:
- **OMO/OMA** (oh-my-opencode / oh-my-openagent) - Open-source multi-agent orchestration framework
- **OMC** (oh-my-claudecode) - Claude Code plugin with similar architecture patterns

## Core Concepts from OMO/OMA

### 1. Three-Agent Planning Layer

| Agent | Purpose | Temperature | Output |
|-------|---------|-------------|--------|
| **Prometheus** | Strategic planning with interview mode | 0.1 (precise) | Structured work plans |
| **Metis** | Pre-planning gap analysis | 0.3 (creative) | Ambiguity detection, AI-slop prevention |
| **Momus** | Post-planning validator | 0.1 (analytical) | Pass/fail with thresholds |

### 2. Intent-Gate Pattern (Phase 0)

Every request flows through classification before execution:

```
User Request → Intent Gate → [Route to appropriate handler]
```

**Intent Types:**
- **Trivial** - Single file/line, direct tools only
- **Explicit** - Clear command, execute directly  
- **Exploratory** - Research question, fire parallel scouts
- **Open-ended** - Refactor/improve, assess first
- **Ambiguous** - Interview mode for clarification

### 3. Interview Mode

When requirements are unclear, conduct structured questioning:

- Parse explicit requirements
- Identify implicit needs
- Detect ambiguities
- Formulate targeted questions

**Question Categories:** Architecture, Integrations, UI/UX, Performance, Security, Edge Cases

### 4. Gap Analysis (Metis Pattern)

Detect what's NOT on the page:
- Hidden intentions
- Missing acceptance criteria
- Edge cases
- AI-slop patterns (scope inflation, premature abstraction)

### 5. Validation Thresholds (Momus Pattern)

Strict approval criteria:
- 100% file references verified
- ≥80% tasks have clear sources
- ≥90% have concrete acceptance criteria
- Zero critical red flags

## Proposed Overmind Architecture

### Phase 0: Intent Gate

Add to kernel before mode execution:

```typescript
interface IntentClassification {
  type: "trivial" | "explicit" | "exploratory" | "open" | "ambiguous";
  confidence: number;
  suggestedMode?: Mode;
  requiresInterview: boolean;
  interviewQuestions?: string[];
}

class IntentGate {
  classify(objective: string): Promise<IntentClassification>;
}
```

### Phase 1: Planner Interface

Replace hardcoded templates with dynamic task graphs:

```typescript
interface TaskNode {
  id: string;
  title: string;
  description: string;
  agentRole: string;
  dependencies: string[];
  acceptanceCriteria: string[];
  estimatedEffort?: "small" | "medium" | "large";
}

interface TaskGraph {
  tasks: TaskNode[];
  parallelGroups: string[][];
  entryPoints: string[];
}

interface Planner {
  plan(objective: string, context?: PlanContext): Promise<TaskGraph>;
  validate(graph: TaskGraph): Promise<ValidationResult>;
}
```

### Phase 2: Plan Executor

Atlas-style orchestration:

```typescript
interface PlanExecutor {
  execute(graph: TaskGraph, runCtx: RunContext): Promise<RunContext>;
  // Delegates to appropriate mode based on graph structure
}
```

### Integration with Existing Modes

Rather than replacing scout/relay/swarm, the planner generates task graphs
that map to these execution patterns:

- **Scout-like graphs** - Multiple parallel exploration tasks, no dependencies
- **Relay-like graphs** - Sequential tasks with verification gates
- **Swarm-like graphs** - Parallel tasks with global verification

```typescript
// Planner produces graph, executor routes to appropriate mode
if (isScoutPattern(graph)) {
  return executeScoutGraph(ctx, graph, brain, neuralLink, persistence);
} else if (isRelayPattern(graph)) {
  return executeRelayGraph(ctx, graph, brain, neuralLink, persistence);
} else if (isSwarmPattern(graph)) {
  return executeSwarmGraph(ctx, graph, brain, neuralLink, persistence);
}
```

## Implementation Roadmap

### Step 1: Intent Gate (MVP)
- Simple keyword-based classification
- Interview mode for ambiguous objectives
- Integration with existing mode selection

### Step 2: Hardcoded Planners
- Template-based planners for common patterns
- Still deterministic, but formalizes planning phase

### Step 3: Dynamic Planning
- LLM-based plan generation
- Metis-style gap analysis
- Momus-style validation

### Step 4: Full Orchestration
- Atlas-style plan executor
- Wisdom accumulation across runs
- Session continuity

## Key Design Decisions

1. **Read-only planning** - Planners can only write to plan files, not modify code
2. **Separation of concerns** - Planning (what to do) vs execution (how to do it)
3. **Quality gates** - Plans must pass validation before execution
4. **Interview for ambiguity** - Don't guess, ask clarifying questions
5. **Mode emergence** - Mode is output of planning, not input

## References

- OMO/OMA Planning System: https://deepwiki.com/code-yeongyu/oh-my-opencode/4.4-planning-system
- Prometheus Agent: https://www.mintlify.com/code-yeongyu/oh-my-opencode/api/agents/prometheus
- Metis Agent: https://www.mintlify.com/code-yeongyu/oh-my-opencode/api/agents/metis
- Atlas Executor: https://deepwiki.com/code-yeongyu/oh-my-opencode/4.3-atlas:-plan-executor

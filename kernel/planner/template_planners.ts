import type {
  PlanContext,
  Planner,
  TaskGraph,
  TaskNode,
  ValidationIssue,
  ValidationResult,
} from "./planner.ts";

export class ExplorationPlanner implements Planner {
  async plan(context: PlanContext): Promise<TaskGraph> {
    const objective = context.objective;
    const tasks: TaskNode[] = [
      {
        id: "explore-1",
        title: "Map codebase structure",
        description: `Explore project structure relevant to: ${objective}`,
        agentRole: "archivist",
        dependencies: [],
        acceptanceCriteria: [
          "Directory structure documented",
          "Key files identified",
        ],
      },
      {
        id: "explore-2",
        title: "Find related patterns",
        description: `Search for existing patterns related to: ${objective}`,
        agentRole: "probe",
        dependencies: [],
        acceptanceCriteria: [
          "Similar implementations found",
          "Patterns documented",
        ],
      },
      {
        id: "explore-3",
        title: "Analyze dependencies",
        description: `Map dependencies and relationships for: ${objective}`,
        agentRole: "cortex",
        dependencies: [],
        acceptanceCriteria: [
          "Dependency graph created",
          "Integration points identified",
        ],
      },
    ];

    return {
      tasks,
      parallelGroups: [["explore-1", "explore-2", "explore-3"]],
      entryPoints: ["explore-1", "explore-2", "explore-3"],
    };
  }

  async validate(graph: TaskGraph): Promise<ValidationResult> {
    const issues: ValidationIssue[] = [];

    if (graph.tasks.length === 0) {
      issues.push({ severity: "error", message: "Task graph is empty" });
    }

    const hasExplorationTasks = graph.tasks.some((task) =>
      /\b(explore|investigate|research|map|find)\b/i.test(task.title)
    );

    if (!hasExplorationTasks) {
      issues.push({
        severity: "warning",
        message: "No clear exploration tasks found",
      });
    }

    return {
      valid: issues.filter((i) => i.severity === "error").length === 0,
      issues,
    };
  }
}

export class ImplementationPlanner implements Planner {
  async plan(context: PlanContext): Promise<TaskGraph> {
    const objective = context.objective;
    const tasks: TaskNode[] = [
      {
        id: "plan-1",
        title: "Design approach",
        description: `Create implementation plan for: ${objective}`,
        agentRole: "cortex",
        dependencies: [],
        acceptanceCriteria: ["Design documented", "Approach reviewed"],
        estimatedEffort: "small",
      },
      {
        id: "impl-1",
        title: "Implement core changes",
        description: `Write code for: ${objective}`,
        agentRole: "drone",
        dependencies: ["plan-1"],
        acceptanceCriteria: ["Code compiles", "Basic functionality works"],
        estimatedEffort: "medium",
      },
      {
        id: "verify-1",
        title: "Verify implementation",
        description: `Validate implementation of: ${objective}`,
        agentRole: "verifier",
        dependencies: ["impl-1"],
        acceptanceCriteria: ["Tests pass", "Acceptance criteria met"],
        estimatedEffort: "small",
      },
    ];

    return {
      tasks,
      parallelGroups: [],
      entryPoints: ["plan-1"],
    };
  }

  async validate(graph: TaskGraph): Promise<ValidationResult> {
    const issues: ValidationIssue[] = [];

    const hasDesignTask = graph.tasks.some((task) =>
      /\b(design|plan|approach)\b/i.test(task.title)
    );

    if (!hasDesignTask) {
      issues.push({
        severity: "warning",
        message: "No design/planning task found",
      });
    }

    const hasVerifyTask = graph.tasks.some((task) =>
      /\b(verify|validate|test|check)\b/i.test(task.title)
    );

    if (!hasVerifyTask) {
      issues.push({
        severity: "warning",
        message: "No verification task found",
      });
    }

    return { valid: true, issues };
  }
}

export class RefactoringPlanner implements Planner {
  async plan(context: PlanContext): Promise<TaskGraph> {
    const objective = context.objective;
    const tasks: TaskNode[] = [
      {
        id: "analyze-1",
        title: "Analyze current code",
        description:
          `Understand current implementation before refactoring: ${objective}`,
        agentRole: "archivist",
        dependencies: [],
        acceptanceCriteria: [
          "Current behavior documented",
          "Risk areas identified",
        ],
      },
      {
        id: "refactor-1",
        title: "Apply refactoring",
        description: `Execute refactoring: ${objective}`,
        agentRole: "drone",
        dependencies: ["analyze-1"],
        acceptanceCriteria: ["Refactoring applied", "Code compiles"],
      },
      {
        id: "verify-1",
        title: "Verify no regressions",
        description: `Ensure refactoring didn't break existing behavior`,
        agentRole: "verifier",
        dependencies: ["refactor-1"],
        acceptanceCriteria: ["Tests pass", "Behavior preserved"],
      },
    ];

    return {
      tasks,
      parallelGroups: [],
      entryPoints: ["analyze-1"],
    };
  }

  async validate(graph: TaskGraph): Promise<ValidationResult> {
    const issues: ValidationIssue[] = [];

    const hasAnalysisTask = graph.tasks.some((task) =>
      /\b(analyze|understand|document)\b/i.test(task.title)
    );

    if (!hasAnalysisTask) {
      issues.push({
        severity: "error",
        message: "Refactoring requires analysis task",
      });
    }

    const hasRegressionCheck = graph.tasks.some((task) =>
      /\b(regression|preserve|verify.*behavior)\b/i.test(task.description)
    );

    if (!hasRegressionCheck) {
      issues.push({
        severity: "warning",
        message: "No regression check identified",
      });
    }

    return {
      valid: issues.filter((i) => i.severity === "error").length === 0,
      issues,
    };
  }
}

export function selectPlanner(objective: string): Planner {
  const lower = objective.toLowerCase();

  if (
    /\b(explore|investigate|research|find|how\s+does|what\s+is)\b/.test(lower)
  ) {
    return new ExplorationPlanner();
  }

  if (/\b(refactor|clean\s+up|restructure)\b/.test(lower)) {
    return new RefactoringPlanner();
  }

  return new ImplementationPlanner();
}

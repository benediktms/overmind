import type { TaskGraph, ValidationResult, ValidationIssue } from "./planner.ts";

export interface StrictValidationResult extends ValidationResult {
  thresholds: {
    fileReferenceCoverage: number;
    acceptanceCriteriaCoverage: number;
    hasBusinessLogicAssumptions: boolean;
    hasCriticalRedFlags: boolean;
  };
}

export class StrictValidator {
  private readonly FILE_REF_THRESHOLD = 1.0;
  private readonly CRITERIA_THRESHOLD = 0.9;

  validate(graph: TaskGraph): StrictValidationResult {
    const issues: ValidationIssue[] = [];
    let fileRefCount = 0;
    let criteriaCount = 0;
    let hasBusinessLogicAssumptions = false;
    let hasCriticalRedFlags = false;

    for (const task of graph.tasks) {
      const taskIssues = this.validateTask(task);
      issues.push(...taskIssues);

      if (taskIssues.some((i) => i.severity === "error")) {
        hasCriticalRedFlags = true;
      }

      if (this.hasFileReference(task)) {
        fileRefCount++;
      }

      if (task.acceptanceCriteria.length > 0) {
        criteriaCount++;
      }

      if (this.hasBusinessLogicAssumption(task)) {
        hasBusinessLogicAssumptions = true;
      }
    }

    const fileReferenceCoverage = graph.tasks.length > 0 ? fileRefCount / graph.tasks.length : 0;
    const acceptanceCriteriaCoverage = graph.tasks.length > 0 ? criteriaCount / graph.tasks.length : 0;

    if (fileReferenceCoverage < this.FILE_REF_THRESHOLD) {
      issues.push({
        severity: "error",
        message: `File reference coverage ${(fileReferenceCoverage * 100).toFixed(0)}% below 100% threshold`,
      });
      hasCriticalRedFlags = true;
    }

    if (acceptanceCriteriaCoverage < this.CRITERIA_THRESHOLD) {
      issues.push({
        severity: "error",
        message: `Acceptance criteria coverage ${(acceptanceCriteriaCoverage * 100).toFixed(0)}% below ${(this.CRITERIA_THRESHOLD * 100).toFixed(0)}% threshold`,
      });
      hasCriticalRedFlags = true;
    }

    if (hasBusinessLogicAssumptions) {
      issues.push({
        severity: "error",
        message: "Plan contains undocumented business logic assumptions",
      });
      hasCriticalRedFlags = true;
    }

    return {
      valid: !hasCriticalRedFlags,
      issues,
      fileReferenceCoverage,
      acceptanceCriteriaCoverage,
      thresholds: {
        fileReferenceCoverage: this.FILE_REF_THRESHOLD,
        acceptanceCriteriaCoverage: this.CRITERIA_THRESHOLD,
        hasBusinessLogicAssumptions,
        hasCriticalRedFlags,
      },
    };
  }

  private validateTask(task: { id: string; title: string; description: string; acceptanceCriteria: string[] }): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    if (task.title.length < 5) {
      issues.push({
        severity: "error",
        taskId: task.id,
        message: `Task title "${task.title}" is too short (minimum 5 characters)`,
      });
    }

    if (task.description.length < 20) {
      issues.push({
        severity: "warning",
        taskId: task.id,
        message: `Task "${task.title}" has insufficient description`,
      });
    }

    if (task.acceptanceCriteria.length === 0) {
      issues.push({
        severity: "error",
        taskId: task.id,
        message: `Task "${task.title}" has no acceptance criteria`,
      });
    } else {
      for (const criteria of task.acceptanceCriteria) {
        if (criteria.split(/\s+/).length < 3) {
          issues.push({
            severity: "warning",
            taskId: task.id,
            message: `Task "${task.title}" has vague acceptance criteria: "${criteria}"`,
          });
        }
      }
    }

    if (!/[.!?]$/.test(task.description)) {
      issues.push({
        severity: "info",
        taskId: task.id,
        message: `Task "${task.title}" description should end with punctuation`,
      });
    }

    return issues;
  }

  private hasFileReference(task: { description: string; acceptanceCriteria: string[] }): boolean {
    const text = task.description + " " + task.acceptanceCriteria.join(" ");
    return /\b(src\/|lib\/|test\/|\.ts$|\.js$|\.py$|file:\s*\w)/i.test(text);
  }

  private hasBusinessLogicAssumption(task: { description: string; acceptanceCriteria: string[] }): boolean {
    const text = (task.description + " " + task.acceptanceCriteria.join(" ")).toLowerCase();

    const assumptionPatterns = [
      /\b(we\s+assume|it\s+is\s+assumed|presumably|likely|probably)\b/,
      /\b(should\s+work|ought\s+to|expected\s+to)\b.*\b(without\s+specifying)\b/,
      /\b(as\s+usual|like\s+before|standard\s+way)\b/,
    ];

    return assumptionPatterns.some((pattern) => pattern.test(text));
  }
}

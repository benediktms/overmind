import type { TaskGraph, ValidationIssue } from "./planner.ts";

export interface GapAnalysisResult {
  gaps: Gap[];
  aiSlopPatterns: AiSlopPattern[];
  recommendations: string[];
}

export interface Gap {
  category: "hidden_intention" | "missing_criteria" | "edge_case" | "ambiguity";
  description: string;
  severity: "high" | "medium" | "low";
  suggestedQuestion?: string;
}

export interface AiSlopPattern {
  pattern: string;
  description: string;
  mitigation: string;
}

export class GapAnalyzer {
  analyze(graph: TaskGraph, objective: string): GapAnalysisResult {
    const gaps: Gap[] = [];
    const aiSlopPatterns: AiSlopPattern[] = [];

    this.checkHiddenIntentions(graph, objective, gaps);
    this.checkMissingAcceptanceCriteria(graph, gaps);
    this.checkEdgeCases(graph, objective, gaps);
    this.checkAmbiguities(graph, gaps);
    this.checkAiSlopPatterns(graph, objective, aiSlopPatterns);

    return {
      gaps,
      aiSlopPatterns,
      recommendations: this.generateRecommendations(gaps, aiSlopPatterns),
    };
  }

  private checkHiddenIntentions(graph: TaskGraph, objective: string, gaps: Gap[]): void {
    const objectiveLower = objective.toLowerCase();

    if (/\b(improve|better|optimize)\b/.test(objectiveLower)) {
      const hasMetrics = graph.tasks.some((t) =>
        /\b(metric|benchmark|measure|performance|target)\b/i.test(t.acceptanceCriteria.join(" "))
      );

      if (!hasMetrics) {
        gaps.push({
          category: "hidden_intention",
          description: "Objective mentions improvement but no success metrics defined",
          severity: "high",
          suggestedQuestion: "What specific metrics or criteria will indicate success?",
        });
      }
    }

    if (/\b(refactor|clean\s+up|restructure)\b/.test(objectiveLower)) {
      const hasPreservationCriteria = graph.tasks.some((t) =>
        /\b(preserve|maintain|no\s+regression|backward\s+compatible)\b/i.test(t.acceptanceCriteria.join(" "))
      );

      if (!hasPreservationCriteria) {
        gaps.push({
          category: "hidden_intention",
          description: "Refactoring objective without behavior preservation criteria",
          severity: "high",
          suggestedQuestion: "What existing behavior must be preserved?",
        });
      }
    }
  }

  private checkMissingAcceptanceCriteria(graph: TaskGraph, gaps: Gap[]): void {
    const tasksWithoutCriteria = graph.tasks.filter((t) => t.acceptanceCriteria.length === 0);

    for (const task of tasksWithoutCriteria) {
      gaps.push({
        category: "missing_criteria",
        description: `Task "${task.title}" has no acceptance criteria`,
        severity: "medium",
        suggestedQuestion: `How will we know when "${task.title}" is complete?`,
      });
    }

    const tasksWithVagueCriteria = graph.tasks.filter((t) =>
      t.acceptanceCriteria.some((c) =>
        /\b(done|complete|working|good)\b/i.test(c) && c.split(/\s+/).length < 5
      )
    );

    for (const task of tasksWithVagueCriteria) {
      gaps.push({
        category: "missing_criteria",
        description: `Task "${task.title}" has vague acceptance criteria`,
        severity: "medium",
        suggestedQuestion: `What specific, measurable criteria define "${task.title}" completion?`,
      });
    }
  }

  private checkEdgeCases(graph: TaskGraph, objective: string, gaps: Gap[]): void {
    const objectiveLower = objective.toLowerCase();

    if (/\b(handle|process|validate|input|user)\b/.test(objectiveLower)) {
      const hasErrorHandling = graph.tasks.some((t) =>
        /\b(error|exception|failure|invalid|edge\s+case)\b/i.test(t.title + " " + t.description)
      );

      if (!hasErrorHandling) {
        gaps.push({
          category: "edge_case",
          description: "Objective involves handling/processing but no error handling tasks identified",
          severity: "medium",
          suggestedQuestion: "What are the expected error cases and how should they be handled?",
        });
      }
    }

    if (/\b(api|endpoint|interface)\b/.test(objectiveLower)) {
      const hasBoundaryTesting = graph.tasks.some((t) =>
        /\b(boundary|limit|timeout|race\s+condition)\b/i.test(t.title + " " + t.description)
      );

      if (!hasBoundaryTesting) {
        gaps.push({
          category: "edge_case",
          description: "API work without boundary/limit considerations",
          severity: "low",
          suggestedQuestion: "What are the rate limits, timeouts, and resource constraints?",
        });
      }
    }
  }

  private checkAmbiguities(graph: TaskGraph, gaps: Gap[]): void {
    for (const task of graph.tasks) {
      if (/\b(and|or)\b/.test(task.description) && task.description.length > 100) {
        const conjunctions = (task.description.match(/\b(and|or)\b/g) || []).length;
        if (conjunctions > 3) {
          gaps.push({
            category: "ambiguity",
            description: `Task "${task.title}" has multiple conjunctions suggesting multiple responsibilities`,
            severity: "low",
            suggestedQuestion: `Should "${task.title}" be split into smaller, focused tasks?`,
          });
        }
      }
    }
  }

  private checkAiSlopPatterns(graph: TaskGraph, objective: string, patterns: AiSlopPattern[]): void {
    const taskCount = graph.tasks.length;
    const objectiveLower = objective.toLowerCase();

    if (/\b(add\s+tests?|test\s+coverage)\b/i.test(objectiveLower) && taskCount > 5) {
      patterns.push({
        pattern: "scope_inflation",
        description: "Adding comprehensive tests to unrelated modules",
        mitigation: "Limit test additions to directly modified code",
      });
    }

    const hasPrematureAbstraction = graph.tasks.some((t) =>
      /\b(abstract|generic|reusable|utility|helper)\b/i.test(t.title) &&
      !/\b(refactor|extract)\b/i.test(objectiveLower)
    );

    if (hasPrematureAbstraction) {
      patterns.push({
        pattern: "premature_abstraction",
        description: "Creating abstractions without clear need",
        mitigation: "Implement concrete solution first, abstract only when pattern emerges",
      });
    }

    const documentationTasks = graph.tasks.filter((t) =>
      /\b(document|doc|comment|readme)\b/i.test(t.title)
    ).length;

    if (documentationTasks > 2 && taskCount < 5) {
      patterns.push({
        pattern: "documentation_bloat",
        description: "Excessive documentation relative to implementation",
        mitigation: "Focus documentation on public APIs and complex logic only",
      });
    }
  }

  private generateRecommendations(gaps: Gap[], aiSlopPatterns: AiSlopPattern[]): string[] {
    const recommendations: string[] = [];

    if (gaps.filter((g) => g.severity === "high").length > 0) {
      recommendations.push("Address high-severity gaps before proceeding with implementation");
    }

    if (aiSlopPatterns.length > 0) {
      recommendations.push("Review for AI-slop patterns - simplify where possible");
    }

    const questions = gaps
      .filter((g) => g.suggestedQuestion)
      .map((g) => g.suggestedQuestion!);

    if (questions.length > 0) {
      recommendations.push(`Ask clarifying questions: ${questions.slice(0, 3).join("; ")}`);
    }

    return recommendations;
  }
}

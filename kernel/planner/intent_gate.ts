import { Mode } from "../types.ts";

export type IntentType =
  | "trivial"
  | "explicit"
  | "exploratory"
  | "open"
  | "ambiguous";

export type InterviewCallback = (question: string) => Promise<string>;

export interface IntentClassification {
  type: IntentType;
  confidence: number;
  suggestedMode?: Mode;
  requiresInterview: boolean;
  interviewQuestions?: string[];
  reasoning: string;
}

export interface InterviewResponse {
  question: string;
  answer: string;
}

export interface IntentGate {
  classify(objective: string): Promise<IntentClassification>;
  conductInterview(
    objective: string,
    initialClassification: IntentClassification,
  ): Promise<InterviewResponse[]>;
}

export class KeywordIntentGate implements IntentGate {
  private interviewCallback: InterviewCallback | null;

  constructor(interviewCallback?: InterviewCallback) {
    this.interviewCallback = interviewCallback ?? null;
  }

  private trivialPatterns = [
    /^\s*fix\s+(typo|import|syntax)\s+/i,
    /^\s*update\s+\w+\s+to\s+/i,
    /^\s*rename\s+\w+\s+to\s+/i,
  ];

  private exploratoryPatterns = [
    /\b(how\s+does|what\s+is|find|search|explore|investigate)\b/i,
    /\b(explain|understand|document)\b/i,
  ];

  private ambiguousPatterns = [
    /\b(improve|refactor|optimize|clean\s+up|enhance)\b/i,
    /\b(add\s+feature|implement|build|create)\b[^.]*$/i,
  ];

  async classify(objective: string): Promise<IntentClassification> {
    const lowerObjective = objective.toLowerCase();

    // Check trivial patterns
    for (const pattern of this.trivialPatterns) {
      if (pattern.test(objective)) {
        return {
          type: "trivial",
          confidence: 0.8,
          requiresInterview: false,
          reasoning: "Matches trivial operation pattern",
        };
      }
    }

    // Check exploratory patterns
    for (const pattern of this.exploratoryPatterns) {
      if (pattern.test(objective)) {
        return {
          type: "exploratory",
          confidence: 0.7,
          suggestedMode: Mode.Scout,
          requiresInterview: false,
          reasoning: "Objective is research/investigation focused",
        };
      }
    }

    // Check ambiguous patterns
    for (const pattern of this.ambiguousPatterns) {
      if (pattern.test(objective)) {
        return {
          type: "ambiguous",
          confidence: 0.6,
          requiresInterview: true,
          reasoning: "Objective is open-ended, needs clarification",
          interviewQuestions: this.generateQuestions(objective),
        };
      }
    }

    // Default to explicit if contains specific file/line references
    if (/\b(\/\w+|\.\w+|line\s+\d+|function\s+\w+)\b/i.test(objective)) {
      return {
        type: "explicit",
        confidence: 0.75,
        requiresInterview: false,
        reasoning: "Contains specific file/line references",
      };
    }

    // Default to open
    return {
      type: "open",
      confidence: 0.5,
      requiresInterview: true,
      reasoning: "Objective needs clarification for best approach",
      interviewQuestions: this.generateQuestions(objective),
    };
  }

  async conductInterview(
    _objective: string,
    initialClassification: IntentClassification,
  ): Promise<InterviewResponse[]> {
    const questions = initialClassification.interviewQuestions ?? [];
    if (questions.length === 0) return [];

    if (!this.interviewCallback) {
      // No callback registered — return unanswered questions
      // (preserves current behavior for non-interactive contexts)
      return questions.map((q) => ({ question: q, answer: "" }));
    }

    const responses: InterviewResponse[] = [];
    for (const question of questions) {
      const answer = await this.interviewCallback(question);
      responses.push({ question, answer });
    }
    return responses;
  }

  private generateQuestions(objective: string): string[] {
    const questions: string[] = [];

    if (/\b(refactor|improve)\b/i.test(objective)) {
      questions.push(
        "What specific improvements are you looking for? (performance, readability, maintainability)",
        "Are there any parts of the code that must NOT change?",
        "What would success look like for this refactor?",
      );
    }

    if (/\b(add|implement|create|build)\b/i.test(objective)) {
      questions.push(
        "What is the core functionality you need?",
        "Are there any existing patterns in the codebase I should follow?",
        "What are the acceptance criteria?",
        "Any specific edge cases to consider?",
      );
    }

    if (questions.length === 0) {
      questions.push(
        "Can you provide more specific details about what you want to achieve?",
        "What would indicate success for this task?",
        "Are there any constraints or requirements I should know about?",
      );
    }

    return questions;
  }
}

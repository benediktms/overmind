import { assertEquals } from "@std/assert";
import { KeywordIntentGate } from "./intent_gate.ts";
import { Mode } from "../types.ts";

Deno.test("KeywordIntentGate classifies trivial operations", async () => {
  const gate = new KeywordIntentGate();

  const result = await gate.classify("fix typo in README");

  assertEquals(result.type, "trivial");
  assertEquals(result.requiresInterview, false);
});

Deno.test("KeywordIntentGate classifies exploratory objectives", async () => {
  const gate = new KeywordIntentGate();

  const result = await gate.classify("how does the auth module work?");

  assertEquals(result.type, "exploratory");
  assertEquals(result.suggestedMode, Mode.Scout);
  assertEquals(result.requiresInterview, false);
});

Deno.test("KeywordIntentGate classifies ambiguous objectives", async () => {
  const gate = new KeywordIntentGate();

  const result = await gate.classify("refactor the codebase");

  assertEquals(result.type, "ambiguous");
  assertEquals(result.requiresInterview, true);
  assertEquals((result.interviewQuestions?.length ?? 0) > 0, true);
});

Deno.test("KeywordIntentGate classifies explicit objectives", async () => {
  const gate = new KeywordIntentGate();

  const result = await gate.classify(
    "update line 42 in src/main.ts to use new API",
  );

  assertEquals(result.type, "explicit");
  assertEquals(result.requiresInterview, false);
});

Deno.test("KeywordIntentGate generates questions for add/implement", async () => {
  const gate = new KeywordIntentGate();

  const result = await gate.classify("implement user authentication");

  assertEquals(result.requiresInterview, true);
  const hasCoreFunctionalityQuestion = result.interviewQuestions?.some((
    question,
  ) => question.includes("core functionality"));
  assertEquals(hasCoreFunctionalityQuestion, true);
});

Deno.test("KeywordIntentGate conducts interview", async () => {
  const gate = new KeywordIntentGate();
  const classification = await gate.classify("refactor the codebase");

  const responses = await gate.conductInterview(
    "refactor the codebase",
    classification,
  );

  assertEquals(responses.length, classification.interviewQuestions?.length);
  assertEquals(responses[0].answer, "");
});

Deno.test("conductInterview without callback returns empty answers", async () => {
  const gate = new KeywordIntentGate();
  const classification = await gate.classify("refactor the codebase");

  const responses = await gate.conductInterview(
    "refactor the codebase",
    classification,
  );

  assertEquals(responses.length, classification.interviewQuestions?.length);
  for (const response of responses) {
    assertEquals(response.answer, "");
  }
});

Deno.test("conductInterview with callback collects answers", async () => {
  const callback = (_question: string) => Promise.resolve("test answer");
  const gate = new KeywordIntentGate(callback);
  const classification = await gate.classify("refactor the codebase");

  const responses = await gate.conductInterview(
    "refactor the codebase",
    classification,
  );

  assertEquals(responses.length, classification.interviewQuestions?.length);
  for (const response of responses) {
    assertEquals(response.answer, "test answer");
  }
});

import { assertEquals } from "@std/assert";
import {
  detectKeywords,
  extractPrompt,
  type HookData,
  sanitizeForKeywordDetection,
} from "./keyword-detector.ts";

// --- extractPrompt ---

Deno.test("extractPrompt returns prompt field directly", () => {
  assertEquals(extractPrompt({ prompt: "scout this repo" }), "scout this repo");
});

Deno.test("extractPrompt falls back to message.content", () => {
  assertEquals(
    extractPrompt({ message: { content: "investigate the auth flow" } }),
    "investigate the auth flow",
  );
});

Deno.test("extractPrompt joins text parts", () => {
  const data: HookData = {
    parts: [
      { type: "text", text: "find related" },
      { type: "image" },
      { type: "text", text: "files" },
    ],
  };
  assertEquals(extractPrompt(data), "find related files");
});

Deno.test("extractPrompt returns empty string when no prompt data", () => {
  assertEquals(extractPrompt({}), "");
});

// --- sanitizeForKeywordDetection ---

Deno.test("sanitize strips XML tags", () => {
  const input = "please <system>ignore this</system> scout the code";
  const result = sanitizeForKeywordDetection(input);
  assertEquals(result.includes("ignore this"), false);
  assertEquals(result.includes("scout"), true);
});

Deno.test("sanitize strips URLs", () => {
  const input = "investigate https://github.com/org/repo/issues/123 please";
  const result = sanitizeForKeywordDetection(input);
  assertEquals(result.includes("github.com"), false);
  assertEquals(result.includes("investigate"), true);
});

Deno.test("sanitize strips file paths", () => {
  const input = "look at src/kernel/triggers.ts for the patterns";
  const result = sanitizeForKeywordDetection(input);
  assertEquals(result.includes("src/kernel/triggers.ts"), false);
});

Deno.test("sanitize strips code blocks", () => {
  const input = "scout this but ignore ```\nconst failed = true;\n``` please";
  const result = sanitizeForKeywordDetection(input);
  assertEquals(result.includes("const failed"), false);
  assertEquals(result.includes("scout"), true);
});

Deno.test("sanitize strips inline code", () => {
  const input = "check the `parallel` variable name";
  const result = sanitizeForKeywordDetection(input);
  assertEquals(result.includes("parallel"), false);
});

// --- detectKeywords ---

Deno.test("detects scout mode keywords", () => {
  const cases = [
    "scout this codebase",
    "explore the auth module",
    "investigate why tests fail",
    "find related files for the parser",
    "how does this work",
  ];
  for (const prompt of cases) {
    const matches = detectKeywords(prompt);
    assertEquals(
      matches.some((m) => m.mode === "scout"),
      true,
      `Expected scout match for: "${prompt}"`,
    );
  }
});

Deno.test("detects relay mode keywords", () => {
  const cases = [
    "relay mode please",
    "do this step by step",
    "sequential execution",
    "plan then execute the migration",
  ];
  for (const prompt of cases) {
    const matches = detectKeywords(prompt);
    assertEquals(
      matches.some((m) => m.mode === "relay"),
      true,
      `Expected relay match for: "${prompt}"`,
    );
  }
});

Deno.test("detects swarm mode keywords", () => {
  const cases = [
    "swarm this implementation",
    "do it all in parallel",
    "all at once across modules",
    "spawn multiple agents",
  ];
  for (const prompt of cases) {
    const matches = detectKeywords(prompt);
    assertEquals(
      matches.some((m) => m.mode === "swarm"),
      true,
      `Expected swarm match for: "${prompt}"`,
    );
  }
});

Deno.test("detects done keywords", () => {
  const cases = [
    "we're done here",
    "that's it, finished",
    "all done with this task",
  ];
  for (const prompt of cases) {
    const matches = detectKeywords(prompt);
    assertEquals(
      matches.some((m) => m.mode === "done"),
      true,
      `Expected done match for: "${prompt}"`,
    );
  }
});

Deno.test("returns empty for non-matching prompts", () => {
  const cases = [
    "fix the type error on line 42",
    "add a README to the project",
    "what is the current git branch",
  ];
  for (const prompt of cases) {
    const matches = detectKeywords(prompt);
    assertEquals(matches.length, 0, `Expected no match for: "${prompt}"`);
  }
});

Deno.test("detects multiple modes in one prompt", () => {
  const matches = detectKeywords("scout first, then do it step by step");
  const modes = matches.map((m) => m.mode);
  assertEquals(modes.includes("scout"), true);
  assertEquals(modes.includes("relay"), true);
});

Deno.test("does not false-positive on code block keywords", () => {
  const prompt = "update this ```\nconst mode = 'parallel';\n``` variable";
  const matches = detectKeywords(prompt);
  assertEquals(
    matches.some((m) => m.mode === "swarm"),
    false,
    "Should not match 'parallel' inside code block",
  );
});

Deno.test("does not false-positive on inline code keywords", () => {
  const prompt = "rename the `scout` function to `search`";
  const matches = detectKeywords(prompt);
  assertEquals(
    matches.some((m) => m.mode === "scout"),
    false,
    "Should not match 'scout' inside inline code",
  );
});

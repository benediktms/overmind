import { assertEquals } from "@std/assert";
import { selectTier, strategiesForTier } from "./tier_selector.ts";
import type {
  TierSelectionInput,
  TierStrategyConfig,
} from "./tier_selector.ts";

const baseInput: TierSelectionInput = {
  filesChanged: 10,
  linesChanged: 200,
  fileTypes: [".ts"],
  securitySensitivePaths: false,
  architecturalChanges: false,
};

const baseConfig: TierStrategyConfig = {
  lspFiles: ["src/main.ts"],
  buildCommand: "deno check",
  testCommand: "deno test",
};

// --- selectTier ---

Deno.test("selectTier returns thorough for security-sensitive paths", () => {
  assertEquals(
    selectTier({ ...baseInput, securitySensitivePaths: true }),
    "thorough",
  );
});

Deno.test("selectTier returns thorough for architectural changes", () => {
  assertEquals(
    selectTier({ ...baseInput, architecturalChanges: true }),
    "thorough",
  );
});

Deno.test("selectTier returns thorough for >20 files changed", () => {
  assertEquals(selectTier({ ...baseInput, filesChanged: 21 }), "thorough");
});

Deno.test("selectTier returns light for <5 files and <100 lines", () => {
  assertEquals(
    selectTier({ ...baseInput, filesChanged: 3, linesChanged: 50 }),
    "light",
  );
});

Deno.test("selectTier returns standard for default case", () => {
  assertEquals(selectTier(baseInput), "standard");
});

Deno.test("selectTier boundary: exactly 5 files is standard not light", () => {
  assertEquals(
    selectTier({ ...baseInput, filesChanged: 5, linesChanged: 50 }),
    "standard",
  );
});

Deno.test("selectTier boundary: exactly 100 lines with <5 files is standard not light", () => {
  assertEquals(
    selectTier({ ...baseInput, filesChanged: 3, linesChanged: 100 }),
    "standard",
  );
});

Deno.test("selectTier: security flag overrides small change to thorough", () => {
  assertEquals(
    selectTier({
      ...baseInput,
      filesChanged: 1,
      linesChanged: 5,
      securitySensitivePaths: true,
    }),
    "thorough",
  );
});

// --- strategiesForTier ---

Deno.test("strategiesForTier returns LSP only for light", () => {
  const strategies = strategiesForTier("light", baseConfig);
  assertEquals(strategies.length, 1);
  assertEquals(strategies[0].type, "lsp");
});

Deno.test("strategiesForTier returns LSP+Build+Test for standard", () => {
  const strategies = strategiesForTier("standard", baseConfig);
  assertEquals(strategies.length, 3);
  assertEquals(strategies.map((s) => s.type), ["lsp", "build", "test"]);
});

Deno.test("strategiesForTier returns LSP+Build+Test+Agent for thorough", () => {
  const strategies = strategiesForTier("thorough", baseConfig);
  assertEquals(strategies.length, 4);
  assertEquals(strategies.map((s) => s.type), [
    "lsp",
    "build",
    "test",
    "agent",
  ]);
});

Deno.test("strategiesForTier uses provided agentRole and agentPrompt", () => {
  const strategies = strategiesForTier("thorough", {
    ...baseConfig,
    agentRole: "sentinel",
    agentPrompt: "Check for OWASP Top 10",
  });
  const agent = strategies.find((s) => s.type === "agent");
  assertEquals(agent?.type, "agent");
  if (agent?.type === "agent") {
    assertEquals(agent.agentRole, "sentinel");
    assertEquals(agent.prompt, "Check for OWASP Top 10");
  }
});

Deno.test("strategiesForTier defaults agentRole to verifier", () => {
  const strategies = strategiesForTier("thorough", baseConfig);
  const agent = strategies.find((s) => s.type === "agent");
  if (agent?.type === "agent") {
    assertEquals(agent.agentRole, "verifier");
  }
});

import type { VerificationStrategy, VerificationTier } from "./types.ts";

export interface TierSelectionInput {
  filesChanged: number;
  linesChanged: number;
  fileTypes: string[];
  securitySensitivePaths: boolean;
  architecturalChanges: boolean;
}

export interface TierStrategyConfig {
  lspFiles: string[];
  buildCommand: string;
  testCommand: string;
  buildCwd?: string;
  testCwd?: string;
  // TODO: Revisit stricter typing for agentRole once role registry is formalized
  agentRole?: string;
  agentPrompt?: string;
}

/**
 * Select a verification tier based on change metadata.
 *
 * THOROUGH: security-sensitive paths, architectural changes, or >20 files
 * LIGHT: <5 files AND <100 lines (and not security/arch)
 * STANDARD: everything else
 */
export function selectTier(input: TierSelectionInput): VerificationTier {
  if (input.securitySensitivePaths || input.architecturalChanges) {
    return "thorough";
  }
  if (input.filesChanged > 20) {
    return "thorough";
  }
  if (input.filesChanged < 5 && input.linesChanged < 100) {
    return "light";
  }
  return "standard";
}

/**
 * Return the verification strategies for a given tier and config.
 *
 * LIGHT: LSP only
 * STANDARD: LSP + Build + Test
 * THOROUGH: LSP + Build + Test + Agent
 */
export function strategiesForTier(
  tier: VerificationTier,
  config: TierStrategyConfig,
): VerificationStrategy[] {
  const lsp: VerificationStrategy = { type: "lsp", files: config.lspFiles };
  const build: VerificationStrategy = { type: "build", command: config.buildCommand, cwd: config.buildCwd };
  const test: VerificationStrategy = { type: "test", command: config.testCommand, cwd: config.testCwd };
  const agent: VerificationStrategy = {
    type: "agent",
    agentRole: config.agentRole ?? "verifier",
    prompt: config.agentPrompt ?? "Verify the implementation meets all acceptance criteria.",
  };

  switch (tier) {
    case "light":
      return [lsp];
    case "standard":
      return [lsp, build, test];
    case "thorough":
      return [lsp, build, test, agent];
  }
}

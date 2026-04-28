// Shared knobs for the Overmind edit harness. Single source of truth used
// by both PreToolUse (`pre-tool-enforcer.ts`) and PostToolUse
// (`post-tool-verifier.ts`) hooks so they stay in lockstep.
//
// The `env` parameter is injectable so tests can flip the harness on/off
// without mutating real `Deno.env` (which leaks across concurrent tests).

export const HARNESS_ENV_VAR = "OVERMIND_EDIT_HARNESS";

export function isHarnessEnabled(
  env: { get(key: string): string | undefined } = Deno.env,
): boolean {
  return env.get(HARNESS_ENV_VAR) === "1";
}

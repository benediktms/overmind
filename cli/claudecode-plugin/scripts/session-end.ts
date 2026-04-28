#!/usr/bin/env -S deno run -A --quiet
/**
 * Overmind Session End Hook
 * Cleanup and final brain sync
 */

import { readStdin } from "./lib/stdin.ts";
import { isHarnessEnabled } from "./lib/harness_config.ts";

const OVERMIND_KERNEL_HTTP_URL = Deno.env.get("OVERMIND_KERNEL_HTTP_URL") ??
  "http://localhost:8080";
const RELEASE_TIMEOUT_MS = 300;

interface HookData {
  cwd?: string;
  directory?: string;
  session_id?: string;
  sessionId?: string;
}

async function notifyKernel(
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await fetch(`${OVERMIND_KERNEL_HTTP_URL}/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event,
        data,
        timestamp: new Date().toISOString(),
      }),
    });
  } catch {
    // Kernel may not be running - silent
  }
}

async function releaseSessionLocks(sessionId: string): Promise<void> {
  if (!sessionId) return;
  if (!isHarnessEnabled()) return;
  try {
    await fetch(`${OVERMIND_KERNEL_HTTP_URL}/release-session-locks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
    });
  } catch {
    // Fail-open. The kernel's per-entry size cap and the next session-end
    // (or a manual prune) will eventually reclaim any leaked locks.
  }
}

function outputHookResult(): void {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

async function main(): Promise<void> {
  const input = await readStdin();
  let data: HookData = {};
  try {
    data = JSON.parse(input);
  } catch {
    outputHookResult();
    return;
  }

  const directory = data.cwd ?? data.directory ?? Deno.cwd();
  const sessionId = data.session_id ?? data.sessionId ?? "";

  // Best-effort kernel notifications. Run in parallel — both fail-open.
  await Promise.all([
    notifyKernel("session_end", {
      directory,
      sessionId,
      timestamp: new Date().toISOString(),
    }),
    releaseSessionLocks(sessionId),
  ]);

  outputHookResult();
}

main();

#!/usr/bin/env -S deno run -A --quiet
/**
 * Overmind Session End Hook
 * Cleanup and final brain sync
 */

import { readStdin } from "./lib/stdin.ts";

const OVERMIND_KERNEL_HTTP_URL = Deno.env.get("OVERMIND_KERNEL_HTTP_URL") ?? "http://localhost:8080";

interface HookData {
  cwd?: string;
  directory?: string;
  session_id?: string;
  sessionId?: string;
}

async function notifyKernel(event: string, data: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${OVERMIND_KERNEL_HTTP_URL}/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, data, timestamp: new Date().toISOString() }),
    });
  } catch {
    // Kernel may not be running - silent
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

  // Notify kernel of session end
  await notifyKernel("session_end", {
    directory,
    sessionId,
    timestamp: new Date().toISOString(),
  });

  outputHookResult();
}

main();

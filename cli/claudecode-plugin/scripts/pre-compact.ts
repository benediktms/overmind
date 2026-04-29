#!/usr/bin/env -S deno run -A --quiet
/**
 * Overmind Pre-Compact Hook
 * Pre-compaction context trimming hooks
 */

import { readStdin } from "./lib/stdin.ts";

const OVERMIND_KERNEL_HTTP_URL =
  Deno.env.get("OVERMIND_KERNEL_HTTP_URL") ?? "http://localhost:8080";

interface HookData {
  cwd?: string;
  directory?: string;
  session_id?: string;
  sessionId?: string;
  current_size?: number;
  currentSize?: number;
  max_size?: number;
  maxSize?: number;
}

const BRAIN_MCP_URL = Deno.env.get("OVERMIND_BRAIN_MCP_URL") ?? "http://localhost:8333";

async function notifyKernel(
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
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

async function createBrainSnapshot(
  directory: string,
  sessionId: string,
): Promise<string | null> {
  const title = `Pre-compact snapshot ${new Date().toISOString().slice(0, 19).replace("T", " ")}`;

  try {
    const response = await fetch(`${BRAIN_MCP_URL}/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "brain_records_save_snapshot",
        arguments: {
          brain: "overmind",
          title,
          description: `Pre-compact snapshot for session ${sessionId} in ${directory}`,
          tags: ["overmind", "pre-compact"],
          task_id: undefined,
        },
      }),
    });

    if (!response.ok) return null;
    const result = await response.json();
    if (result.error) return null;
    return result.content?.[0]?.text ?? null;
  } catch {
    return null;
  }
}

function outputHookResult(systemMessage?: string): void {
  const result: Record<string, unknown> = { continue: true };
  if (systemMessage) {
    result.systemMessage = systemMessage;
  } else {
    result.suppressOutput = true;
  }
  console.log(JSON.stringify(result));
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
  const sessionId = data.session_id ?? data.sessionId ?? "unknown";
  const currentSize = data.current_size ?? data.currentSize ?? 0;
  const maxSize = data.max_size ?? data.maxSize ?? 0;

  // Create brain snapshot before compaction
  const snapshotResult = await createBrainSnapshot(directory, sessionId);

  // Notify kernel of pre-compact
  await notifyKernel("pre_compact", {
    directory,
    sessionId,
    currentSize,
    maxSize,
    snapshot_created: snapshotResult !== null,
    timestamp: new Date().toISOString(),
  });

  const usagePercent =
    maxSize > 0 ? Math.round((currentSize / maxSize) * 100) : 0;

  let message: string | undefined;
  if (snapshotResult) {
    message =
      `[OVERMIND] Pre-compact snapshot saved to brain. ` +
      `Context at ${usagePercent}% capacity. ` +
      `Summarize completed work and archive intermediates before proceeding.`;
  } else if (usagePercent > 80) {
    message =
      `[OVERMIND] Context at ${usagePercent}% capacity. ` +
      `Consider summarizing completed work and archiving intermediate files ` +
      `before proceeding. Use brain records to persist important findings.`;
  }

  outputHookResult(message);
}

main();

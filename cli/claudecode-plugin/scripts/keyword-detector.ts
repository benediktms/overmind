#!/usr/bin/env -S deno run -A --quiet
/**
 * Overmind Keyword Detector Hook (UserPromptSubmit)
 * Detects magic keywords for scout/relay/swarm modes
 * Keyword patterns:
 *   scout: "scout this", "explore codebase", "investigate", "find related"
 *   relay: "relay", "step by step", "sequential", "plan then execute"
 *   swarm: "swarm", "parallel", "all at once", "concurrent"
 *   done: "we're done", "complete", "finished", "all done"
 */

import { readStdin } from "./lib/stdin.ts";

export interface HookData {
  prompt?: string;
  message?: { content?: string };
  parts?: Array<{ type: string; text?: string }>;
  cwd?: string;
  directory?: string;
  session_id?: string;
  sessionId?: string;
}

const SCOUT_PATTERNS = [
  /\b(scout|explore|investigate|find related|search codebase|map out)\b/i,
  /\bfind\s+(all\s+)?(files?|code|places|usages?)\b/i,
  /\bhow\s+does\s+(this|it|the)\s+work\b/i,
];

const RELAY_PATTERNS = [
  /\b(relay|step\s*by\s*step|sequential|plan\s+then\s+execute|one\s+by\s+one)\b/i,
  /\bplan\s+first\s+(then\s+)?(do|execute|implement)\b/i,
  /\bgo\s+through\s+(the\s+)?steps?\b/i,
];

const SWARM_PATTERNS = [
  /\b(swarm|parallel|all\s+at\s+once|concurrent|max\s*(parallel|agents?))\b/i,
  /\bdo\s+it\s+all\s+(at\s+once|in\s+parallel)\b/i,
  /\bspawn\s+(multiple|all)\s+agents?\b/i,
];

const DONE_PATTERNS = [
  /\b(done|complete|finished|all\s+done|that's\s+it|wrapping\s+up)\b/i,
  /\bwe('re|\s+are)\s+(done|finished|complete)\b/i,
];

export function extractPrompt(input: HookData): string {
  if (input.prompt) return input.prompt;
  if (input.message?.content) return input.message.content;
  if (Array.isArray(input.parts)) {
    return input.parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!)
      .join(" ");
  }
  return "";
}

export function sanitizeForKeywordDetection(text: string): string {
  return text
    .replace(/<(\w[\w-]*)[\s>][\s\S]*?<\/\1>/g, "")
    .replace(/<\w[\w-]*(?:\s[^>]*)?\s*\/>/g, "")
    .replace(/https?:\/\/[^\s)>\]]+/g, "")
    .replace(/(?<=^|[\s"'`(])(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+/gm, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "");
}

export function detectKeywords(prompt: string): { mode: string; args: string }[] {
  const clean = sanitizeForKeywordDetection(prompt).toLowerCase();
  const matches: { mode: string; args: string }[] = [];

  if (SCOUT_PATTERNS.some((p) => p.test(clean))) {
    matches.push({ mode: "scout", args: "" });
  }
  if (RELAY_PATTERNS.some((p) => p.test(clean))) {
    matches.push({ mode: "relay", args: "" });
  }
  if (SWARM_PATTERNS.some((p) => p.test(clean))) {
    matches.push({ mode: "swarm", args: "" });
  }
  if (DONE_PATTERNS.some((p) => p.test(clean))) {
    matches.push({ mode: "done", args: "" });
  }

  return matches;
}

function createHookOutput(additionalContext: string): string {
  return JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  });
}

async function main(): Promise<void> {
  // Skip if disabled
  if (Deno.env.get("DISABLE_OVERMIND") === "1") {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  const input = await readStdin();
  if (!input.trim()) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  let data: HookData = {};
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const prompt = extractPrompt(data);
  if (!prompt) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const matches = detectKeywords(prompt);
  if (matches.length === 0) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Build additional context for detected modes
  const modeBlocks = matches.map((m) => {
    switch (m.mode) {
      case "scout":
        return `[OVERMIND SCOUT MODE]
Spawn parallel explore agents to gather context from multiple angles simultaneously.
Use brain tasks to track findings from each scout.`;
      case "relay":
        return `[OVERMIND RELAY MODE]
Execute steps sequentially with verification gates between each step.
Track progress via brain tasks.`;
      case "swarm":
        return `[OVERMIND SWARM MODE]
Max parallel agents with verify/fix loops.
Coordinate via neural_link room.`;
      case "done":
        return `[OVERMIND DONE]
Recording session completion. Summarize what was accomplished and close relevant brain tasks.`;
      default:
        return "";
    }
  });

  const additionalContext =
    `[OVERMIND KEYWORD DETECTED: ${matches.map((m) => m.mode.toUpperCase()).join(", ")}]\n\n` +
    modeBlocks.join("\n\n---\n\n") +
    `\n\n---\nUser request: ${prompt}`;

  console.log(createHookOutput(additionalContext));
}

if (import.meta.main) main();

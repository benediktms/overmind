#!/usr/bin/env -S deno run -A --quiet
/**
 * Overmind Skill Injector Hook (UserPromptSubmit)
 * Injects relevant skills into context based on prompt triggers
 */

import { readStdin } from "./lib/stdin.ts";

const OVERMIND_PLUGIN_ROOT = Deno.env.get("OVERMIND_PLUGIN_ROOT") ?? "";
const SKILLS_DIR = OVERMIND_PLUGIN_ROOT
  ? `${OVERMIND_PLUGIN_ROOT}/skills`
  : `${Deno.cwd()}/skills`;

const MAX_SKILLS_PER_SESSION = 5;

interface Skill {
  name: string;
  triggers: string[];
  content: string;
  path: string;
}

interface HookData {
  prompt?: string;
  message?: { content?: string };
  parts?: Array<{ type: string; text?: string }>;
  cwd?: string;
  directory?: string;
  session_id?: string;
  sessionId?: string;
}

function extractPrompt(input: HookData): string {
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

export function parseSkillFrontmatter(content: string): Skill | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;

  const yamlContent = match[1];
  const body = match[2].trim();

  const triggers: string[] = [];
  const triggerListMatch = yamlContent.match(
    /(?:^|\n)triggers:\s*\n((?:\s+-\s*.+\n?)*)/,
  );
  if (triggerListMatch) {
    const lines = triggerListMatch[1].split("\n");
    for (const line of lines) {
      const itemMatch = line.match(/^\s+-\s*["']?([^"'\n]+)["']?\s*$/);
      if (itemMatch) {
        const normalized = itemMatch[1].trim().toLowerCase();
        if (normalized) triggers.push(normalized);
      }
    }
  } else {
    const triggerScalarMatch = yamlContent.match(/(?:^|\n)triggers:\s*([^\n]*)/);
    if (triggerScalarMatch) {
      let triggerValue = triggerScalarMatch[1].trim();
      if (triggerValue.startsWith("[") && triggerValue.endsWith("]")) {
        triggerValue = triggerValue.slice(1, -1).trim();
      }
      if (triggerValue) {
        const parsed = triggerValue
          .split(",")
          .map((value) => value.trim().replace(/^['"]|['"]$/g, ""))
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean);
        triggers.push(...parsed);
      }
    }
  }

  const nameMatch = yamlContent.match(/name:\s*["']?([^"'\n]+)["']?/);
  const name = nameMatch ? nameMatch[1].trim() : "Unnamed Skill";

  return { name, triggers, content: body, path: "" };
}

async function findSkillFiles(directory: string): Promise<string[]> {
  const candidates: string[] = [];
  try {
    for await (const entry of Deno.readDir(SKILLS_DIR)) {
      if (entry.isFile && entry.name.endsWith(".md")) {
        candidates.push(`${SKILLS_DIR}/${entry.name}`);
      }
    }
  } catch {
    // Skills dir doesn't exist
  }
  return candidates;
}

function findMatchingSkills(
  prompt: string,
  alreadyInjected: Set<string>,
): Skill[] {
  const promptLower = prompt.toLowerCase();
  const matches: (Skill & { score: number })[] = [];

  for (const path of Object.keys(injectedSkills)) {
    if (alreadyInjected.has(path)) continue;
    const skill = injectedSkills[path];
    let score = 0;
    for (const trigger of skill.triggers) {
      if (promptLower.includes(trigger)) {
        score += 10;
      }
    }
    if (score > 0) {
      matches.push({ ...skill, path, score });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, MAX_SKILLS_PER_SESSION) as Skill[];
}

const injectedSkills: Record<string, Skill> = {};

function formatSkillsMessage(skills: Skill[]): string {
  const lines = [
    "<mnemosyne>",
    "",
    "## Relevant Overmind Skills",
    "",
    "The following skills from previous sessions may help:",
    "",
  ];

  for (const skill of skills) {
    lines.push(`### ${skill.name}`);
    lines.push("");
    lines.push(skill.content);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  lines.push("</mnemosyne>");
  return lines.join("\n");
}

async function main(): Promise<void> {
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
  const sessionId = data.session_id ?? data.sessionId ?? "unknown";
  const directory = data.cwd ?? data.directory ?? Deno.cwd();

  if (!prompt) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Load skill files if not cached
  if (Object.keys(injectedSkills).length === 0) {
    const skillFiles = await findSkillFiles(directory);
    for (const path of skillFiles) {
      try {
        const content = await Deno.readTextFile(path);
        const skill = parseSkillFrontmatter(content);
        if (skill) {
          injectedSkills[path] = { ...skill, path };
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  // Session-scoped injection tracking (in-memory per process)
  const cacheKey = sessionId;
  if (!sessionInjected.has(cacheKey)) {
    sessionInjected.set(cacheKey, new Set());
  }
  const alreadyInjected = sessionInjected.get(cacheKey)!;

  const matchingSkills = findMatchingSkills(prompt, alreadyInjected);

  if (matchingSkills.length > 0) {
    for (const skill of matchingSkills) {
      alreadyInjected.add(skill.path);
    }
    console.log(
      JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: formatSkillsMessage(matchingSkills),
        },
      }),
    );
  } else {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

const sessionInjected = new Map<string, Set<string>>();

if (import.meta.main) {
  main();
}

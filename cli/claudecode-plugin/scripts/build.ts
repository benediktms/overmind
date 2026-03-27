#!/usr/bin/env -S deno run -A --quiet

import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

interface PluginManifest {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  skills?: unknown;
  mcpServers?: unknown;
}

const LEGACY_PLUGIN_ROOT = "OVERMIND_" + "PLUGIN_ROOT";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readJson(path: string): Promise<unknown> {
  const content = await Deno.readTextFile(path);
  return JSON.parse(content);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

function resolveRelativeCandidates(baseRoot: string, baseDir: string, target: string): string[] {
  if (isAbsolute(target)) {
    return [normalize(target)];
  }

  const stripped = target.replace(/^\.\//, "");
  return [
    normalize(join(baseRoot, stripped)),
    normalize(resolve(baseDir, target)),
  ];
}

function parseSkillHeader(content: string): {
  hasFrontmatter: boolean;
  name: string | null;
  description: string | null;
  triggers: string[];
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { hasFrontmatter: false, name: null, description: null, triggers: [] };
  }

  const yamlContent = match[1];
  const nameMatch = yamlContent.match(/(?:^|\n)name:\s*["']?([^"'\n]+)["']?/);
  const descriptionMatch = yamlContent.match(/(?:^|\n)description:\s*["']?([^"'\n]+)["']?/);

  const triggers: string[] = [];
  const triggerListMatch = yamlContent.match(/(?:^|\n)triggers:\s*\n((?:\s+-\s*.+\n?)*)/);
  if (triggerListMatch) {
    for (const line of triggerListMatch[1].split("\n")) {
      const itemMatch = line.match(/^\s+-\s*["']?([^"'\n]+)["']?\s*$/);
      if (itemMatch) {
        const trigger = itemMatch[1].trim();
        if (trigger) {
          triggers.push(trigger);
        }
      }
    }
  } else {
    const triggerScalarMatch = yamlContent.match(/(?:^|\n)triggers:\s*([^\n]*)/);
    if (triggerScalarMatch) {
      let scalar = triggerScalarMatch[1].trim();
      if (scalar.startsWith("[") && scalar.endsWith("]")) {
        scalar = scalar.slice(1, -1).trim();
      }
      if (scalar) {
        const values = scalar
          .split(",")
          .map((value) => value.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
        triggers.push(...values);
      }
    }
  }

  return {
    hasFrontmatter: true,
    name: nameMatch?.[1]?.trim() ?? null,
    description: descriptionMatch?.[1]?.trim() ?? null,
    triggers,
  };
}

async function validateHookScriptPaths(pluginRoot: string, errors: string[]): Promise<void> {
  const hooksPath = join(pluginRoot, "hooks", "hooks.json");
  let hooksJson: unknown;

  try {
    hooksJson = await readJson(hooksPath);
  } catch (error) {
    errors.push(`hooks.json is missing or invalid JSON: ${String(error)}`);
    return;
  }

  const commands: string[] = [];
  if (isRecord(hooksJson) && isRecord(hooksJson.hooks)) {
    for (const entries of Object.values(hooksJson.hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!isRecord(entry) || !Array.isArray(entry.hooks)) continue;
        for (const hook of entry.hooks) {
          if (isRecord(hook) && typeof hook.command === "string") {
            commands.push(hook.command);
          }
        }
      }
    }
  }

  const scriptRegex = /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([A-Za-z0-9._-]+\.ts)/g;
  for (const command of commands) {
    for (const match of command.matchAll(scriptRegex)) {
      const scriptName = match[1];
      const scriptPath = join(pluginRoot, "scripts", scriptName);
      if (!(await fileExists(scriptPath))) {
        errors.push(`Hook command references missing script: scripts/${scriptName}`);
      }
    }
  }
}

async function validatePluginManifest(pluginRoot: string, errors: string[]): Promise<PluginManifest | null> {
  const pluginJsonPath = join(pluginRoot, ".claude-plugin", "plugin.json");
  let pluginJson: unknown;

  try {
    pluginJson = await readJson(pluginJsonPath);
  } catch (error) {
    errors.push(`plugin.json is missing or invalid JSON: ${String(error)}`);
    return null;
  }

  if (!isRecord(pluginJson)) {
    errors.push("plugin.json must be a JSON object");
    return null;
  }

  const requiredFields: Array<keyof PluginManifest> = [
    "name",
    "version",
    "description",
    "skills",
    "mcpServers",
  ];

  for (const field of requiredFields) {
    const value = pluginJson[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      errors.push(`plugin.json missing required string field: ${field}`);
    }
  }

  return pluginJson;
}

async function validateMcpBridge(
  pluginRoot: string,
  pluginJson: PluginManifest | null,
  errors: string[],
): Promise<void> {
  if (!pluginJson || typeof pluginJson.mcpServers !== "string") {
    return;
  }

  const pluginJsonDir = join(pluginRoot, ".claude-plugin");
  const candidates = resolveRelativeCandidates(pluginRoot, pluginJsonDir, pluginJson.mcpServers);
  let selectedPath: string | null = null;
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      selectedPath = candidate;
      break;
    }
  }

  if (!selectedPath) {
    errors.push(`mcp-bridge.json path not found from plugin.json: ${pluginJson.mcpServers}`);
    return;
  }

  let mcpBridge: unknown;
  try {
    mcpBridge = await readJson(selectedPath);
  } catch (error) {
    errors.push(`mcp-bridge.json is invalid JSON at ${selectedPath}: ${String(error)}`);
    return;
  }

  if (!isRecord(mcpBridge) || !isRecord(mcpBridge.mcpServers) || Object.keys(mcpBridge.mcpServers).length === 0) {
    errors.push(`mcp-bridge.json must contain a non-empty mcpServers object: ${selectedPath}`);
  }
}

async function validateSkillFrontmatter(
  pluginRoot: string,
  pluginJson: PluginManifest | null,
  errors: string[],
): Promise<void> {
  const defaultSkillsDir = join(pluginRoot, "skills");
  let skillsDir = defaultSkillsDir;

  if (pluginJson && typeof pluginJson.skills === "string") {
    const pluginJsonDir = join(pluginRoot, ".claude-plugin");
    const candidates = resolveRelativeCandidates(pluginRoot, pluginJsonDir, pluginJson.skills);
    for (const candidate of candidates) {
      if (await fileExists(candidate)) {
        skillsDir = candidate;
        break;
      }
    }
  }

  const skillFiles: string[] = [];
  try {
    for await (const entry of Deno.readDir(skillsDir)) {
      if (entry.isFile && entry.name.endsWith(".md")) {
        skillFiles.push(join(skillsDir, entry.name));
      }
    }
  } catch (error) {
    errors.push(`skills directory missing or unreadable: ${skillsDir} (${String(error)})`);
    return;
  }

  for (const skillPath of skillFiles) {
    let content = "";
    try {
      content = await Deno.readTextFile(skillPath);
    } catch (error) {
      errors.push(`unable to read skill file: ${skillPath} (${String(error)})`);
      continue;
    }

    const parsed = parseSkillHeader(content);
    const relativePath = skillPath.startsWith(`${pluginRoot}/`)
      ? skillPath.slice(pluginRoot.length + 1)
      : skillPath;

    if (!parsed.hasFrontmatter) {
      errors.push(`skill frontmatter missing: ${relativePath}`);
      continue;
    }

    if (!parsed.name) {
      errors.push(`skill frontmatter missing name: ${relativePath}`);
    }
    if (!parsed.description) {
      errors.push(`skill frontmatter missing description: ${relativePath}`);
    }
    if (parsed.triggers.length === 0) {
      errors.push(`skill frontmatter missing triggers: ${relativePath}`);
    }
  }
}

async function walkFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory) {
      files.push(...await walkFiles(fullPath));
      continue;
    }
    if (entry.isFile) {
      files.push(fullPath);
    }
  }
  return files;
}

async function validateNoLegacyPluginRoot(pluginRoot: string, errors: string[]): Promise<void> {
  const files = await walkFiles(pluginRoot);
  for (const filePath of files) {
    let content: string;
    try {
      content = await Deno.readTextFile(filePath);
    } catch {
      continue;
    }

    if (content.includes(LEGACY_PLUGIN_ROOT)) {
      const relativePath = filePath.startsWith(`${pluginRoot}/`)
        ? filePath.slice(pluginRoot.length + 1)
        : filePath;
      errors.push(`Found legacy env var ${LEGACY_PLUGIN_ROOT} in ${relativePath}`);
    }
  }
}

async function validatePackageJson(pluginRoot: string, errors: string[]): Promise<void> {
  const packageJsonPath = join(pluginRoot, "package.json");
  let packageJson: unknown;

  try {
    packageJson = await readJson(packageJsonPath);
  } catch (error) {
    errors.push(`package.json is missing or invalid JSON: ${String(error)}`);
    return;
  }

  const raw = JSON.stringify(packageJson);
  if (raw.includes("dist/")) {
    errors.push("package.json contains stale dist/ references");
  }

  if (!isRecord(packageJson) || !isRecord(packageJson.scripts)) {
    return;
  }

  const staleScriptPatterns = [
    /scripts\/build\.(?:js|ts)/i,
    /dist\//i,
    /\b(?:prebuild|build|postbuild)\b/i,
  ];

  for (const [name, command] of Object.entries(packageJson.scripts)) {
    if (typeof command !== "string") continue;
    const signature = `${name}:${command}`;
    if (staleScriptPatterns.some((pattern) => pattern.test(signature))) {
      errors.push(`package.json contains stale build script reference: ${name}`);
    }
  }
}

export async function validatePluginLayout(pluginRoot: string): Promise<ValidationResult> {
  const errors: string[] = [];

  await validateHookScriptPaths(pluginRoot, errors);
  const pluginJson = await validatePluginManifest(pluginRoot, errors);
  await validateMcpBridge(pluginRoot, pluginJson, errors);
  await validateSkillFrontmatter(pluginRoot, pluginJson, errors);
  await validateNoLegacyPluginRoot(pluginRoot, errors);
  await validatePackageJson(pluginRoot, errors);

  return {
    valid: errors.length === 0,
    errors,
  };
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const pluginRoot = Deno.args[0] ? resolve(Deno.args[0]) : resolve(scriptDir, "..");

  const result = await validatePluginLayout(pluginRoot);
  if (!result.valid) {
    console.error("Plugin layout validation failed:");
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    Deno.exit(1);
  }

  console.log("Plugin layout validation passed");
}

if (import.meta.main) {
  main();
}

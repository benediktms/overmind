#!/usr/bin/env -S deno run -A --quiet

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_PLUGIN_ID = "overmind@local";
const MARKETPLACE_PLUGIN_ID = "overmind@overmind";
const MARKETPLACE_SOURCE = { source: "github" as const, repo: "benediktms/overmind" };

export type InstallMode = "local" | "marketplace";

export interface InstallerOptions {
  mode?: InstallMode;
  pluginDir?: string;
  settingsPath?: string;
  sourcePluginRoot?: string;
  symlink?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function defaultSourcePluginRoot(): string {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  return resolve(scriptDir, "..");
}

function resolvePaths(opts: InstallerOptions): {
  pluginDir: string;
  settingsPath: string;
  sourcePluginRoot: string;
  symlink: boolean;
} {
  const home = Deno.env.get("HOME");
  if (!home && (!opts.pluginDir || !opts.settingsPath)) {
    throw new Error("HOME environment variable is required when pluginDir/settingsPath are not provided");
  }

  return {
    pluginDir: resolve(opts.pluginDir ?? `${home}/.claude/plugins/overmind`),
    settingsPath: resolve(opts.settingsPath ?? `${home}/.claude/settings.json`),
    sourcePluginRoot: resolve(opts.sourcePluginRoot ?? defaultSourcePluginRoot()),
    symlink: opts.symlink ?? true,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function removePath(path: string): Promise<void> {
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.lstat(path);
  } catch {
    return;
  }

  if (stat.isSymlink) {
    await Deno.remove(path);
    return;
  }

  await Deno.remove(path, { recursive: true });
}

async function copyDirectoryRecursive(sourceDir: string, targetDir: string): Promise<void> {
  await Deno.mkdir(targetDir, { recursive: true });

  for await (const entry of Deno.readDir(sourceDir)) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);

    if (entry.isDirectory) {
      await copyDirectoryRecursive(sourcePath, targetPath);
      continue;
    }

    if (entry.isSymlink) {
      const linkTarget = await Deno.readLink(sourcePath);
      await Deno.symlink(linkTarget, targetPath);
      continue;
    }

    if (entry.isFile) {
      await Deno.copyFile(sourcePath, targetPath);
    }
  }
}

async function readSettings(settingsPath: string): Promise<Record<string, unknown>> {
  if (!(await pathExists(settingsPath))) {
    return {};
  }

  const content = await Deno.readTextFile(settingsPath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON in settings file (${settingsPath}): ${String(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`Invalid settings file (${settingsPath}): expected top-level JSON object`);
  }

  return parsed;
}

async function writeSettings(settingsPath: string, settings: Record<string, unknown>): Promise<void> {
  await Deno.mkdir(dirname(settingsPath), { recursive: true });
  await Deno.writeTextFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function withLocalPlugin(settings: Record<string, unknown>): Record<string, unknown> {
  const next = { ...settings };
  const enabledPlugins = isRecord(next.enabledPlugins) ? { ...next.enabledPlugins } : {};
  enabledPlugins[LOCAL_PLUGIN_ID] = true;
  delete enabledPlugins[MARKETPLACE_PLUGIN_ID];
  next.enabledPlugins = enabledPlugins;

  if (isRecord(next.extraKnownMarketplaces)) {
    const marketplaces = { ...next.extraKnownMarketplaces };
    delete marketplaces["overmind"];
    next.extraKnownMarketplaces = marketplaces;
  }

  return next;
}

function withMarketplacePlugin(settings: Record<string, unknown>): Record<string, unknown> {
  const next = { ...settings };
  const enabledPlugins = isRecord(next.enabledPlugins) ? { ...next.enabledPlugins } : {};
  enabledPlugins[MARKETPLACE_PLUGIN_ID] = true;
  delete enabledPlugins[LOCAL_PLUGIN_ID];
  next.enabledPlugins = enabledPlugins;

  const marketplaces = isRecord(next.extraKnownMarketplaces) ? { ...next.extraKnownMarketplaces } : {};
  marketplaces["overmind"] = { source: MARKETPLACE_SOURCE };
  next.extraKnownMarketplaces = marketplaces;

  return next;
}

function withoutAllOvemindPlugins(settings: Record<string, unknown>): Record<string, unknown> {
  const next = { ...settings };

  if (isRecord(next.enabledPlugins)) {
    const enabledPlugins = { ...next.enabledPlugins };
    delete enabledPlugins[LOCAL_PLUGIN_ID];
    delete enabledPlugins[MARKETPLACE_PLUGIN_ID];
    next.enabledPlugins = enabledPlugins;
  }

  if (isRecord(next.extraKnownMarketplaces)) {
    const marketplaces = { ...next.extraKnownMarketplaces };
    delete marketplaces["overmind"];
    next.extraKnownMarketplaces = marketplaces;
  }

  return next;
}

async function ensurePluginInstalled(
  sourcePluginRoot: string,
  pluginDir: string,
  symlink: boolean,
): Promise<void> {
  await Deno.mkdir(dirname(pluginDir), { recursive: true });

  if (symlink) {
    const sourceRealPath = await Deno.realPath(sourcePluginRoot);
    if (await pathExists(pluginDir)) {
      const stat = await Deno.lstat(pluginDir);
      if (stat.isSymlink) {
        const currentTarget = await Deno.realPath(pluginDir);
        if (currentTarget === sourceRealPath) {
          return;
        }
      }
      await removePath(pluginDir);
    }
    await Deno.symlink(sourcePluginRoot, pluginDir);
    return;
  }

  await removePath(pluginDir);
  await copyDirectoryRecursive(sourcePluginRoot, pluginDir);
}

export async function installPlugin(opts: InstallerOptions = {}): Promise<void> {
  const mode = opts.mode ?? "local";
  const { pluginDir, settingsPath, sourcePluginRoot, symlink } = resolvePaths(opts);

  if (mode === "local") {
    await ensurePluginInstalled(sourcePluginRoot, pluginDir, symlink);
  }

  const settings = await readSettings(settingsPath);
  const patched = mode === "marketplace"
    ? withMarketplacePlugin(settings)
    : withLocalPlugin(settings);
  await writeSettings(settingsPath, patched);
}

export async function uninstallPlugin(opts: InstallerOptions = {}): Promise<void> {
  const { pluginDir, settingsPath } = resolvePaths(opts);

  await removePath(pluginDir);

  if (!(await pathExists(settingsPath))) {
    return;
  }

  const settings = await readSettings(settingsPath);
  const patched = withoutAllOvemindPlugins(settings);
  await writeSettings(settingsPath, patched);
}

function parseBoolean(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseCliArgs(args: string[]): { command: "install" | "uninstall"; options: InstallerOptions } {
  const [command, ...rest] = args;
  if (command !== "install" && command !== "uninstall") {
    throw new Error("Usage: installer.ts <install|uninstall> [--mode local|marketplace] [--plugin-dir <path>] [--settings-path <path>] [--source-plugin-root <path>] [--symlink <true|false>]");
  }

  const options: InstallerOptions = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = rest[i + 1];

    if (arg === "--mode") {
      if (value !== "local" && value !== "marketplace") {
        throw new Error("--mode must be 'local' or 'marketplace'");
      }
      options.mode = value;
      i++;
      continue;
    }

    if (arg === "--plugin-dir") {
      if (!value) throw new Error("Missing value for --plugin-dir");
      options.pluginDir = value;
      i++;
      continue;
    }

    if (arg === "--settings-path") {
      if (!value) throw new Error("Missing value for --settings-path");
      options.settingsPath = value;
      i++;
      continue;
    }

    if (arg === "--source-plugin-root") {
      if (!value) throw new Error("Missing value for --source-plugin-root");
      options.sourcePluginRoot = value;
      i++;
      continue;
    }

    if (arg === "--symlink") {
      if (!value) throw new Error("Missing value for --symlink");
      options.symlink = parseBoolean(value);
      i++;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return { command, options };
}

async function main(): Promise<void> {
  const { command, options } = parseCliArgs(Deno.args);
  if (command === "install") {
    await installPlugin(options);
    return;
  }
  await uninstallPlugin(options);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(String(error));
    Deno.exit(1);
  });
}

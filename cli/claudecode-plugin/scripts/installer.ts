#!/usr/bin/env -S deno run -A --quiet

import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { stopDaemon } from "../../../kernel/daemon.ts";

// Plugin IDs: <plugin-name>@<marketplace-name>. Both modes use the same
// marketplace name ("overmind") because Claude Code requires the @<marketplace>
// suffix to map to a registered entry in `extraKnownMarketplaces`. Local and
// marketplace modes differ only in the marketplace's `source` (directory vs
// github); the plugin ID is identical.
const PLUGIN_ID = "overmind@overmind";
const MARKETPLACE_NAME = "overmind";
const MARKETPLACE_GITHUB_SOURCE = {
  source: "github" as const,
  repo: "benediktms/overmind",
};

// Legacy ID written by older installer versions (which assumed a built-in
// "local" marketplace that never existed). Cleaned up on every install.
const LEGACY_LOCAL_PLUGIN_ID = "overmind@local";

// Name under which the MCP server is registered globally in ~/.claude.json.
// This is the path Claude Code's `/mcp` command reads from. The plugin-bundled
// `.mcp.json` is unreliable for our case (multiple cache/symlink layers
// between source and what Claude Code actually loads), so we register
// directly in the global config like brain / neural_link / context7 do.
const MCP_SERVER_NAME = "overmind";

// Compiled binary layout. Mirrors brain's model:
//   <repo>/dist/overmind        ← `deno compile` artifact
//   ~/.local/bin/overmind       ← user-PATH symlink → dist artifact
// Claude Code's MCP entry points at the symlink with args ["mcp"], so the
// same binary serves CLI, daemon, and stdio MCP — no Node bridge required.
const BINARY_NAME = "overmind";
const COMPILE_ENTRYPOINT = "cli/overmind.ts";
const COMPILED_OUTPUT_REL = "dist/overmind";
const DEFAULT_BIN_DIR = ".local/bin";

// Marker pair for the global CLAUDE.md block. Mirrors oh-my-claudecode's
// `<!-- OMC:START -->` pattern so the two systems coexist without stomping.
// On install we upsert the block; on uninstall we remove it (preserving
// anything outside the markers).
const AGENT_BLOCK_VERSION = "0.3.0";
const AGENT_BLOCK_START = "<!-- overmind:start -->";
const AGENT_BLOCK_END = "<!-- overmind:end -->";
const AGENT_BLOCK_BODY = `${AGENT_BLOCK_START}
<!-- overmind:version:${AGENT_BLOCK_VERSION} -->

# Overmind — Multi-Agent Orchestration

Overmind is a swarm coordinator exposed via \`mcp__overmind__*\` tools.

<delegation_rules>
Delegate via \`mcp__overmind__overmind_delegate\` when work spans multiple
files, benefits from parallel investigation, or wants a verify/fix loop.
Otherwise do the work inline.

If \`overmind_delegate\` returns a connection error, fall back to inline —
do not pre-flight \`overmind_status\`.
</delegation_rules>

<mode_defaults>
Default to \`swarm\` for reviews, \`relay\` for refactors, \`scout\` for research.
The tool schema's \`mode\` description explains each mode in detail.
</mode_defaults>

<tool_reference>
\`mcp__overmind__overmind_delegate\` — submit an objective with mode + priority.
\`mcp__overmind__overmind_status\`   — kernel + neural_link health snapshot.
</tool_reference>

${AGENT_BLOCK_END}`;

export type InstallMode = "local" | "marketplace";

export interface InstallerOptions {
  mode?: InstallMode;
  pluginDir?: string;
  settingsPath?: string;
  sourcePluginRoot?: string;
  marketplaceSourcePath?: string;
  claudeJsonPath?: string;
  /**
   * Path to the global CLAUDE.md (default: ~/.claude/CLAUDE.md) where the
   * overmind agent-routing block is upserted. Override in tests.
   */
  claudeMdPath?: string;
  /**
   * Override for `~/.claude/plugins/cache` — the directory under which the
   * versioned plugin cache symlink is created. Tests should set this to a
   * tmpdir to avoid leaking into the real Claude Code cache.
   */
  pluginCacheRoot?: string;
  binaryPath?: string;
  binDir?: string;
  symlink?: boolean;
  skipCompile?: boolean;
  skipDaemonStart?: boolean;
  /**
   * Override for `~/.config/overmind/overmind.toml` — the user-level config
   * file that the daemon's ConfigLoader reads at startup. The installer
   * seeds this from the repo's `config/overmind.toml` template on first
   * install and never overwrites an existing file. Tests should set this
   * to a tmpdir path.
   */
  userConfigPath?: string;
  /**
   * Override for `~/.overmind` — the daemon runtime directory holding
   * `daemon.pid`, `daemon.sock`, `daemon.lock`, and the per-workspace
   * `state/` subdirectory. Used by `uninstallPlugin` to stop the daemon
   * and clean install-orphaned files. Tests should set this to a
   * tmpdir to avoid touching the operator's real runtime state.
   */
  overmindRuntimeDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function defaultSourcePluginRoot(): string {
  const scriptDir = dirname(fromFileUrl(import.meta.url));
  return resolve(scriptDir, "..");
}

function defaultMarketplaceSourcePath(): string {
  // The directory-source marketplace points at the repo root, where
  // `.claude-plugin/marketplace.json` lives. Three levels up from this
  // script: cli/claudecode-plugin/scripts/installer.ts → repo root.
  const scriptDir = dirname(fromFileUrl(import.meta.url));
  return resolve(scriptDir, "..", "..", "..");
}

function resolvePaths(opts: InstallerOptions): {
  pluginDir: string;
  settingsPath: string;
  sourcePluginRoot: string;
  marketplaceSourcePath: string;
  claudeJsonPath: string;
  claudeMdPath: string;
  pluginCacheRoot: string;
  binaryPath: string;
  binDir: string;
  symlink: boolean;
  skipCompile: boolean;
  skipDaemonStart: boolean;
  userConfigPath: string;
  overmindRuntimeDir: string;
} {
  const home = Deno.env.get("HOME");
  if (!home && (!opts.pluginDir || !opts.settingsPath)) {
    throw new Error(
      "HOME environment variable is required when pluginDir/settingsPath are not provided",
    );
  }

  const sourcePluginRoot = resolve(
    opts.sourcePluginRoot ?? defaultSourcePluginRoot(),
  );
  const marketplaceSourcePath = resolve(
    opts.marketplaceSourcePath ?? defaultMarketplaceSourcePath(),
  );
  const binDir = resolve(opts.binDir ?? `${home}/${DEFAULT_BIN_DIR}`);
  const pluginDir = resolve(
    opts.pluginDir ?? `${home}/.claude/plugins/overmind`,
  );
  // Default the cache root next to the plugin dir so test overrides of
  // pluginDir naturally redirect cache writes too.
  const pluginCacheRoot = resolve(
    opts.pluginCacheRoot ?? `${dirname(pluginDir)}/cache`,
  );

  return {
    pluginDir,
    settingsPath: resolve(opts.settingsPath ?? `${home}/.claude/settings.json`),
    sourcePluginRoot,
    marketplaceSourcePath,
    claudeJsonPath: resolve(opts.claudeJsonPath ?? `${home}/.claude.json`),
    claudeMdPath: resolve(opts.claudeMdPath ?? `${home}/.claude/CLAUDE.md`),
    pluginCacheRoot,
    binaryPath: resolve(opts.binaryPath ?? `${binDir}/${BINARY_NAME}`),
    binDir,
    symlink: opts.symlink ?? true,
    skipCompile: opts.skipCompile ?? false,
    skipDaemonStart: opts.skipDaemonStart ?? false,
    userConfigPath: resolve(
      opts.userConfigPath ?? `${home}/.config/overmind/overmind.toml`,
    ),
    overmindRuntimeDir: resolve(
      opts.overmindRuntimeDir ?? `${home}/.overmind`,
    ),
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

async function copyDirectoryRecursive(
  sourceDir: string,
  targetDir: string,
): Promise<void> {
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

async function readSettings(
  settingsPath: string,
): Promise<Record<string, unknown>> {
  if (!(await pathExists(settingsPath))) {
    return {};
  }

  const content = await Deno.readTextFile(settingsPath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Invalid JSON in settings file (${settingsPath}): ${String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(
      `Invalid settings file (${settingsPath}): expected top-level JSON object`,
    );
  }

  return parsed;
}

async function writeSettings(
  settingsPath: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await Deno.mkdir(dirname(settingsPath), { recursive: true });
  await Deno.writeTextFile(
    settingsPath,
    `${JSON.stringify(settings, null, 2)}\n`,
  );
}

function withLocalPlugin(
  settings: Record<string, unknown>,
  marketplaceSourcePath: string,
): Record<string, unknown> {
  const next = { ...settings };
  const enabledPlugins = isRecord(next.enabledPlugins)
    ? { ...next.enabledPlugins }
    : {};
  enabledPlugins[PLUGIN_ID] = true;
  delete enabledPlugins[LEGACY_LOCAL_PLUGIN_ID];
  next.enabledPlugins = enabledPlugins;

  const marketplaces = isRecord(next.extraKnownMarketplaces)
    ? { ...next.extraKnownMarketplaces }
    : {};
  marketplaces[MARKETPLACE_NAME] = {
    source: { source: "directory" as const, path: marketplaceSourcePath },
  };
  next.extraKnownMarketplaces = marketplaces;

  return next;
}

function withMarketplacePlugin(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...settings };
  const enabledPlugins = isRecord(next.enabledPlugins)
    ? { ...next.enabledPlugins }
    : {};
  enabledPlugins[PLUGIN_ID] = true;
  delete enabledPlugins[LEGACY_LOCAL_PLUGIN_ID];
  next.enabledPlugins = enabledPlugins;

  const marketplaces = isRecord(next.extraKnownMarketplaces)
    ? { ...next.extraKnownMarketplaces }
    : {};
  marketplaces[MARKETPLACE_NAME] = { source: MARKETPLACE_GITHUB_SOURCE };
  next.extraKnownMarketplaces = marketplaces;

  return next;
}

function withGlobalMcpServer(
  claudeJson: Record<string, unknown>,
  binaryPath: string,
): Record<string, unknown> {
  const next = { ...claudeJson };
  const mcpServers = isRecord(next.mcpServers) ? { ...next.mcpServers } : {};
  mcpServers[MCP_SERVER_NAME] = {
    type: "stdio",
    command: binaryPath,
    args: ["mcp"],
    env: {},
  };
  next.mcpServers = mcpServers;
  return next;
}

function withoutGlobalMcpServer(
  claudeJson: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...claudeJson };
  if (isRecord(next.mcpServers)) {
    const mcpServers = { ...next.mcpServers };
    delete mcpServers[MCP_SERVER_NAME];
    next.mcpServers = mcpServers;
  }
  return next;
}

/**
 * Strip every overmind-marked block from a document, leaving the surrounding
 * content intact. Tolerant of: duplicate blocks (both removed), unterminated
 * blocks (start marker without end — removed to EOF), and absent blocks
 * (no-op). The result has at most one trailing newline.
 */
function stripAgentBlocks(existing: string): string {
  let out = existing;
  while (true) {
    const startIdx = out.indexOf(AGENT_BLOCK_START);
    if (startIdx === -1) break;
    const endIdx = out.indexOf(AGENT_BLOCK_END, startIdx);
    let cutStart = startIdx;
    while (cutStart > 0 && out[cutStart - 1] === "\n") cutStart -= 1;
    let cutEnd: number;
    if (endIdx === -1) {
      cutEnd = out.length;
    } else {
      cutEnd = endIdx + AGENT_BLOCK_END.length;
      while (cutEnd < out.length && out[cutEnd] === "\n") cutEnd += 1;
    }
    const before = out.slice(0, cutStart);
    const after = out.slice(cutEnd);
    out = before.length === 0
      ? after
      : after.length === 0
      ? (before.endsWith("\n") ? before : before + "\n")
      : before + "\n" + after;
  }
  return out;
}

/**
 * Upsert the marked overmind block into a CLAUDE.md document. Idempotent
 * across repeat installs (file content stable after the first run) and
 * resilient to corrupted state (duplicate blocks collapsed to one,
 * unterminated blocks repaired). Anything outside the markers is preserved
 * verbatim — including manual edits the user has made above or below the
 * block, but NOT inside it (the block is installer-owned).
 */
export function withOvermindAgentBlock(existing: string): string {
  const stripped = stripAgentBlocks(existing);
  if (stripped.length === 0) return AGENT_BLOCK_BODY + "\n";
  const trailing = stripped.endsWith("\n") ? "" : "\n";
  return `${stripped}${trailing}\n${AGENT_BLOCK_BODY}\n`;
}

/**
 * Remove every overmind block from a document. Returns the document
 * unchanged if no block is present.
 */
export function withoutOvermindAgentBlock(existing: string): string {
  return stripAgentBlocks(existing);
}

// Build the timestamped backup path for a given CLAUDE.md location.
// Format: `<path>.<UTC ISO timestamp with `:` and `.` replaced by `-`>.bak`,
// e.g. `CLAUDE.md.2026-04-29T13-45-22-123Z.bak`. The replacements keep the
// filename portable across filesystems that disallow `:` (Windows / SMB /
// some FAT variants) and avoid the dot-confusion of a second `.` inside the
// stem. Each mutation gets its own file so backups never silently overwrite
// each other; users can `ls *.bak | sort` to find the oldest pre-overmind
// state when needed.
function backupPathFor(claudeMdPath: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${claudeMdPath}.${stamp}.bak`;
}

// Snapshot the current contents of CLAUDE.md to a fresh timestamped `.bak`
// before any mutation. Caller is responsible for skipping this when the
// mutation is a no-op (idempotent re-run with unchanged content), so the
// backup file count stays bounded by the number of *real* changes.
async function snapshotBackup(
  claudeMdPath: string,
  contents: string,
): Promise<void> {
  await Deno.writeTextFile(backupPathFor(claudeMdPath), contents);
}

async function upsertAgentBlock(claudeMdPath: string): Promise<void> {
  await Deno.mkdir(dirname(claudeMdPath), { recursive: true });

  let existing: string | null = null;
  try {
    existing = await Deno.readTextFile(claudeMdPath);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  const next = withOvermindAgentBlock(existing ?? "");
  if (existing !== null && existing === next) {
    // Idempotent re-run — content unchanged, no need to write or back up.
    return;
  }

  if (existing !== null) {
    await snapshotBackup(claudeMdPath, existing);
  }

  await Deno.writeTextFile(claudeMdPath, next);
}

async function removeAgentBlock(claudeMdPath: string): Promise<void> {
  let existing: string;
  try {
    existing = await Deno.readTextFile(claudeMdPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
  const next = withoutOvermindAgentBlock(existing);
  if (next === existing) return;

  // Uninstall mutates CLAUDE.md too — same backup contract as install.
  await snapshotBackup(claudeMdPath, existing);

  if (next.length === 0) {
    await Deno.remove(claudeMdPath);
    return;
  }
  await Deno.writeTextFile(claudeMdPath, next);
}

function withoutAllOvemindPlugins(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...settings };

  if (isRecord(next.enabledPlugins)) {
    const enabledPlugins = { ...next.enabledPlugins };
    delete enabledPlugins[PLUGIN_ID];
    delete enabledPlugins[LEGACY_LOCAL_PLUGIN_ID];
    next.enabledPlugins = enabledPlugins;
  }

  if (isRecord(next.extraKnownMarketplaces)) {
    const marketplaces = { ...next.extraKnownMarketplaces };
    delete marketplaces[MARKETPLACE_NAME];
    next.extraKnownMarketplaces = marketplaces;
  }

  return next;
}

async function compileBinary(repoRoot: string): Promise<string | null> {
  // Skip silently when called with a synthetic plugin root that has no
  // `cli/overmind.ts` (e.g. unit tests).
  const entrypoint = resolve(`${repoRoot}/${COMPILE_ENTRYPOINT}`);
  if (!(await pathExists(entrypoint))) return null;

  const outputPath = resolve(`${repoRoot}/${COMPILED_OUTPUT_REL}`);
  await Deno.mkdir(dirname(outputPath), { recursive: true });

  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "compile",
      "--allow-all",
      "--config",
      resolve(`${repoRoot}/deno.json`),
      "--output",
      outputPath,
      entrypoint,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });

  const result = await command.output();
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`deno compile failed:\n${stderr}`);
  }

  return outputPath;
}

async function symlinkBinary(
  compiledPath: string,
  binaryPath: string,
): Promise<void> {
  await Deno.mkdir(dirname(binaryPath), { recursive: true });
  // Upsert: always replace, same rationale as ensureCacheSymlink.
  await removePath(binaryPath);
  await Deno.symlink(compiledPath, binaryPath);
}

async function startDaemonDetached(binaryPath: string): Promise<void> {
  // Spawn `<binary> daemon start` detached so the install command returns
  // immediately. Mirrors brain's `brain daemon start` invocation at the tail
  // of `just install`. If the daemon is already running, the kernel's startup
  // lock makes this a no-op.
  //
  // CRITICAL: call `.unref()` on the child handle. Without it the Deno
  // runtime keeps the install process alive waiting on the long-running
  // daemon, and `just install` never returns. Mirrors the unref() used by
  // detached child spawns in Node and Deno's own examples for fire-and-
  // forget background processes.
  const command = new Deno.Command(binaryPath, {
    args: ["daemon", "start"],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  });
  const child = command.spawn();
  child.unref();
  // Swallow the child status so an early exit (e.g. port-in-use) doesn't
  // raise an uncaught rejection when the install process eventually exits.
  child.status.catch(() => {});
}

async function ensurePluginInstalled(
  sourcePluginRoot: string,
  pluginDir: string,
  symlink: boolean,
): Promise<void> {
  await Deno.mkdir(dirname(pluginDir), { recursive: true });
  // Upsert: always replace whatever's at pluginDir, then put down a fresh
  // symlink (or copy). Robust to dangling symlinks from earlier installs.
  await removePath(pluginDir);

  if (symlink) {
    await Deno.symlink(sourcePluginRoot, pluginDir);
    return;
  }

  await copyDirectoryRecursive(sourcePluginRoot, pluginDir);
}

export async function installPlugin(
  opts: InstallerOptions = {},
): Promise<void> {
  const mode = opts.mode ?? "local";
  const {
    pluginDir,
    settingsPath,
    marketplaceSourcePath,
    claudeJsonPath,
    claudeMdPath,
    pluginCacheRoot,
    binaryPath,
    sourcePluginRoot,
    skipCompile,
    skipDaemonStart,
    userConfigPath,
  } = resolvePaths(opts);

  // Local mode now relies entirely on the directory-source marketplace
  // pointing at the repo root; Claude Code resolves the plugin via
  // marketplace.json's `source: "./cli/claudecode-plugin"`. A symlink at
  // ~/.claude/plugins/overmind would create a competing registration and
  // confuse the marketplace lookup, so we actively remove it instead.
  if (await pathExists(pluginDir)) {
    await removePath(pluginDir);
  }

  // Compile the unified `overmind` binary and symlink it into the user's
  // PATH. The Claude Code MCP entry below points at this symlink. When the
  // entrypoint isn't present (synthetic test roots) compileBinary returns
  // null and we leave any pre-existing binary symlink alone.
  let resolvedBinaryPath: string | null = null;
  if (!skipCompile) {
    const compiledPath = await compileBinary(marketplaceSourcePath);
    if (compiledPath) {
      await symlinkBinary(compiledPath, binaryPath);
      resolvedBinaryPath = binaryPath;
    }
  }

  const settings = await readSettings(settingsPath);
  const patched = mode === "marketplace"
    ? withMarketplacePlugin(settings)
    : withLocalPlugin(settings, marketplaceSourcePath);
  await writeSettings(settingsPath, patched);

  // Register the MCP server globally in ~/.claude.json so `/mcp` lists it.
  // Points at the compiled binary with `args: ["mcp"]`; matches the
  // brain / neural_link / context7 single-binary pattern. When compile was
  // skipped we still write the entry pointing at the configured binaryPath,
  // so an out-of-band `deno compile` + symlink will still wire up correctly.
  const claudeJson = await readSettings(claudeJsonPath);
  const claudeJsonPatched = withGlobalMcpServer(claudeJson, binaryPath);
  await writeSettings(claudeJsonPath, claudeJsonPatched);

  // Upsert the marked routing block into the global CLAUDE.md. Mirrors
  // oh-my-claudecode's `<!-- OMC:START -->` pattern — the marker pair lets us
  // replace older versions on upgrade and remove cleanly on uninstall while
  // leaving the rest of the file untouched.
  await upsertAgentBlock(claudeMdPath);

  // Local-mode-only: Claude Code's directory-source install logic records
  // the install in `installed_plugins.json` but skips populating the cache
  // dir (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`) when
  // the marketplace lives outside `~/.claude/plugins/marketplaces/`. Without
  // a populated cache dir, Claude Code finds the plugin manifest but can't
  // load skills, hooks, or agents. Symlink the cache to the live source so
  // edits are picked up immediately and skills register correctly.
  if (mode === "local") {
    const version = await readPluginVersion(sourcePluginRoot);
    const cacheDir = resolve(
      `${pluginCacheRoot}/${MARKETPLACE_NAME}/${MARKETPLACE_NAME}/${version}`,
    );
    await ensureCacheSymlink(sourcePluginRoot, cacheDir);
  }

  // Seed the user-level config from the repo template if (and only if) the
  // user doesn't have one yet. This is the bridge between the repo's
  // `config/overmind.toml` (template, version-controlled) and the daemon's
  // ConfigLoader, which reads `~/.config/overmind/overmind.toml`. Existing
  // user configs are preserved on reinstall; the operator stays in charge
  // of their settings.
  await seedUserConfig(
    `${marketplaceSourcePath}/config/overmind.toml`,
    userConfigPath,
  );

  // Boot the daemon so the kernel HTTP listener is up before the next MCP
  // tool call. The daemon's startup lock makes this a no-op when one is
  // already running.
  if (resolvedBinaryPath && !skipDaemonStart) {
    await startDaemonDetached(resolvedBinaryPath);
  }
}

async function readPluginVersion(sourcePluginRoot: string): Promise<string> {
  try {
    const manifestPath = `${sourcePluginRoot}/.claude-plugin/plugin.json`;
    const raw = await Deno.readTextFile(manifestPath);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.version === "string") return parsed.version;
  } catch {
    // Fall through to default
  }
  return "0.1.0";
}

/**
 * Copy `config/overmind.toml` from the repo root to the user-level config
 * path on first install. Idempotent: if the destination already exists
 * (operator has customized it), this is a no-op so user edits are
 * preserved across reinstalls. Without this seed step, the daemon's
 * ConfigLoader silently falls through to its hardcoded defaults — the
 * `[dispatcher]` section in the repo template is documentation only
 * because none of the loader's three search paths point at the repo.
 */
async function seedUserConfig(
  templatePath: string,
  userConfigPath: string,
): Promise<void> {
  if (await pathExists(userConfigPath)) return;
  if (!(await pathExists(templatePath))) return;
  await Deno.mkdir(dirname(userConfigPath), { recursive: true });
  await Deno.copyFile(templatePath, userConfigPath);
}

async function ensureCacheSymlink(
  sourcePluginRoot: string,
  cacheDir: string,
): Promise<void> {
  await Deno.mkdir(dirname(cacheDir), { recursive: true });
  // Upsert: always replace whatever's at cacheDir (live symlink, dangling
  // symlink, regular dir from a copy install, etc.) with a fresh symlink to
  // the live source. Cheaper than introspecting current state and robust to
  // dangling links left behind by test runs or earlier installer versions.
  await removePath(cacheDir);
  await Deno.symlink(sourcePluginRoot, cacheDir);
}

export async function uninstallPlugin(
  opts: InstallerOptions = {},
): Promise<void> {
  const {
    pluginDir,
    settingsPath,
    claudeJsonPath,
    claudeMdPath,
    pluginCacheRoot,
    binaryPath,
    marketplaceSourcePath,
    userConfigPath,
    overmindRuntimeDir,
  } = resolvePaths(opts);

  // Stop the daemon BEFORE touching any install files. The daemon owns
  // the advisory lock on <runtimeDir>/daemon.lock, listens on the unix
  // socket, and tracks its own pid in daemon.pid; sending SIGTERM lets
  // it close the lock FD (releasing the OS lock) and remove the socket
  // and pidfile cleanly. stopDaemon is idempotent — when no daemon is
  // running it returns "Daemon is not running" without erroring.
  try {
    await stopDaemon(overmindRuntimeDir);
  } catch (err) {
    console.warn(
      `uninstall: failed to stop daemon (continuing): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  await removePath(pluginDir);
  await removeAgentBlock(claudeMdPath);

  // Remove the PATH symlink and the compiled binary itself. Earlier
  // behavior preserved the dist artifact ("cheap to recreate"); the
  // operator preference is full removal — install/uninstall is now
  // symmetric, and a reinstall must re-compile.
  if (await pathExists(binaryPath)) {
    const stat = await Deno.lstat(binaryPath);
    if (stat.isSymlink) {
      await removePath(binaryPath);
    }
  }
  const compiledBinaryPath = resolve(
    `${marketplaceSourcePath}/${COMPILED_OUTPUT_REL}`,
  );
  if (await pathExists(compiledBinaryPath)) {
    await removePath(compiledBinaryPath);
  }

  // Clean up daemon runtime files. stopDaemon should have removed the
  // pidfile already, and a clean daemon shutdown removes its socket; but
  // the lockfile persists by design (we only release the OS-level lock
  // by closing the FD, not by unlinking the file), and pid/sock can
  // linger if the daemon was SIGKILLed earlier. Be defensive — these
  // are install-orphaned, not user data, and removePath is idempotent.
  // The `state/` subdirectory is intentionally NOT touched: per-workspace
  // run history (capabilities, journals, mode-state files) lives there
  // and belongs to the user, not to install state.
  for (const f of ["daemon.lock", "daemon.pid", "daemon.sock"]) {
    await removePath(`${overmindRuntimeDir}/${f}`);
  }

  // Flatten the whole marketplace cache tree under pluginCacheRoot.
  const cacheRoot = resolve(`${pluginCacheRoot}/${MARKETPLACE_NAME}`);
  if (await pathExists(cacheRoot)) {
    await removePath(cacheRoot);
  }

  if (await pathExists(claudeJsonPath)) {
    const claudeJson = await readSettings(claudeJsonPath);
    await writeSettings(claudeJsonPath, withoutGlobalMcpServer(claudeJson));
  }

  if (await pathExists(settingsPath)) {
    const settings = await readSettings(settingsPath);
    const patched = withoutAllOvemindPlugins(settings);
    await writeSettings(settingsPath, patched);
  }

  // Surface the preserved-state note so uninstall isn't surprising —
  // user config is intentionally retained across uninstall/reinstall
  // cycles so operator customizations survive a reset.
  if (await pathExists(userConfigPath)) {
    console.log(
      `uninstall: user config preserved at ${userConfigPath} (delete manually for full reset).`,
    );
  }
}

function parseBoolean(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseCliArgs(
  args: string[],
): { command: "install" | "uninstall"; options: InstallerOptions } {
  const [command, ...rest] = args;
  if (command !== "install" && command !== "uninstall") {
    throw new Error(
      "Usage: installer.ts <install|uninstall> [--mode local|marketplace] [--plugin-dir <path>] [--settings-path <path>] [--source-plugin-root <path>] [--symlink <true|false>]",
    );
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

    if (arg === "--claude-md-path") {
      if (!value) throw new Error("Missing value for --claude-md-path");
      options.claudeMdPath = value;
      i++;
      continue;
    }

    if (arg === "--bin-dir") {
      if (!value) throw new Error("Missing value for --bin-dir");
      options.binDir = value;
      i++;
      continue;
    }

    if (arg === "--binary-path") {
      if (!value) throw new Error("Missing value for --binary-path");
      options.binaryPath = value;
      i++;
      continue;
    }

    if (arg === "--skip-compile") {
      options.skipCompile = true;
      continue;
    }

    if (arg === "--skip-daemon-start") {
      options.skipDaemonStart = true;
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

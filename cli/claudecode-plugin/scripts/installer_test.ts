import { assertEquals, assertRejects } from "@std/assert";
import { dirname } from "@std/path";

import {
  installPlugin,
  type InstallerOptions,
  uninstallPlugin,
  withOvermindAgentBlock,
  withoutOvermindAgentBlock,
} from "./installer.ts";

async function writeJson(path: string, value: unknown): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(path));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

// List every timestamped backup that exists for a given CLAUDE.md path.
// Backups land at `<path>.<ISO-stamp>.bak`, so we read the parent dir and
// match anything that starts with `<basename>.` and ends with `.bak`.
async function listBackups(claudeMdPath: string): Promise<string[]> {
  const dir = dirname(claudeMdPath);
  const base = claudeMdPath.slice(dir.length + 1);
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.startsWith(`${base}.`) && entry.name.endsWith(".bak")) {
        out.push(`${dir}/${entry.name}`);
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  out.sort();
  return out;
}

async function lstatSafe(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch {
    return null;
  }
}

async function createSourcePluginRoot(root: string): Promise<void> {
  await Deno.mkdir(`${root}/hooks`, { recursive: true });
  await Deno.mkdir(`${root}/skills`, { recursive: true });
  await Deno.mkdir(`${root}/.claude-plugin`, { recursive: true });

  await Deno.writeTextFile(`${root}/hooks/hooks.json`, "{}\n");
  await Deno.writeTextFile(`${root}/skills/example.md`, "# skill\n");

  await writeJson(`${root}/.claude-plugin/plugin.json`, {
    name: "overmind",
    version: "0.1.0",
    skills: "./skills/",
  });
}

/**
 * Test fixture — every path the installer can touch is rooted at a tmpdir so
 * nothing leaks into the user's real ~/.claude/, ~/.local/bin/, or repo dist/.
 *
 * Pass any subset of overrides; the rest get safe tmpdir defaults.
 */
interface TestEnv {
  root: string;
  sourceRoot: string;
  pluginDir: string;
  settingsPath: string;
  claudeJsonPath: string;
  claudeMdPath: string;
  pluginCacheRoot: string;
  binaryPath: string;
  binDir: string;
  cleanup: () => Promise<void>;
}

async function createTestEnv(): Promise<TestEnv> {
  const root = await Deno.makeTempDir();
  const sourceRoot = `${root}/source-plugin`;
  await createSourcePluginRoot(sourceRoot);

  return {
    root,
    sourceRoot,
    pluginDir: `${root}/.claude/plugins/overmind`,
    settingsPath: `${root}/.claude/settings.json`,
    claudeJsonPath: `${root}/.claude.json`,
    claudeMdPath: `${root}/.claude/CLAUDE.md`,
    pluginCacheRoot: `${root}/.claude/plugins/cache`,
    binaryPath: `${root}/.local/bin/overmind`,
    binDir: `${root}/.local/bin`,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

/**
 * Build an `installPlugin` options object that is fully isolated to the test
 * env (no real-filesystem writes outside `env.root`).
 */
function isolated(env: TestEnv, extra: Partial<InstallerOptions> = {}): InstallerOptions {
  return {
    sourcePluginRoot: env.sourceRoot,
    pluginDir: env.pluginDir,
    settingsPath: env.settingsPath,
    claudeJsonPath: env.claudeJsonPath,
    claudeMdPath: env.claudeMdPath,
    pluginCacheRoot: env.pluginCacheRoot,
    binaryPath: env.binaryPath,
    binDir: env.binDir,
    marketplaceSourcePath: env.root,
    skipCompile: true,
    skipDaemonStart: true,
    ...extra,
  };
}

Deno.test("installPlugin creates plugin symlink and enables overmind plugin", async () => {
  const env = await createTestEnv();
  try {
    await writeJson(env.settingsPath, { allowedTools: ["bash"] });
    await installPlugin(isolated(env));

    // Local mode now removes pluginDir intentionally (directory-source
    // marketplace handles the lookup); the live source survives.
    assertEquals(await pathExists(env.pluginDir), false);
    assertEquals(await pathExists(env.sourceRoot), true);

    const settings = await readJson(env.settingsPath);
    const enabledPlugins = settings.enabledPlugins as Record<string, unknown>;
    assertEquals(enabledPlugins["overmind@overmind"], true);
    assertEquals(settings.allowedTools, ["bash"]);
  } finally {
    await env.cleanup();
  }
});

Deno.test("installPlugin is idempotent when run multiple times", async () => {
  const env = await createTestEnv();
  try {
    await writeJson(env.settingsPath, { enabledPlugins: { "another@plugin": true } });
    await installPlugin(isolated(env));
    await installPlugin(isolated(env));

    const settings = await readJson(env.settingsPath);
    const enabledPlugins = settings.enabledPlugins as Record<string, unknown>;
    assertEquals(enabledPlugins["overmind@overmind"], true);
    assertEquals(enabledPlugins["another@plugin"], true);
    assertEquals(Object.keys(enabledPlugins).sort(), ["another@plugin", "overmind@overmind"]);
  } finally {
    await env.cleanup();
  }
});

Deno.test("installPlugin creates a minimal valid settings.json when missing", async () => {
  const env = await createTestEnv();
  try {
    await installPlugin(isolated(env));

    const settings = await readJson(env.settingsPath);
    assertEquals(typeof settings, "object");
    assertEquals(
      (settings.enabledPlugins as Record<string, unknown>)["overmind@overmind"],
      true,
    );
  } finally {
    await env.cleanup();
  }
});

Deno.test("installPlugin throws a clear error for invalid settings JSON", async () => {
  const env = await createTestEnv();
  try {
    await Deno.mkdir(dirname(env.settingsPath), { recursive: true });
    await Deno.writeTextFile(env.settingsPath, "{ invalid json");

    await assertRejects(
      async () => {
        await installPlugin(isolated(env));
      },
      Error,
      "Invalid JSON in settings file",
    );
  } finally {
    await env.cleanup();
  }
});

Deno.test("installPlugin registers MCP server in claude.json pointing at the binary", async () => {
  const env = await createTestEnv();
  try {
    await installPlugin(isolated(env));

    const claudeJson = await readJson(env.claudeJsonPath);
    const mcpServers = claudeJson.mcpServers as Record<string, Record<string, unknown>>;
    const overmind = mcpServers.overmind;
    assertEquals(overmind.type, "stdio");
    assertEquals(overmind.command, env.binaryPath);
    assertEquals(overmind.args, ["mcp"]);
  } finally {
    await env.cleanup();
  }
});

Deno.test("installPlugin creates the plugin cache symlink under pluginCacheRoot", async () => {
  const env = await createTestEnv();
  try {
    await installPlugin(isolated(env));

    const cacheLink = `${env.pluginCacheRoot}/overmind/overmind/0.1.0`;
    const stat = await lstatSafe(cacheLink);
    assertEquals(stat?.isSymlink, true);
    const target = await Deno.readLink(cacheLink);
    assertEquals(target, env.sourceRoot);
  } finally {
    await env.cleanup();
  }
});

Deno.test("uninstallPlugin removes plugin path, cache tree, MCP entry, and settings entry", async () => {
  const env = await createTestEnv();
  try {
    await writeJson(env.settingsPath, { enabledPlugins: { "other@local": true } });

    await installPlugin(isolated(env));
    await uninstallPlugin(isolated(env));

    assertEquals(await pathExists(env.pluginDir), false);
    assertEquals(await pathExists(`${env.pluginCacheRoot}/overmind`), false);

    const claudeJson = await readJson(env.claudeJsonPath);
    const mcpServers = claudeJson.mcpServers as Record<string, unknown>;
    assertEquals(mcpServers?.overmind, undefined);

    const settings = await readJson(env.settingsPath);
    const enabledPlugins = settings.enabledPlugins as Record<string, unknown>;
    assertEquals(enabledPlugins["overmind@overmind"], undefined);
    assertEquals(enabledPlugins["other@local"], true);
  } finally {
    await env.cleanup();
  }
});

Deno.test("uninstallPlugin succeeds when nothing is installed", async () => {
  const env = await createTestEnv();
  try {
    await uninstallPlugin(isolated(env));
    assertEquals(await pathExists(env.pluginDir), false);
    assertEquals(await pathExists(env.settingsPath), false);
  } finally {
    await env.cleanup();
  }
});

Deno.test("installPlugin marketplace mode writes marketplace settings without creating plugin dir", async () => {
  const env = await createTestEnv();
  try {
    await writeJson(env.settingsPath, { allowedTools: ["bash"] });
    await installPlugin(isolated(env, { mode: "marketplace" }));

    assertEquals(await pathExists(env.pluginDir), false);

    const settings = await readJson(env.settingsPath);
    const enabledPlugins = settings.enabledPlugins as Record<string, unknown>;
    assertEquals(enabledPlugins["overmind@overmind"], true);
    assertEquals(settings.allowedTools, ["bash"]);

    const marketplaces = settings.extraKnownMarketplaces as Record<string, unknown>;
    const overmindSource = marketplaces["overmind"] as Record<string, unknown>;
    const source = overmindSource.source as Record<string, unknown>;
    assertEquals(source.source, "github");
    assertEquals(source.repo, "benediktms/overmind");
  } finally {
    await env.cleanup();
  }
});

Deno.test("installPlugin marketplace mode is idempotent", async () => {
  const env = await createTestEnv();
  try {
    await writeJson(env.settingsPath, {});
    await installPlugin(isolated(env, { mode: "marketplace" }));
    await installPlugin(isolated(env, { mode: "marketplace" }));

    const settings = await readJson(env.settingsPath);
    const enabledPlugins = settings.enabledPlugins as Record<string, unknown>;
    assertEquals(Object.keys(enabledPlugins).filter((k) => k.startsWith("overmind")).length, 1);
  } finally {
    await env.cleanup();
  }
});

Deno.test("installPlugin marketplace mode does not leave a directory-source marketplace registered", async () => {
  const env = await createTestEnv();
  try {
    await writeJson(env.settingsPath, {});
    await installPlugin(isolated(env, { mode: "local" }));
    await installPlugin(isolated(env, { mode: "marketplace" }));

    const settings = await readJson(env.settingsPath);
    const marketplaces = settings.extraKnownMarketplaces as Record<string, unknown>;
    const overmindEntry = marketplaces["overmind"] as Record<string, unknown>;
    const source = overmindEntry.source as Record<string, unknown>;
    assertEquals(source.source, "github");
  } finally {
    await env.cleanup();
  }
});

// ── Upsert symlink behavior ─────────────────────────────────────────────────
// All filesystem-mutating helpers (cache symlink, plugin dir, binary) treat
// the target path as a slot to overwrite. These tests exercise the dangling-
// symlink case that prompted the upsert refactor, plus regular pre-existing
// targets.

Deno.test("installPlugin replaces a dangling cache symlink (upsert)", async () => {
  const env = await createTestEnv();
  try {
    // Pre-seed a dangling symlink at the cache slot — the kind left over by
    // earlier installer versions or test runs that pointed into a tmpdir
    // that has since been removed.
    const cacheLink = `${env.pluginCacheRoot}/overmind/overmind/0.1.0`;
    await Deno.mkdir(dirname(cacheLink), { recursive: true });
    await Deno.symlink("/nonexistent/dangling/target", cacheLink);

    // Confirm a dangling symlink is present (lstat sees the link even when
    // its target is gone). Pre-upsert installer would NotFound on this.
    assertEquals((await lstatSafe(cacheLink))?.isSymlink, true);

    await installPlugin(isolated(env));

    const target = await Deno.readLink(cacheLink);
    assertEquals(target, env.sourceRoot);
  } finally {
    await env.cleanup();
  }
});

Deno.test("installPlugin replaces a non-symlink directory at the cache slot (upsert)", async () => {
  const env = await createTestEnv();
  try {
    const cacheLink = `${env.pluginCacheRoot}/overmind/overmind/0.1.0`;
    await Deno.mkdir(cacheLink, { recursive: true });
    await Deno.writeTextFile(`${cacheLink}/leftover.txt`, "stale\n");

    await installPlugin(isolated(env));

    const stat = await lstatSafe(cacheLink);
    assertEquals(stat?.isSymlink, true);
    const target = await Deno.readLink(cacheLink);
    assertEquals(target, env.sourceRoot);
  } finally {
    await env.cleanup();
  }
});

// ── Agent-block (CLAUDE.md routing instructions) upsert ────────────────────
// The installer maintains a marked block in the global CLAUDE.md that tells
// Claude Code when to delegate via overmind_delegate. Re-running install must
// be a no-op on the file (idempotent). Stale or duplicate blocks must collapse
// to a single canonical one. User content outside the markers must survive
// install + uninstall round-trips unchanged.

const AGENT_START = "<!-- overmind:start -->";
const AGENT_END = "<!-- overmind:end -->";

Deno.test("withOvermindAgentBlock writes block into empty file", () => {
  const result = withOvermindAgentBlock("");
  assertEquals(result.startsWith(AGENT_START), true);
  assertEquals(result.trimEnd().endsWith(AGENT_END), true);
});

Deno.test("withOvermindAgentBlock is idempotent on repeated application", () => {
  const once = withOvermindAgentBlock("");
  const twice = withOvermindAgentBlock(once);
  const thrice = withOvermindAgentBlock(twice);
  assertEquals(once, twice);
  assertEquals(twice, thrice);
});

Deno.test("withOvermindAgentBlock preserves user content above and below", () => {
  const seed = "# User notes\n\nMy custom instructions.\n";
  const result = withOvermindAgentBlock(seed);
  assertEquals(result.startsWith(seed), true);
  assertEquals(result.includes(AGENT_START), true);
  // Re-applying must not duplicate either the user content or the block.
  const second = withOvermindAgentBlock(result);
  assertEquals(second, result);
  assertEquals((second.match(/overmind:start/g) ?? []).length, 1);
});

Deno.test("withOvermindAgentBlock replaces stale version block (upgrade)", () => {
  const stale = `${AGENT_START}\n<!-- overmind:version:0.0.1 -->\n# stale body\n${AGENT_END}\n`;
  const result = withOvermindAgentBlock(stale);
  assertEquals(result.includes("# stale body"), false);
  assertEquals(result.includes(AGENT_START), true);
  assertEquals((result.match(/overmind:start/g) ?? []).length, 1);
});

Deno.test("withOvermindAgentBlock collapses duplicate blocks into one", () => {
  const corrupted = `${AGENT_START}\nfirst\n${AGENT_END}\n\n# user content\n\n${AGENT_START}\nsecond\n${AGENT_END}\n`;
  const result = withOvermindAgentBlock(corrupted);
  assertEquals((result.match(/overmind:start/g) ?? []).length, 1);
  assertEquals(result.includes("first"), false);
  assertEquals(result.includes("second"), false);
  assertEquals(result.includes("# user content"), true);
});

Deno.test("withOvermindAgentBlock repairs unterminated block (start without end)", () => {
  const broken = "# header\n\n" + AGENT_START + "\nhalf-written body — process killed mid-write\n";
  const result = withOvermindAgentBlock(broken);
  assertEquals(result.includes("half-written"), false);
  assertEquals(result.includes("# header"), true);
  assertEquals((result.match(/overmind:start/g) ?? []).length, 1);
  assertEquals((result.match(/overmind:end/g) ?? []).length, 1);
});

Deno.test("withoutOvermindAgentBlock removes the block, leaving user content", () => {
  const seed = "# User notes\n\nstuff\n";
  const installed = withOvermindAgentBlock(seed);
  const removed = withoutOvermindAgentBlock(installed);
  assertEquals(removed, seed);
});

Deno.test("withoutOvermindAgentBlock is a no-op when no block is present", () => {
  const seed = "# Just user content\n";
  assertEquals(withoutOvermindAgentBlock(seed), seed);
});

Deno.test("withoutOvermindAgentBlock removes every duplicate block", () => {
  const corrupted = `${AGENT_START}\na\n${AGENT_END}\n\nuser\n\n${AGENT_START}\nb\n${AGENT_END}\n`;
  const result = withoutOvermindAgentBlock(corrupted);
  assertEquals(result.includes(AGENT_START), false);
  assertEquals(result.includes("user"), true);
});

Deno.test("installPlugin upserts the agent block into CLAUDE.md", async () => {
  const env = await createTestEnv();
  try {
    await installPlugin(isolated(env));

    const md = await Deno.readTextFile(env.claudeMdPath);
    assertEquals(md.includes(AGENT_START), true);
    assertEquals(md.includes(AGENT_END), true);
    assertEquals(md.includes("overmind:version"), true);
  } finally {
    await env.cleanup();
  }
});

Deno.test("installPlugin is idempotent for the agent block (file unchanged on re-run)", async () => {
  const env = await createTestEnv();
  try {
    await installPlugin(isolated(env));
    const first = await Deno.readTextFile(env.claudeMdPath);
    await installPlugin(isolated(env));
    const second = await Deno.readTextFile(env.claudeMdPath);
    assertEquals(first, second);
    assertEquals((second.match(/overmind:start/g) ?? []).length, 1);
  } finally {
    await env.cleanup();
  }
});

Deno.test("installPlugin preserves arbitrary user content outside the overmind block", async () => {
  const env = await createTestEnv();
  try {
    // Seed CLAUDE.md with content that has nothing to do with overmind:
    // a personal heading, freeform prose, an unrelated marked block from
    // another tool, and a fenced code block. None of this should be
    // disturbed by the install.
    const seed = `# My personal Claude config

Some freeform notes that are important to me.

<!-- some-other-tool:start -->
Other tool's config
<!-- some-other-tool:end -->

\`\`\`
ALWAYS prefix commits with [WIP]
\`\`\`
`;
    await Deno.mkdir(dirname(env.claudeMdPath), { recursive: true });
    await Deno.writeTextFile(env.claudeMdPath, seed);

    await installPlugin(isolated(env));

    const md = await Deno.readTextFile(env.claudeMdPath);
    assertEquals(md.includes("# My personal Claude config"), true);
    assertEquals(md.includes("Some freeform notes that are important to me."), true);
    assertEquals(md.includes("<!-- some-other-tool:start -->"), true);
    assertEquals(md.includes("Other tool's config"), true);
    assertEquals(md.includes("ALWAYS prefix commits with [WIP]"), true);
    assertEquals(md.includes(AGENT_START), true);
  } finally {
    await env.cleanup();
  }
});

Deno.test("uninstallPlugin strips the block but leaves arbitrary user content intact", async () => {
  const env = await createTestEnv();
  try {
    const seed = `# Personal notes

My freeform CLAUDE.md content.

<!-- third-party-tool:start -->
unrelated config
<!-- third-party-tool:end -->
`;
    await Deno.mkdir(dirname(env.claudeMdPath), { recursive: true });
    await Deno.writeTextFile(env.claudeMdPath, seed);

    await installPlugin(isolated(env));
    await uninstallPlugin(isolated(env));

    const md = await Deno.readTextFile(env.claudeMdPath);
    assertEquals(md.includes(AGENT_START), false);
    assertEquals(md.includes("# Personal notes"), true);
    assertEquals(md.includes("My freeform CLAUDE.md content."), true);
    assertEquals(md.includes("<!-- third-party-tool:start -->"), true);
    assertEquals(md.includes("unrelated config"), true);
  } finally {
    await env.cleanup();
  }
});

Deno.test("installPlugin backs up an existing CLAUDE.md to a timestamped .bak before modifying", async () => {
  const env = await createTestEnv();
  try {
    const seed = "# Existing user content\n\nimportant notes\n";
    await Deno.mkdir(dirname(env.claudeMdPath), { recursive: true });
    await Deno.writeTextFile(env.claudeMdPath, seed);

    await installPlugin(isolated(env));

    const backups = await listBackups(env.claudeMdPath);
    assertEquals(backups.length, 1);
    const backup = await Deno.readTextFile(backups[0]);
    assertEquals(backup, seed);

    const md = await Deno.readTextFile(env.claudeMdPath);
    assertEquals(md.includes("# Existing user content"), true);
    assertEquals(md.includes(AGENT_START), true);
  } finally {
    await env.cleanup();
  }
});

Deno.test("installPlugin does not create a backup when no CLAUDE.md exists", async () => {
  const env = await createTestEnv();
  try {
    await installPlugin(isolated(env));
    assertEquals((await listBackups(env.claudeMdPath)).length, 0);
    assertEquals(await pathExists(env.claudeMdPath), true);
  } finally {
    await env.cleanup();
  }
});

Deno.test("installPlugin produces a distinct backup for each real mutation, never overwriting earlier ones", async () => {
  const env = await createTestEnv();
  try {
    const original = "# Pristine\n\nfirst-ever content\n";
    await Deno.mkdir(dirname(env.claudeMdPath), { recursive: true });
    await Deno.writeTextFile(env.claudeMdPath, original);

    // First install mutates the file (appends the block) → one backup.
    await installPlugin(isolated(env));

    // User edits CLAUDE.md outside the overmind block, then a second
    // install runs. The block stays the same but the file has new user
    // content, so the next install path must capture *that* state too —
    // and crucially, it must not clobber the first (pristine) backup.
    const intermediate = await Deno.readTextFile(env.claudeMdPath);
    const edited = intermediate + "\n# user-added section\n\nnew notes\n";
    await Deno.writeTextFile(env.claudeMdPath, edited);

    // Force a non-trivial timestamp gap so the two .bak filenames differ
    // (timestamps are millisecond-resolution UTC ISO strings).
    await new Promise((r) => setTimeout(r, 5));
    await installPlugin(isolated(env));

    const backups = await listBackups(env.claudeMdPath);
    assertEquals(backups.length, 2);

    // Sorted lexicographically; ISO timestamps sort chronologically, so
    // [0] is the oldest = pristine pre-install state.
    assertEquals(await Deno.readTextFile(backups[0]), original);
    assertEquals(await Deno.readTextFile(backups[1]), edited);
  } finally {
    await env.cleanup();
  }
});

Deno.test("installPlugin skips backup when re-running would not change the file", async () => {
  const env = await createTestEnv();
  try {
    await installPlugin(isolated(env));
    // First install created CLAUDE.md but no .bak (file didn't exist before).
    assertEquals((await listBackups(env.claudeMdPath)).length, 0);
    await installPlugin(isolated(env));
    // Second install: file existed but the upsert is a no-op (idempotent
    // content). We should NOT create a backup of the already-installed file.
    assertEquals((await listBackups(env.claudeMdPath)).length, 0);
  } finally {
    await env.cleanup();
  }
});

Deno.test("uninstallPlugin backs up CLAUDE.md before stripping the block", async () => {
  const env = await createTestEnv();
  try {
    const seed = "# Personal notes\n\nimportant\n";
    await Deno.mkdir(dirname(env.claudeMdPath), { recursive: true });
    await Deno.writeTextFile(env.claudeMdPath, seed);

    // Install creates one backup (of `seed`).
    await installPlugin(isolated(env));
    const installedState = await Deno.readTextFile(env.claudeMdPath);
    await new Promise((r) => setTimeout(r, 5));

    // Uninstall mutates CLAUDE.md too, so it must capture the pre-strip
    // state in its own timestamped backup — otherwise an install/uninstall
    // cycle silently loses anything the user added between the two ops.
    await uninstallPlugin(isolated(env));

    const backups = await listBackups(env.claudeMdPath);
    assertEquals(backups.length, 2);
    assertEquals(await Deno.readTextFile(backups[0]), seed);
    assertEquals(await Deno.readTextFile(backups[1]), installedState);
  } finally {
    await env.cleanup();
  }
});

Deno.test("uninstallPlugin skips backup when CLAUDE.md has no overmind block", async () => {
  const env = await createTestEnv();
  try {
    const seed = "# Just user content, no overmind block\n";
    await Deno.mkdir(dirname(env.claudeMdPath), { recursive: true });
    await Deno.writeTextFile(env.claudeMdPath, seed);

    await uninstallPlugin(isolated(env));

    assertEquals((await listBackups(env.claudeMdPath)).length, 0);
    assertEquals(await Deno.readTextFile(env.claudeMdPath), seed);
  } finally {
    await env.cleanup();
  }
});

Deno.test("install + uninstall round-trip yields byte-identical user content", async () => {
  const env = await createTestEnv();
  try {
    const seed = "# header\n\nbody line 1\nbody line 2\n\n## subsection\n\nmore content\n";
    await Deno.mkdir(dirname(env.claudeMdPath), { recursive: true });
    await Deno.writeTextFile(env.claudeMdPath, seed);

    await installPlugin(isolated(env));
    await uninstallPlugin(isolated(env));

    const md = await Deno.readTextFile(env.claudeMdPath);
    assertEquals(md, seed);
  } finally {
    await env.cleanup();
  }
});

Deno.test("uninstallPlugin removes CLAUDE.md when only the overmind block was present", async () => {
  const env = await createTestEnv();
  try {
    await installPlugin(isolated(env));
    assertEquals(await pathExists(env.claudeMdPath), true);

    await uninstallPlugin(isolated(env));
    assertEquals(await pathExists(env.claudeMdPath), false);
  } finally {
    await env.cleanup();
  }
});

Deno.test("installPlugin replaces a stale plugin-dir symlink in copy mode (upsert)", async () => {
  const env = await createTestEnv();
  try {
    await Deno.mkdir(dirname(env.pluginDir), { recursive: true });
    await Deno.symlink("/nonexistent/dangling", env.pluginDir);
    assertEquals((await lstatSafe(env.pluginDir))?.isSymlink, true);

    await installPlugin(isolated(env, { symlink: false }));

    // Local mode actively removes the plugin dir (directory-source
    // marketplace handles the lookup). The point of the test is that the
    // dangling pre-existing symlink doesn't trip the install — it should
    // be cleaned up without errors.
    assertEquals(await lstatSafe(env.pluginDir), null);
  } finally {
    await env.cleanup();
  }
});

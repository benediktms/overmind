import { assertEquals, assertRejects } from "@std/assert";
import { dirname } from "node:path";

import { installPlugin, uninstallPlugin } from "./installer.ts";

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

async function createSourcePluginRoot(root: string): Promise<void> {
  await Deno.mkdir(`${root}/hooks`, { recursive: true });
  await Deno.mkdir(`${root}/skills`, { recursive: true });
  await Deno.mkdir(`${root}/bridge`, { recursive: true });
  await Deno.mkdir(`${root}/.claude-plugin`, { recursive: true });

  await Deno.writeTextFile(`${root}/hooks/hooks.json`, "{}\n");
  await Deno.writeTextFile(`${root}/skills/example.md`, "# skill\n");
  await Deno.writeTextFile(`${root}/bridge/mcp-bridge.cjs`, "module.exports = {};\n");

  await writeJson(`${root}/.claude-plugin/plugin.json`, {
    name: "overmind",
    version: "0.1.0",
    skills: "./skills/",
    mcpServers: "./mcp-bridge.json",
  });
}

Deno.test("installPlugin creates plugin symlink and enables overmind plugin", async () => {
  const root = await Deno.makeTempDir();
  const sourceRoot = `${root}/source-plugin`;
  const pluginDir = `${root}/.claude/plugins/overmind`;
  const settingsPath = `${root}/.claude/settings.json`;

  try {
    await createSourcePluginRoot(sourceRoot);
    await writeJson(settingsPath, { allowedTools: ["bash"] });

    await installPlugin({ sourcePluginRoot: sourceRoot, pluginDir, settingsPath });

    const stat = await Deno.lstat(pluginDir);
    assertEquals(stat.isSymlink, true);

    const settings = await readJson(settingsPath);
    assertEquals(
      (settings.enabledPlugins as Record<string, unknown>)["overmind@local"],
      true,
    );
    assertEquals(settings.allowedTools, ["bash"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("installPlugin is idempotent when run multiple times", async () => {
  const root = await Deno.makeTempDir();
  const sourceRoot = `${root}/source-plugin`;
  const pluginDir = `${root}/.claude/plugins/overmind`;
  const settingsPath = `${root}/.claude/settings.json`;

  try {
    await createSourcePluginRoot(sourceRoot);
    await writeJson(settingsPath, { enabledPlugins: { "another@plugin": true } });

    await installPlugin({ sourcePluginRoot: sourceRoot, pluginDir, settingsPath });
    await installPlugin({ sourcePluginRoot: sourceRoot, pluginDir, settingsPath });

    const settings = await readJson(settingsPath);
    const enabledPlugins = settings.enabledPlugins as Record<string, unknown>;
    assertEquals(enabledPlugins["overmind@local"], true);
    assertEquals(enabledPlugins["another@plugin"], true);
    assertEquals(Object.keys(enabledPlugins).sort(), ["another@plugin", "overmind@local"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("installPlugin creates a minimal valid settings.json when missing", async () => {
  const root = await Deno.makeTempDir();
  const sourceRoot = `${root}/source-plugin`;
  const pluginDir = `${root}/.claude/plugins/overmind`;
  const settingsPath = `${root}/.claude/settings.json`;

  try {
    await createSourcePluginRoot(sourceRoot);
    await installPlugin({ sourcePluginRoot: sourceRoot, pluginDir, settingsPath });

    const settings = await readJson(settingsPath);
    assertEquals(typeof settings, "object");
    assertEquals(
      (settings.enabledPlugins as Record<string, unknown>)["overmind@local"],
      true,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("installPlugin throws a clear error for invalid settings JSON", async () => {
  const root = await Deno.makeTempDir();
  const sourceRoot = `${root}/source-plugin`;
  const pluginDir = `${root}/.claude/plugins/overmind`;
  const settingsPath = `${root}/.claude/settings.json`;

  try {
    await createSourcePluginRoot(sourceRoot);
    await Deno.mkdir(`${root}/.claude`, { recursive: true });
    await Deno.writeTextFile(settingsPath, "{ invalid json");

    await assertRejects(
      async () => {
        await installPlugin({ sourcePluginRoot: sourceRoot, pluginDir, settingsPath });
      },
      Error,
      "Invalid JSON in settings file",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("installPlugin can copy plugin files when symlink is false", async () => {
  const root = await Deno.makeTempDir();
  const sourceRoot = `${root}/source-plugin`;
  const pluginDir = `${root}/.claude/plugins/overmind`;
  const settingsPath = `${root}/.claude/settings.json`;

  try {
    await createSourcePluginRoot(sourceRoot);
    await installPlugin({ sourcePluginRoot: sourceRoot, pluginDir, settingsPath, symlink: false });

    const stat = await Deno.lstat(pluginDir);
    assertEquals(stat.isDirectory, true);
    assertEquals(stat.isSymlink, false);
    assertEquals(await pathExists(`${pluginDir}/hooks/hooks.json`), true);
    assertEquals(await pathExists(`${pluginDir}/skills/example.md`), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("uninstallPlugin removes plugin path and overmind settings entry", async () => {
  const root = await Deno.makeTempDir();
  const sourceRoot = `${root}/source-plugin`;
  const pluginDir = `${root}/.claude/plugins/overmind`;
  const settingsPath = `${root}/.claude/settings.json`;

  try {
    await createSourcePluginRoot(sourceRoot);
    await writeJson(settingsPath, { enabledPlugins: { "other@local": true } });

    await installPlugin({ sourcePluginRoot: sourceRoot, pluginDir, settingsPath });
    await uninstallPlugin({ pluginDir, settingsPath });

    assertEquals(await pathExists(pluginDir), false);
    const settings = await readJson(settingsPath);
    const enabledPlugins = settings.enabledPlugins as Record<string, unknown>;
    assertEquals(enabledPlugins["overmind@local"], undefined);
    assertEquals(enabledPlugins["other@local"], true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("uninstallPlugin succeeds when plugin dir and settings are already absent", async () => {
  const root = await Deno.makeTempDir();
  const pluginDir = `${root}/.claude/plugins/overmind`;
  const settingsPath = `${root}/.claude/settings.json`;

  try {
    await uninstallPlugin({ pluginDir, settingsPath });
    assertEquals(await pathExists(pluginDir), false);
    assertEquals(await pathExists(settingsPath), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("installPlugin marketplace mode writes marketplace settings without creating plugin dir", async () => {
  const root = await Deno.makeTempDir();
  const sourceRoot = `${root}/source-plugin`;
  const pluginDir = `${root}/.claude/plugins/overmind`;
  const settingsPath = `${root}/.claude/settings.json`;

  try {
    await createSourcePluginRoot(sourceRoot);
    await writeJson(settingsPath, { allowedTools: ["bash"] });

    await installPlugin({ mode: "marketplace", sourcePluginRoot: sourceRoot, pluginDir, settingsPath });

    assertEquals(await pathExists(pluginDir), false);

    const settings = await readJson(settingsPath);
    const enabledPlugins = settings.enabledPlugins as Record<string, unknown>;
    assertEquals(enabledPlugins["overmind@overmind"], true);
    assertEquals(enabledPlugins["overmind@local"], undefined);
    assertEquals(settings.allowedTools, ["bash"]);

    const marketplaces = settings.extraKnownMarketplaces as Record<string, unknown>;
    const overmindSource = marketplaces["overmind"] as Record<string, unknown>;
    const source = overmindSource.source as Record<string, unknown>;
    assertEquals(source.source, "github");
    assertEquals(source.repo, "benediktms/overmind");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("installPlugin marketplace mode is idempotent", async () => {
  const root = await Deno.makeTempDir();
  const sourceRoot = `${root}/source-plugin`;
  const pluginDir = `${root}/.claude/plugins/overmind`;
  const settingsPath = `${root}/.claude/settings.json`;

  try {
    await createSourcePluginRoot(sourceRoot);
    await writeJson(settingsPath, {});

    await installPlugin({ mode: "marketplace", sourcePluginRoot: sourceRoot, pluginDir, settingsPath });
    await installPlugin({ mode: "marketplace", sourcePluginRoot: sourceRoot, pluginDir, settingsPath });

    const settings = await readJson(settingsPath);
    const enabledPlugins = settings.enabledPlugins as Record<string, unknown>;
    assertEquals(Object.keys(enabledPlugins).filter((k) => k.startsWith("overmind")).length, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("installPlugin marketplace mode removes @local entry (mutual exclusivity)", async () => {
  const root = await Deno.makeTempDir();
  const sourceRoot = `${root}/source-plugin`;
  const pluginDir = `${root}/.claude/plugins/overmind`;
  const settingsPath = `${root}/.claude/settings.json`;

  try {
    await createSourcePluginRoot(sourceRoot);
    await writeJson(settingsPath, { enabledPlugins: { "overmind@local": true, "other@plugin": true } });

    await installPlugin({ mode: "marketplace", sourcePluginRoot: sourceRoot, pluginDir, settingsPath });

    const settings = await readJson(settingsPath);
    const enabledPlugins = settings.enabledPlugins as Record<string, unknown>;
    assertEquals(enabledPlugins["overmind@local"], undefined);
    assertEquals(enabledPlugins["overmind@overmind"], true);
    assertEquals(enabledPlugins["other@plugin"], true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("installPlugin local mode removes @overmind entry and marketplace source (mutual exclusivity)", async () => {
  const root = await Deno.makeTempDir();
  const sourceRoot = `${root}/source-plugin`;
  const pluginDir = `${root}/.claude/plugins/overmind`;
  const settingsPath = `${root}/.claude/settings.json`;

  try {
    await createSourcePluginRoot(sourceRoot);
    await writeJson(settingsPath, {
      enabledPlugins: { "overmind@overmind": true },
      extraKnownMarketplaces: { overmind: { source: { source: "github", repo: "benediktms/overmind" } } },
    });

    await installPlugin({ mode: "local", sourcePluginRoot: sourceRoot, pluginDir, settingsPath });

    const settings = await readJson(settingsPath);
    const enabledPlugins = settings.enabledPlugins as Record<string, unknown>;
    assertEquals(enabledPlugins["overmind@overmind"], undefined);
    assertEquals(enabledPlugins["overmind@local"], true);

    const marketplaces = settings.extraKnownMarketplaces as Record<string, unknown>;
    assertEquals(marketplaces["overmind"], undefined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

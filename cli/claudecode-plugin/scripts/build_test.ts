import { assertEquals } from "@std/assert";
import { bundlePlugin, validatePluginLayout } from "./build.ts";

interface PluginJson {
  name: string;
  version: string;
  description: string;
  skills: string;
  mcpServers: string;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function createValidLayout(root: string): Promise<void> {
  await Deno.mkdir(`${root}/hooks`, { recursive: true });
  await Deno.mkdir(`${root}/scripts`, { recursive: true });
  await Deno.mkdir(`${root}/skills`, { recursive: true });
  await Deno.mkdir(`${root}/bridge`, { recursive: true });
  await Deno.mkdir(`${root}/.claude-plugin`, { recursive: true });

  await Deno.writeTextFile(`${root}/bridge/mcp-bridge.cjs`, "module.exports = {};\n");

  await writeJson(`${root}/hooks/hooks.json`, {
    hooks: {
      SessionStart: [{
        matcher: "*",
        hooks: [{
          type: "command",
          command: "deno run -A --quiet \"${CLAUDE_PLUGIN_ROOT}/scripts/session-start.ts\"",
          timeout: 5,
        }],
      }],
    },
  });

  await Deno.writeTextFile(
    `${root}/scripts/session-start.ts`,
    "#!/usr/bin/env -S deno run -A --quiet\n",
  );
  await Deno.writeTextFile(
    `${root}/scripts/lib.ts`,
    "export const answer = 42;\n",
  );
  await Deno.writeTextFile(
    `${root}/scripts/keyword-detector.ts`,
    "import { answer } from './lib.ts';\nconsole.log(answer);\n",
  );

  const pluginJson: PluginJson = {
    name: "overmind",
    version: "0.1.0",
    description: "Plugin",
    skills: "./skills/",
    mcpServers: "./mcp-bridge.json",
  };
  await writeJson(`${root}/.claude-plugin/plugin.json`, pluginJson);

  await writeJson(`${root}/mcp-bridge.json`, {
    mcpServers: {
      overmind: {
        command: "node",
        args: ["${CLAUDE_PLUGIN_ROOT}/bridge/mcp-bridge.cjs"],
      },
    },
  });

  await writeJson(`${root}/package.json`, {
    name: "overmind-claudecode",
    version: "0.1.0",
    type: "module",
  });

  await Deno.writeTextFile(
    `${root}/skills/valid.md`,
    [
      "---",
      "name: valid-skill",
      "description: Valid skill",
      "triggers:",
      "  - test trigger",
      "---",
      "",
      "# Skill",
    ].join("\n"),
  );
}

Deno.test("validatePluginLayout passes for valid plugin layout", async () => {
  const root = await Deno.makeTempDir();
  try {
    await createValidLayout(root);
    const result = await validatePluginLayout(root);
    assertEquals(result.valid, true);
    assertEquals(result.errors.length, 0);
    assertEquals(result.warnings.length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validatePluginLayout warns when a script import escapes the plugin root", async () => {
  const root = await Deno.makeTempDir();
  try {
    await createValidLayout(root);
    await Deno.writeTextFile(
      `${root}/scripts/root-escape.ts`,
      "import { something } from '../../../kernel/daemon.ts';\n",
    );

    const result = await validatePluginLayout(root);
    assertEquals(result.valid, true);
    assertEquals(
      result.warnings.some((warning: string) => warning.includes("root-escape.ts")),
      true,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validatePluginLayout fails when hook command script is missing", async () => {
  const root = await Deno.makeTempDir();
  try {
    await createValidLayout(root);
    await Deno.remove(`${root}/scripts/session-start.ts`);

    const result = await validatePluginLayout(root);
    assertEquals(result.valid, false);
    assertEquals(result.errors.some((e: string) => e.includes("session-start.ts")), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validatePluginLayout fails when mcp-bridge.json is invalid JSON", async () => {
  const root = await Deno.makeTempDir();
  try {
    await createValidLayout(root);
    await Deno.writeTextFile(`${root}/mcp-bridge.json`, "{ invalid ");

    const result = await validatePluginLayout(root);
    assertEquals(result.valid, false);
    assertEquals(result.errors.some((e: string) => e.includes("mcp-bridge.json")), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validatePluginLayout fails when plugin.json misses required fields", async () => {
  const root = await Deno.makeTempDir();
  try {
    await createValidLayout(root);
    await writeJson(`${root}/.claude-plugin/plugin.json`, {
      name: "overmind",
      version: "0.1.0",
      mcpServers: "./mcp-bridge.json",
    });

    const result = await validatePluginLayout(root);
    assertEquals(result.valid, false);
    assertEquals(result.errors.some((e: string) => e.includes("plugin.json")), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validatePluginLayout fails when a skill frontmatter is invalid", async () => {
  const root = await Deno.makeTempDir();
  try {
    await createValidLayout(root);
    await Deno.writeTextFile(
      `${root}/skills/invalid.md`,
      [
        "---",
        "name: invalid-skill",
        "description: missing triggers",
        "---",
        "",
        "# Bad skill",
      ].join("\n"),
    );

    const result = await validatePluginLayout(root);
    assertEquals(result.valid, false);
    assertEquals(result.errors.some((e: string) => e.includes("skills/invalid.md")), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validatePluginLayout fails when legacy plugin root env var appears in plugin files", async () => {
  const root = await Deno.makeTempDir();
  try {
    await createValidLayout(root);
    const legacyVar = "OVERMIND_" + "PLUGIN_ROOT";
    await Deno.writeTextFile(
      `${root}/scripts/legacy.ts`,
      `const root = Deno.env.get('${legacyVar}');\n`,
    );

    const result = await validatePluginLayout(root);
    assertEquals(result.valid, false);
    assertEquals(result.errors.some((e: string) => e.includes("legacy env var")), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validatePluginLayout fails when package.json contains dist references", async () => {
  const root = await Deno.makeTempDir();
  try {
    await createValidLayout(root);
    await writeJson(`${root}/package.json`, {
      name: "overmind-claudecode",
      version: "0.1.0",
      main: "dist/index.js",
    });

    const result = await validatePluginLayout(root);
    assertEquals(result.valid, false);
    assertEquals(result.errors.some((e: string) => e.includes("dist/")), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validatePluginLayout fails when package scripts have stale build references", async () => {
  const root = await Deno.makeTempDir();
  try {
    await createValidLayout(root);
    await writeJson(`${root}/package.json`, {
      name: "overmind-claudecode",
      version: "0.1.0",
      scripts: {
        build: "node scripts/build.js",
      },
    });

    const result = await validatePluginLayout(root);
    assertEquals(result.valid, false);
    assertEquals(
      result.errors.some((e: string) => e.includes("stale build script")),
      true,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("bundlePlugin creates complete dist layout with js hook paths", async () => {
  const root = await Deno.makeTempDir();
  const distDir = `${root}/dist`;
  try {
    await createValidLayout(root);
    await bundlePlugin(root, distDir);

    assertEquals(await pathExists(`${distDir}/scripts/session-start.js`), true);
    assertEquals(await pathExists(`${distDir}/hooks/hooks.json`), true);
    assertEquals(await pathExists(`${distDir}/skills/valid.md`), true);
    assertEquals(await pathExists(`${distDir}/bridge/mcp-bridge.cjs`), true);
    assertEquals(await pathExists(`${distDir}/.claude-plugin/plugin.json`), true);

    const hooks = await Deno.readTextFile(`${distDir}/hooks/hooks.json`);
    assertEquals(hooks.includes("session-start.js"), true);
    assertEquals(hooks.includes(".ts\""), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("bundlePlugin copies all skill files into dist", async () => {
  const root = await Deno.makeTempDir();
  const distDir = `${root}/dist`;
  try {
    await createValidLayout(root);
    await Deno.writeTextFile(`${root}/skills/another.md`, "---\nname: another\ndescription: Another\ntriggers:\n  - x\n---\n");
    await bundlePlugin(root, distDir);

    let count = 0;
    for await (const entry of Deno.readDir(`${distDir}/skills`)) {
      if (entry.isFile && entry.name.endsWith(".md")) count++;
    }
    assertEquals(count, 2);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

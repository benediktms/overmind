import { assertEquals } from "@std/assert";
import { validatePluginLayout } from "./build.ts";

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

async function createValidLayout(root: string): Promise<void> {
  await Deno.mkdir(`${root}/hooks`, { recursive: true });
  await Deno.mkdir(`${root}/scripts`, { recursive: true });
  await Deno.mkdir(`${root}/skills`, { recursive: true });
  await Deno.mkdir(`${root}/.claude-plugin`, { recursive: true });

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

import { assertEquals, assertStringIncludes } from "@std/assert";

import { ConfigLoader } from "./config.ts";

/**
 * Build an isolated ConfigLoader where USER_CONFIG_PATH and
 * PROJECT_CONFIG_PATHS are pointed at tmpdir paths instead of the real
 * `~/.config/overmind/...`. We do this by setting `HOME` to a tempdir for
 * the duration of the test and `Deno.chdir`-ing into a tempdir so the
 * project-config search relative to cwd lands somewhere safe.
 *
 * NOTE: ConfigLoader resolves paths at module load (USER_CONFIG_PATH is a
 * top-level const), so it captures the HOME at the time the module was
 * first imported. To keep tests deterministic we touch HOME-relative state
 * by either (a) ensuring no file exists at the real ~/.config/overmind/
 * path during the test (let nature take its course) or (b) writing the
 * project config files in a temp cwd. We use (b) because it doesn't
 * require touching the user's real home.
 */
async function withTempCwd<T>(
  fn: (tempDir: string) => Promise<T>,
): Promise<T> {
  const tempDir = await Deno.makeTempDir({ prefix: "ovr-cfg-" });
  const originalCwd = Deno.cwd();
  Deno.chdir(tempDir);
  try {
    return await fn(tempDir);
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
}

Deno.test("ConfigLoader: snake_case TOML keys are camelized at the load boundary", async () => {
  await withTempCwd(async (tempDir) => {
    await Deno.mkdir(`${tempDir}/.overmind`, { recursive: true });
    await Deno.writeTextFile(
      `${tempDir}/.overmind/overmind.toml`,
      `
[neural_link]
enabled = true
http_url = "http://example.test:9999"
room_ttl_seconds = 1234

[brain]
enabled = true
brain_name = "test"
task_prefix = "TST"

[skills]
auto_inject = false
project_overrides = false

[dispatcher]
mode = "client_side"
`,
    );

    const cfg = await new ConfigLoader().load();

    // Critical regression guard: the user's snake_case TOML overrides the
    // defaults' camelCase fields. Without camelization the merge would
    // leave httpUrl undefined and the adapter would crash at startup.
    assertEquals(cfg.neuralLink.httpUrl, "http://example.test:9999");
    assertEquals(cfg.neuralLink.roomTtlSeconds, 1234);
    assertEquals(cfg.brain.brainName, "test");
    assertEquals(cfg.brain.taskPrefix, "TST");
    assertEquals(cfg.skills.autoInject, false);
    assertEquals(cfg.skills.projectOverrides, false);
    assertEquals(cfg.dispatcher.mode, "client_side");
  });
});

Deno.test("ConfigLoader: missing config file falls back to defaults", async () => {
  await withTempCwd(async (_tempDir) => {
    // No project config written; user config (~/.config/overmind/...) may
    // or may not exist on the test host. The defaults must always provide
    // a valid OvermindConfig regardless.
    const cfg = await new ConfigLoader().load();

    assertEquals(typeof cfg.name, "string");
    assertEquals(typeof cfg.neuralLink.httpUrl, "string");
    assertStringIncludes(cfg.neuralLink.httpUrl, "://");
    assertEquals(typeof cfg.dispatcher.mode, "string");
  });
});

Deno.test("ConfigLoader: snake_case keys nested inside arrays are also camelized", async () => {
  await withTempCwd(async (tempDir) => {
    await Deno.mkdir(`${tempDir}/.overmind`, { recursive: true });
    // Synthetic test case — exercises the array branch of camelizeKeys.
    // No real config section uses nested arrays of objects today, but the
    // helper must handle them so future schema growth doesn't regress.
    await Deno.writeTextFile(
      `${tempDir}/.overmind/overmind.toml`,
      `
[[some_array]]
nested_key = "alpha"

[[some_array]]
nested_key = "beta"

[neural_link]
http_url = "http://default.test"

[brain]
brain_name = "x"
task_prefix = "X"

[skills]
auto_inject = true
project_overrides = true

[dispatcher]
mode = "subprocess"
`,
    );

    const cfg = await new ConfigLoader().load() as unknown as Record<
      string,
      unknown
    >;
    const arr = cfg.someArray as Array<Record<string, unknown>>;
    assertEquals(arr.length, 2);
    assertEquals(arr[0].nestedKey, "alpha");
    assertEquals(arr[1].nestedKey, "beta");
  });
});

Deno.test("ConfigLoader: toKernelConfig surfaces the camelized neuralLink field", async () => {
  await withTempCwd(async (tempDir) => {
    await Deno.mkdir(`${tempDir}/.overmind`, { recursive: true });
    await Deno.writeTextFile(
      `${tempDir}/.overmind/overmind.toml`,
      `
[neural_link]
http_url = "http://kernel.test:9961"
`,
    );

    const loader = new ConfigLoader();
    const overmindCfg = await loader.load();
    const kernelCfg = loader.toKernelConfig(overmindCfg);

    assertEquals(kernelCfg.neuralLink.httpUrl, "http://kernel.test:9961");
  });
});

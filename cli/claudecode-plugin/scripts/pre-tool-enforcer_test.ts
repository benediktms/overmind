import { assertEquals } from "@std/assert";
import {
  decideStaleness,
  evaluateBash,
  evaluateBashCacheBypass,
  evaluateEnvWrite,
  evaluateHarness,
  FILE_MUTATING_TOOLS,
  handleBashTool,
  isHarnessEnabled,
  parseBashWriteCandidates,
} from "./pre-tool-enforcer.ts";
import {
  emptyCache,
  getCachePath,
  saveCache,
  upsertEntry,
} from "./lib/read_hash_cache.ts";

// --- pure decision: decideStaleness ---

Deno.test("decideStaleness allows non-edit tools", () => {
  const d = decideStaleness({
    toolName: "Bash",
    filePath: "/x",
    currentSha: "a",
    cachedEntry: { sha256: "b", readAt: 0, sessionId: "s" },
    isTransient: false,
  });
  assertEquals(d.kind, "allow");
});

Deno.test("decideStaleness allows when no cache entry", () => {
  const d = decideStaleness({
    toolName: "Edit",
    filePath: "/x",
    currentSha: "a",
    cachedEntry: undefined,
    isTransient: false,
  });
  assertEquals(d.kind, "allow");
});

Deno.test("decideStaleness allows when cache matches", () => {
  const d = decideStaleness({
    toolName: "Edit",
    filePath: "/x",
    currentSha: "abc",
    cachedEntry: { sha256: "abc", readAt: 0, sessionId: "s" },
    isTransient: false,
  });
  assertEquals(d.kind, "allow");
});

Deno.test("decideStaleness denies on mismatch", () => {
  const d = decideStaleness({
    toolName: "Edit",
    filePath: "/repo/x.ts",
    currentSha: "fresh",
    cachedEntry: { sha256: "stale", readAt: 0, sessionId: "s" },
    isTransient: false,
  });
  assertEquals(d.kind, "deny");
  if (d.kind === "deny") {
    assertEquals(d.reason.includes("/repo/x.ts"), true);
    assertEquals(d.reason.includes("Stale read detected"), true);
  }
});

Deno.test("decideStaleness allows on missing file (sha null)", () => {
  const d = decideStaleness({
    toolName: "Edit",
    filePath: "/missing",
    currentSha: null,
    cachedEntry: { sha256: "x", readAt: 0, sessionId: "s" },
    isTransient: false,
  });
  assertEquals(d.kind, "allow");
});

Deno.test("decideStaleness allows on transient path", () => {
  const d = decideStaleness({
    toolName: "Edit",
    filePath: "/tmp/x",
    currentSha: "a",
    cachedEntry: { sha256: "b", readAt: 0, sessionId: "s" },
    isTransient: true,
  });
  assertEquals(d.kind, "allow");
});

// --- isHarnessEnabled ---

Deno.test("isHarnessEnabled true when env=1", () => {
  const fakeEnv = { get: () => "1" } as unknown as Deno.Env;
  assertEquals(isHarnessEnabled(fakeEnv), true);
});

Deno.test("isHarnessEnabled false when unset or other value", () => {
  const unset = { get: () => undefined } as unknown as Deno.Env;
  const off = { get: () => "0" } as unknown as Deno.Env;
  assertEquals(isHarnessEnabled(unset), false);
  assertEquals(isHarnessEnabled(off), false);
});

// --- evaluateBash + evaluateEnvWrite (existing behavior parity) ---

Deno.test("evaluateBash flags rm -rf /", () => {
  const d = evaluateBash("rm -rf / --no-preserve-root");
  assertEquals(d.kind, "allow");
  if (d.kind === "allow") {
    assertEquals(d.message?.includes("Dangerous"), true);
  }
});

Deno.test("evaluateBash leaves benign commands alone", () => {
  const d = evaluateBash("ls -la");
  assertEquals(d.kind, "allow");
  if (d.kind === "allow") assertEquals(d.message, undefined);
});

Deno.test("evaluateEnvWrite flags .env writes", () => {
  const d = evaluateEnvWrite("/repo/.env");
  assertEquals(d.kind, "allow");
  if (d.kind === "allow") {
    assertEquals(d.message?.includes(".env"), true);
  }
});

Deno.test("evaluateEnvWrite ignores .env.example", () => {
  const d = evaluateEnvWrite("/repo/.env.example");
  assertEquals(d.kind, "allow");
  if (d.kind === "allow") assertEquals(d.message, undefined);
});

// --- evaluateHarness (orchestrator) ---

async function withTempHomeAndFile(
  fn: (home: string, cwd: string, filePath: string) => Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir();
  const cwd = await Deno.makeTempDir();
  const filePath = `${cwd}/file.ts`;
  await Deno.writeTextFile(filePath, "export const x = 1;\n");
  try {
    await fn(home, cwd, filePath);
  } finally {
    await Deno.remove(home, { recursive: true });
    await Deno.remove(cwd, { recursive: true });
  }
}

Deno.test("evaluateHarness allows when harness off", async () => {
  await withTempHomeAndFile(async (home, cwd, filePath) => {
    const d = await evaluateHarness(
      { tool_name: "Edit", tool_input: { file_path: filePath }, cwd },
      { home, harnessOn: false },
    );
    assertEquals(d.kind, "allow");
  });
});

Deno.test("evaluateHarness allows when no cache entry", async () => {
  await withTempHomeAndFile(async (home, cwd, filePath) => {
    const d = await evaluateHarness(
      { tool_name: "Edit", tool_input: { file_path: filePath }, cwd },
      { home, harnessOn: true },
    );
    assertEquals(d.kind, "allow");
  });
});

Deno.test("evaluateHarness allows when cache matches current sha", async () => {
  await withTempHomeAndFile(async (home, cwd, filePath) => {
    const cachePath = getCachePath(cwd, home);
    const realPath = await Deno.realPath(filePath);
    // Manually compute current sha and seed the cache.
    const data = await Deno.readFile(filePath);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const sha = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    await saveCache(cachePath, upsertEntry(emptyCache(), realPath, sha, "s"));

    const d = await evaluateHarness(
      { tool_name: "Edit", tool_input: { file_path: filePath }, cwd },
      { home, harnessOn: true },
    );
    assertEquals(d.kind, "allow");
  });
});

Deno.test("evaluateHarness denies when cache stale", async () => {
  await withTempHomeAndFile(async (home, cwd, filePath) => {
    const cachePath = getCachePath(cwd, home);
    const realPath = await Deno.realPath(filePath);
    await saveCache(
      cachePath,
      upsertEntry(emptyCache(), realPath, "deadbeef".repeat(8), "s"),
    );

    const d = await evaluateHarness(
      { tool_name: "Edit", tool_input: { file_path: filePath }, cwd },
      { home, harnessOn: true },
    );
    assertEquals(d.kind, "deny");
    if (d.kind === "deny") {
      assertEquals(d.reason.includes("Stale read detected"), true);
    }
  });
});

Deno.test("evaluateHarness allows transient paths even with stale cache", async () => {
  const home = await Deno.makeTempDir();
  const cwd = await Deno.makeTempDir();
  try {
    const tmpPath = "/tmp/scratch.txt";
    const cachePath = getCachePath(cwd, home);
    await saveCache(
      cachePath,
      upsertEntry(emptyCache(), tmpPath, "deadbeef", "s"),
    );

    const d = await evaluateHarness(
      { tool_name: "Edit", tool_input: { file_path: tmpPath }, cwd },
      { home, harnessOn: true },
    );
    assertEquals(d.kind, "allow");
  } finally {
    await Deno.remove(home, { recursive: true });
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("evaluateHarness allows missing files (CC surfaces its own error)", async () => {
  const home = await Deno.makeTempDir();
  const cwd = await Deno.makeTempDir();
  try {
    const ghost = `${cwd}/does_not_exist.ts`;
    const cachePath = getCachePath(cwd, home);
    await saveCache(
      cachePath,
      upsertEntry(emptyCache(), ghost, "deadbeef", "s"),
    );

    const d = await evaluateHarness(
      { tool_name: "Edit", tool_input: { file_path: ghost }, cwd },
      { home, harnessOn: true },
    );
    assertEquals(d.kind, "allow");
  } finally {
    await Deno.remove(home, { recursive: true });
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("evaluateHarness ignores non-edit tools", async () => {
  await withTempHomeAndFile(async (home, cwd) => {
    const d = await evaluateHarness(
      { tool_name: "Bash", tool_input: { command: "ls" }, cwd },
      { home, harnessOn: true },
    );
    assertEquals(d.kind, "allow");
  });
});

// --- Regression / parity with existing checks when harness is on ---

Deno.test("Bash danger pattern still fires when harness is on", async () => {
  await withTempHomeAndFile(async (home, cwd) => {
    // The harness lane only inspects Edit/Write — Bash falls through to the
    // existing dangerous-pattern guard regardless of harness state.
    const harness = await evaluateHarness(
      { tool_name: "Bash", tool_input: { command: "rm -rf /" }, cwd },
      { home, harnessOn: true },
    );
    assertEquals(harness.kind, "allow");
    const bash = evaluateBash("rm -rf / --no-preserve-root");
    assertEquals(bash.kind, "allow");
    if (bash.kind === "allow") {
      assertEquals(bash.message?.includes("Dangerous"), true);
    }
  });
});

Deno.test("evaluateHarness prunes expired entries before lookup", async () => {
  await withTempHomeAndFile(async (home, cwd, filePath) => {
    const cachePath = getCachePath(cwd, home);
    const realPath = await Deno.realPath(filePath);
    // Seed a stale-hash entry with an ancient readAt (1970-ish). pruneStale
    // (called in evaluateHarness) drops it before decideStaleness sees it,
    // so the mismatch never triggers a deny.
    await saveCache(
      cachePath,
      upsertEntry(emptyCache(), realPath, "ancient_hash".repeat(4), "s", 1000),
    );
    const d = await evaluateHarness(
      { tool_name: "Edit", tool_input: { file_path: filePath }, cwd },
      { home, harnessOn: true },
    );
    assertEquals(d.kind, "allow");
  });
});

// --- M2: Bash cache-bypass parsing & warning ---

Deno.test("parseBashWriteCandidates: sed -i with file at end", () => {
  const c = parseBashWriteCandidates("sed -i '' 's/foo/bar/' src/main.ts");
  assertEquals(c, ["src/main.ts"]);
});

Deno.test("parseBashWriteCandidates: sed -i.bak with single file", () => {
  const c = parseBashWriteCandidates("sed -i.bak 's/x/y/g' file.txt");
  assertEquals(c, ["file.txt"]);
});

Deno.test("parseBashWriteCandidates: sed --in-place", () => {
  const c = parseBashWriteCandidates("sed --in-place 's/a/b/' notes.md");
  assertEquals(c, ["notes.md"]);
});

Deno.test("parseBashWriteCandidates: awk -i inplace with file", () => {
  const c = parseBashWriteCandidates(
    "awk -i inplace '{print $0}' data.csv",
  );
  assertEquals(c, ["data.csv"]);
});

Deno.test("parseBashWriteCandidates: simple > redirect", () => {
  const c = parseBashWriteCandidates("echo hi > /tmp/scratch");
  assertEquals(c, ["/tmp/scratch"]);
});

Deno.test("parseBashWriteCandidates: append >> redirect", () => {
  const c = parseBashWriteCandidates("date >> log.txt");
  assertEquals(c, ["log.txt"]);
});

Deno.test("parseBashWriteCandidates: stderr redirect 2>", () => {
  const c = parseBashWriteCandidates("./run 2> err.log");
  assertEquals(c, ["err.log"]);
});

Deno.test("parseBashWriteCandidates: combined &> redirect", () => {
  const c = parseBashWriteCandidates("./run &> all.log");
  assertEquals(c, ["all.log"]);
});

Deno.test("parseBashWriteCandidates: redirect with quoted path", () => {
  const c = parseBashWriteCandidates(`echo "x" > "with spaces.txt"`);
  assertEquals(c, ["with spaces.txt"]);
});

Deno.test("parseBashWriteCandidates: tee with single file", () => {
  const c = parseBashWriteCandidates("echo hi | tee output.log");
  assertEquals(c, ["output.log"]);
});

Deno.test("parseBashWriteCandidates: tee -a", () => {
  const c = parseBashWriteCandidates("date | tee -a journal.txt");
  assertEquals(c, ["journal.txt"]);
});

Deno.test("parseBashWriteCandidates: cat foo > bar lists target", () => {
  const c = parseBashWriteCandidates("cat foo.ts > bar.ts");
  assertEquals(c, ["bar.ts"]);
});

Deno.test("parseBashWriteCandidates: no writes returns empty", () => {
  assertEquals(parseBashWriteCandidates("ls -la"), []);
  assertEquals(parseBashWriteCandidates("grep -r foo src/"), []);
  assertEquals(parseBashWriteCandidates(""), []);
});

Deno.test("evaluateBashCacheBypass: harness off → no warning", async () => {
  await withTempHomeAndFile(async (home, cwd, filePath) => {
    const cachePath = getCachePath(cwd, home);
    const realPath = await Deno.realPath(filePath);
    await saveCache(cachePath, upsertEntry(emptyCache(), realPath, "x", "s"));
    const d = await evaluateBashCacheBypass(
      `sed -i '' 's/x/y/' ${filePath}`,
      { cwd },
      { home, harnessOn: false },
    );
    assertEquals(d.kind, "allow");
    if (d.kind === "allow") assertEquals(d.message, undefined);
  });
});

Deno.test("evaluateBashCacheBypass: cached path → warning", async () => {
  await withTempHomeAndFile(async (home, cwd, filePath) => {
    const cachePath = getCachePath(cwd, home);
    const realPath = await Deno.realPath(filePath);
    await saveCache(cachePath, upsertEntry(emptyCache(), realPath, "x", "s"));
    const d = await evaluateBashCacheBypass(
      `sed -i '' 's/x/y/' ${filePath}`,
      { cwd },
      { home, harnessOn: true },
    );
    assertEquals(d.kind, "allow");
    if (d.kind === "allow") {
      assertEquals(d.message?.includes("OVERMIND SAFETY"), true);
      assertEquals(d.message?.includes(filePath), true);
    }
  });
});

Deno.test("evaluateBashCacheBypass: uncached redirect → no warning", async () => {
  await withTempHomeAndFile(async (home, cwd) => {
    const d = await evaluateBashCacheBypass(
      "echo hi > /tmp/scratch",
      { cwd },
      { home, harnessOn: true },
    );
    assertEquals(d.kind, "allow");
    if (d.kind === "allow") assertEquals(d.message, undefined);
  });
});

Deno.test("evaluateBashCacheBypass: multiple cached paths → comma-listed", async () => {
  await withTempHomeAndFile(async (home, cwd, filePath) => {
    // Add a second cached file in the same cwd.
    const second = `${cwd}/second.ts`;
    await Deno.writeTextFile(second, "export const y = 2;\n");
    const cachePath = getCachePath(cwd, home);
    const real1 = await Deno.realPath(filePath);
    const real2 = await Deno.realPath(second);
    let cache = upsertEntry(emptyCache(), real1, "h1", "s");
    cache = upsertEntry(cache, real2, "h2", "s");
    await saveCache(cachePath, cache);

    const d = await evaluateBashCacheBypass(
      `cat ${filePath} > ${second}`,
      { cwd },
      { home, harnessOn: true },
    );
    assertEquals(d.kind, "allow");
    if (d.kind === "allow") {
      // `>` redirect captures `second`; `cat <file>` reads, doesn't write.
      assertEquals(d.message?.includes(second), true);
      // Negative assertion: the cat source is a READ, not a write target,
      // so it must not appear in the warning even though it's cached.
      assertEquals(d.message?.includes(filePath), false);
    }
  });
});

Deno.test("evaluateBash danger note takes precedence over cache-bypass", () => {
  // Pure-function combo: the orchestration in main() is "danger first, then
  // cache-bypass, never both." Here we just verify the precedence contract
  // by showing evaluateBash returns its message and the caller is expected
  // to break before invoking evaluateBashCacheBypass.
  const dangerous = evaluateBash("rm -rf / --no-preserve-root");
  assertEquals(dangerous.kind, "allow");
  if (dangerous.kind === "allow") {
    assertEquals(dangerous.message?.includes("Dangerous"), true);
  }
});

// --- M2 review: parser refinements ---

Deno.test("parseBashWriteCandidates: sed -i with redirect doesn't lose the file", () => {
  // Was a HIGH-severity bug: walk-from-end picked /dev/null over file.txt.
  const c = parseBashWriteCandidates("sed -i '' 's/x/y/' file.txt > /dev/null");
  assertEquals(c.includes("file.txt"), true);
  assertEquals(c.includes("/dev/null"), false);
});

Deno.test("parseBashWriteCandidates: sed -i reading stdin produces no false-positive file", () => {
  // Was a HIGH-severity bug: heuristic picked the unquoted expression as a "file".
  const c = parseBashWriteCandidates("echo x | sed -i s/x/y/");
  assertEquals(c.includes("s/x/y/"), false);
});

Deno.test("parseBashWriteCandidates: /usr/bin/sed -i is detected", () => {
  const c = parseBashWriteCandidates("/usr/bin/sed -i '' 's/x/y/' file.txt");
  assertEquals(c.includes("file.txt"), true);
});

Deno.test("parseBashWriteCandidates: /dev/null and friends never captured", () => {
  assertEquals(parseBashWriteCandidates("echo hi > /dev/null"), []);
  assertEquals(parseBashWriteCandidates("./run 2> /dev/stderr"), []);
});

Deno.test("parseBashWriteCandidates: subshell doesn't trap trailing paren in path", () => {
  const c = parseBashWriteCandidates("(echo hi > inner.txt)");
  assertEquals(c.includes("inner.txt"), true);
  assertEquals(c.some((p) => p.endsWith(")")), false);
});

// --- M2 review: handleBashTool integration / precedence ---

Deno.test("handleBashTool: danger pattern wins over cache-bypass nudge", async () => {
  await withTempHomeAndFile(async (home, cwd, filePath) => {
    const cachePath = getCachePath(cwd, home);
    const realPath = await Deno.realPath(filePath);
    await saveCache(cachePath, upsertEntry(emptyCache(), realPath, "x", "s"));
    // Command would normally trigger cache-bypass on `${filePath}`; danger
    // pattern is also present → main() must surface the danger note only.
    const msg = await handleBashTool(
      `rm -rf / && sed -i '' 's/x/y/' ${filePath}`,
      { cwd },
      { home, harnessOn: true },
    );
    assertEquals(typeof msg, "string");
    assertEquals(msg!.includes("Dangerous"), true);
    assertEquals(msg!.includes("OVERMIND SAFETY"), true);
    // Crucially: must NOT include the cache-bypass nudge text.
    assertEquals(msg!.includes("hash-cached"), false);
  });
});

Deno.test("handleBashTool: cache-bypass nudge fires when no danger", async () => {
  await withTempHomeAndFile(async (home, cwd, filePath) => {
    const cachePath = getCachePath(cwd, home);
    const realPath = await Deno.realPath(filePath);
    await saveCache(cachePath, upsertEntry(emptyCache(), realPath, "x", "s"));
    const msg = await handleBashTool(
      `sed -i '' 's/x/y/' ${filePath}`,
      { cwd },
      { home, harnessOn: true },
    );
    assertEquals(msg?.includes("hash-cached"), true);
  });
});

Deno.test("handleBashTool: silent allow when neither check triggers", async () => {
  await withTempHomeAndFile(async (home, cwd) => {
    const msg = await handleBashTool(
      "ls -la",
      { cwd },
      { home, harnessOn: true },
    );
    assertEquals(msg, undefined);
  });
});

// --- Update / MultiEdit tool-name coverage (CC has these too) ---

Deno.test("FILE_MUTATING_TOOLS covers Edit, Write, Update, MultiEdit", () => {
  assertEquals(FILE_MUTATING_TOOLS.has("Edit"), true);
  assertEquals(FILE_MUTATING_TOOLS.has("Write"), true);
  assertEquals(FILE_MUTATING_TOOLS.has("Update"), true);
  assertEquals(FILE_MUTATING_TOOLS.has("MultiEdit"), true);
  assertEquals(FILE_MUTATING_TOOLS.has("Read"), false);
  assertEquals(FILE_MUTATING_TOOLS.has("Bash"), false);
});

Deno.test("decideStaleness denies Update on stale cache", () => {
  const d = decideStaleness({
    toolName: "Update",
    filePath: "/repo/x.ts",
    currentSha: "fresh",
    cachedEntry: { sha256: "stale", readAt: 0, sessionId: "s" },
    isTransient: false,
  });
  assertEquals(d.kind, "deny");
});

Deno.test("decideStaleness denies MultiEdit on stale cache", () => {
  const d = decideStaleness({
    toolName: "MultiEdit",
    filePath: "/repo/x.ts",
    currentSha: "fresh",
    cachedEntry: { sha256: "stale", readAt: 0, sessionId: "s" },
    isTransient: false,
  });
  assertEquals(d.kind, "deny");
});

Deno.test("parseBashWriteCandidates: noclobber `>|` is captured", () => {
  const c = parseBashWriteCandidates("echo hi >| forced.txt");
  assertEquals(c.includes("forced.txt"), true);
});

Deno.test("parseBashWriteCandidates: noclobber `>|` without space", () => {
  const c = parseBashWriteCandidates("echo hi >|forced.txt");
  assertEquals(c.includes("forced.txt"), true);
});

Deno.test("evaluateBashCacheBypass: relative path resolves against data.cwd", async () => {
  await withTempHomeAndFile(async (home, cwd, filePath) => {
    // filePath is absolute (e.g., /var/folders/.../cwd/file.ts).
    // Compute the basename to use as a relative reference inside the cwd.
    const basename = filePath.substring(cwd.length + 1);
    const cachePath = getCachePath(cwd, home);
    const realPath = await Deno.realPath(filePath);
    await saveCache(cachePath, upsertEntry(emptyCache(), realPath, "x", "s"));

    // Bash command uses the relative path. Without cwd-aware resolution
    // this would resolve against the hook process cwd and miss the cache.
    const d = await evaluateBashCacheBypass(
      `sed -i '' 's/x/y/' ${basename}`,
      { cwd },
      { home, harnessOn: true },
    );
    assertEquals(d.kind, "allow");
    if (d.kind === "allow") {
      assertEquals(d.message?.includes(basename), true);
    }
  });
});

Deno.test("evaluateHarness denies stale Update", async () => {
  await withTempHomeAndFile(async (home, cwd, filePath) => {
    const cachePath = getCachePath(cwd, home);
    const realPath = await Deno.realPath(filePath);
    await saveCache(
      cachePath,
      upsertEntry(emptyCache(), realPath, "deadbeef".repeat(8), "s"),
    );
    const d = await evaluateHarness(
      { tool_name: "Update", tool_input: { file_path: filePath }, cwd },
      { home, harnessOn: true },
    );
    assertEquals(d.kind, "deny");
  });
});

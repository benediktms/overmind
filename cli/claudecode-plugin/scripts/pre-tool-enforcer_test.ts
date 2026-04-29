import { assertEquals } from "@std/assert";
import {
  decideStaleness,
  evaluateBash,
  evaluateBashCacheBypass,
  evaluateEnvWrite,
  evaluateHarness,
  evaluateLockClaim,
  FILE_MUTATING_TOOLS,
  handleBashTool,
  isHarnessEnabled,
  parseBashWriteCandidates,
} from "./pre-tool-enforcer.ts";
import type { TryAcquireInput, TryAcquireResult } from "./lib/lock_client.ts";
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

// --- ovr-396.23.7: $() / backtick nesting in splitTopLevelSegments ---

Deno.test("splitTopLevelSegments: does not split inside $()", () => {
  // cmd1 $(rm -rf foo && rm bar) cmd2 must produce ONE segment, not three.
  // Previously `&&` inside $() was treated as a top-level separator.
  const c = parseBashWriteCandidates(
    "cmd1 $(rm -rf foo && rm bar) > out.txt",
  );
  // The redirect target is still captured — but the $() body is not split.
  assertEquals(c.includes("out.txt"), true);
});

Deno.test("splitTopLevelSegments: does not split inside backtick substitution", () => {
  // Backtick body `rm -rf /tmp && echo x` must not cause a mid-backtick split.
  const c = parseBashWriteCandidates(
    "echo `cat foo && cat bar` > result.txt",
  );
  assertEquals(c.includes("result.txt"), true);
});

Deno.test("splitTopLevelSegments: nested $() — outer separator still splits", () => {
  // The && outside the $() is a real separator.
  const c = parseBashWriteCandidates(
    "echo $(cat file) && tee out.log",
  );
  assertEquals(c.includes("out.log"), true);
});

// --- ovr-396.23.7: evaluateBash recursion through bash -c / eval / backtick ---

Deno.test("evaluateBash: detects danger inside bash -c '...'", () => {
  const d = evaluateBash("bash -c 'rm -rf /'");
  assertEquals(d.kind, "allow");
  if (d.kind === "allow") {
    assertEquals(d.message?.includes("Dangerous"), true);
  }
});

Deno.test("evaluateBash: detects danger inside sh -c '...'", () => {
  const d = evaluateBash("sh -c 'rm -rf /'");
  assertEquals(d.kind, "allow");
  if (d.kind === "allow") {
    assertEquals(d.message?.includes("Dangerous"), true);
  }
});

Deno.test("evaluateBash: detects danger inside eval '...'", () => {
  const d = evaluateBash("eval 'rm -rf /'");
  assertEquals(d.kind, "allow");
  if (d.kind === "allow") {
    assertEquals(d.message?.includes("Dangerous"), true);
  }
});

Deno.test("evaluateBash: detects danger inside backtick wrapper", () => {
  const d = evaluateBash("`rm -rf /`");
  assertEquals(d.kind, "allow");
  if (d.kind === "allow") {
    assertEquals(d.message?.includes("Dangerous"), true);
  }
});

Deno.test("evaluateBash: safe bash -c does not false-positive", () => {
  const d = evaluateBash("bash -c 'ls -la'");
  assertEquals(d.kind, "allow");
  if (d.kind === "allow") {
    assertEquals(d.message, undefined);
  }
});

Deno.test("evaluateBash: safe eval does not false-positive", () => {
  const d = evaluateBash("eval 'echo hello'");
  assertEquals(d.kind, "allow");
  if (d.kind === "allow") {
    assertEquals(d.message, undefined);
  }
});

Deno.test("evaluateBash: detects danger nested two levels deep", () => {
  // bash -c 'eval "rm -rf /"' — two hops before the danger.
  const d = evaluateBash(`bash -c 'eval "rm -rf /"'`);
  assertEquals(d.kind, "allow");
  if (d.kind === "allow") {
    assertEquals(d.message?.includes("Dangerous"), true);
  }
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

Deno.test("parseBashWriteCandidates: noclobber `>|` inside a pipeline", () => {
  // Pipe operator and noclobber must coexist: `cmd1 | cmd2 >| file` runs
  // cmd1 piped to cmd2, with cmd2's stdout force-redirected to `file`.
  const c = parseBashWriteCandidates("cat src.txt | sort >| forced.txt");
  assertEquals(c.includes("forced.txt"), true);
});

Deno.test("parseBashWriteCandidates: relative path with `..` is captured verbatim", () => {
  // The parser is purely lexical — path normalization happens later in
  // resolvePathSafely (which receives cwd and runs realPath).
  const c = parseBashWriteCandidates("sed -i '' 's/x/y/' ../parent.ts");
  assertEquals(c.includes("../parent.ts"), true);
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

// --- M4: evaluateLockClaim (kernel /lock integration) ---

interface MockEnv {
  get(key: string): string | undefined;
}

function mockEnv(map: Record<string, string>): MockEnv {
  return { get: (k) => map[k] };
}

// Capture each tryAcquire call's input so tests can assert wire-level
// concerns (was the call made? with what mode? what identity tuple?).
function recorder(
  result: TryAcquireResult,
): {
  fn: (input: TryAcquireInput) => Promise<TryAcquireResult>;
  calls: TryAcquireInput[];
} {
  const calls: TryAcquireInput[] = [];
  const fn = (input: TryAcquireInput) => {
    calls.push(input);
    return Promise.resolve(result);
  };
  return { fn, calls };
}

Deno.test("evaluateLockClaim: harness off short-circuits without fetching", async () => {
  const r = recorder({ status: "ok" });
  const result = await evaluateLockClaim(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/x.ts" },
      session_id: "S1",
      agentId: "A",
    },
    { harnessOn: false, fetcher: r.fn },
  );
  assertEquals(result.decision.kind, "allow");
  assertEquals(result.warn, undefined);
  assertEquals(r.calls.length, 0);
});

Deno.test("evaluateLockClaim: non-mutating tool short-circuits without fetching", async () => {
  const r = recorder({ status: "ok" });
  const result = await evaluateLockClaim(
    {
      tool_name: "Bash",
      tool_input: { command: "ls" },
      session_id: "S1",
      agentId: "A",
    },
    { harnessOn: true, fetcher: r.fn },
  );
  assertEquals(result.decision.kind, "allow");
  assertEquals(r.calls.length, 0);
});

Deno.test("evaluateLockClaim: missing path short-circuits", async () => {
  const r = recorder({ status: "ok" });
  const result = await evaluateLockClaim(
    {
      tool_name: "Edit",
      tool_input: {},
      session_id: "S1",
      agentId: "A",
    },
    { harnessOn: true, fetcher: r.fn },
  );
  assertEquals(result.decision.kind, "allow");
  assertEquals(r.calls.length, 0);
});

Deno.test("evaluateLockClaim: ok response allows silently", async () => {
  const r = recorder({ status: "ok" });
  const result = await evaluateLockClaim(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/x.ts" },
      session_id: "S1",
      agentId: "A",
    },
    {
      harnessOn: true,
      fetcher: r.fn,
      env: mockEnv({ OVERMIND_KERNEL_HTTP_URL: "http://localhost:9999" }),
    },
  );
  assertEquals(result.decision.kind, "allow");
  assertEquals(result.warn, undefined);
  assertEquals(r.calls.length, 1);
  assertEquals(r.calls[0].url, "http://localhost:9999");
  assertEquals(r.calls[0].sessionId, "S1");
  assertEquals(r.calls[0].agentId, "A");
});

Deno.test("evaluateLockClaim: conflict denies with structured stop reason", async () => {
  const r = recorder({
    status: "conflict",
    holder: { sessionId: "S2", agentId: "B" },
  });
  const result = await evaluateLockClaim(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/x.ts" },
      session_id: "S1",
      agentId: "A",
    },
    { harnessOn: true, fetcher: r.fn },
  );
  assertEquals(result.decision.kind, "deny");
  if (result.decision.kind === "deny") {
    assertEquals(
      result.decision.reason.includes("File locked by agent B"),
      true,
    );
    assertEquals(result.decision.reason.includes("session S2"), true);
  }
});

Deno.test("evaluateLockClaim: kernel_unavailable allows with warn", async () => {
  const r = recorder({ status: "kernel_unavailable" });
  const result = await evaluateLockClaim(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/x.ts" },
      session_id: "S1",
      agentId: "A",
    },
    { harnessOn: true, fetcher: r.fn },
  );
  assertEquals(result.decision.kind, "allow");
  assertEquals(result.warn?.includes("[OVERMIND SAFETY]"), true);
  assertEquals(result.warn?.includes("kernel unreachable"), true);
});

Deno.test("evaluateLockClaim: skipped (scout/relay) allows silently", async () => {
  // The shouldSkip happens inside tryAcquire; the mock fetcher just returns
  // skipped to simulate that path. evaluateLockClaim must treat it like ok.
  const r = recorder({ status: "skipped" });
  const result = await evaluateLockClaim(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/x.ts" },
      session_id: "S1",
      agentId: "A",
    },
    {
      harnessOn: true,
      fetcher: r.fn,
      env: mockEnv({ OVERMIND_MODE: "scout" }),
    },
  );
  assertEquals(result.decision.kind, "allow");
  assertEquals(result.warn, undefined);
  // The mode is forwarded so tryAcquire's own short-circuit can fire.
  assertEquals(r.calls[0].mode, "scout");
});

Deno.test("evaluateLockClaim: defaults sessionId to 'default' when missing", async () => {
  const r = recorder({ status: "ok" });
  await evaluateLockClaim(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/x.ts" },
    },
    { harnessOn: true, fetcher: r.fn },
  );
  assertEquals(r.calls[0].sessionId, "default");
  assertEquals(r.calls[0].agentId, "unknown");
});

Deno.test("evaluateLockClaim: prefers session_id over sessionId, agentId over agent_type", async () => {
  // Snake-case vs camel-case parity test. CC payloads vary by build; the
  // fallback chain mirrors the M1 hash-cache identity resolution.
  const r = recorder({ status: "ok" });
  await evaluateLockClaim(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/x.ts" },
      session_id: "snake",
      sessionId: "camel",
      agentId: "primary",
      agent_type: "fallback",
    },
    { harnessOn: true, fetcher: r.fn },
  );
  assertEquals(r.calls[0].sessionId, "snake");
  assertEquals(r.calls[0].agentId, "primary");
});

Deno.test("evaluateLockClaim: falls back to camelCase + agent_type when canonical fields absent", async () => {
  const r = recorder({ status: "ok" });
  await evaluateLockClaim(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/x.ts" },
      sessionId: "camel",
      agent_type: "fallback",
    },
    { harnessOn: true, fetcher: r.fn },
  );
  assertEquals(r.calls[0].sessionId, "camel");
  assertEquals(r.calls[0].agentId, "fallback");
});

Deno.test("evaluateLockClaim: defaults kernel URL when env unset", async () => {
  const r = recorder({ status: "ok" });
  await evaluateLockClaim(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/x.ts" },
      session_id: "S1",
      agentId: "A",
    },
    { harnessOn: true, fetcher: r.fn, env: mockEnv({}) },
  );
  assertEquals(r.calls[0].url, "http://localhost:8080");
});

Deno.test("evaluateLockClaim: forwards OVERMIND_MODE", async () => {
  const r = recorder({ status: "ok" });
  await evaluateLockClaim(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/x.ts" },
      session_id: "S1",
      agentId: "A",
    },
    {
      harnessOn: true,
      fetcher: r.fn,
      env: mockEnv({ OVERMIND_MODE: "swarm" }),
    },
  );
  assertEquals(r.calls[0].mode, "swarm");
});

// --- M4: end-to-end pre-tool-enforcer wiring ---
//
// Verify that main()'s decision pipeline composes harness + lock correctly.
// We stand up a real OvermindHttpServer and exercise the script via a
// subprocess so the test exercises the same code path CC will hit.

import { OvermindHttpServer } from "../../../kernel/http.ts";
import { LockRegistry } from "../../../kernel/locks.ts";

async function withKernelServer(
  fn: (
    baseUrl: string,
    registry: LockRegistry,
  ) => Promise<void>,
): Promise<void> {
  const journalPath = await Deno.makeTempFile({ suffix: ".jsonl" });
  const registry = new LockRegistry(journalPath);
  await registry.load();
  const server = new OvermindHttpServer({
    registry,
    port: 0,
    harnessOn: () => true,
  });
  const { port } = server.start();
  try {
    await fn(`http://localhost:${port}`, registry);
  } finally {
    await server.shutdown();
    try {
      await Deno.remove(journalPath);
    } catch {
      // best-effort cleanup
    }
  }
}

Deno.test(
  "evaluateLockClaim: integration with real kernel — 200 path",
  async () => {
    await withKernelServer(async (baseUrl) => {
      // No prior holder; the lock acquire should succeed.
      const result = await evaluateLockClaim(
        {
          tool_name: "Edit",
          tool_input: { file_path: "/repo/integration-200.ts" },
          session_id: "S1",
          agentId: "A",
        },
        {
          harnessOn: true,
          env: mockEnv({ OVERMIND_KERNEL_HTTP_URL: baseUrl }),
        },
      );
      assertEquals(result.decision.kind, "allow");
      assertEquals(result.warn, undefined);
    });
  },
);

Deno.test(
  "evaluateLockClaim: integration with real kernel — 409 path",
  async () => {
    await withKernelServer(async (baseUrl, registry) => {
      // Pre-load a conflicting holder on the same resolved path the hook
      // will compute. resolvePathSafely on a non-existent absolute path
      // falls back to the path itself on macOS, so /repo/integration-409.ts
      // round-trips verbatim and the registry key matches.
      const path = "/repo/integration-409.ts";
      await registry.acquire({
        path,
        sessionId: "S2",
        agentId: "B",
      });

      const result = await evaluateLockClaim(
        {
          tool_name: "Edit",
          tool_input: { file_path: path },
          session_id: "S1",
          agentId: "A",
        },
        {
          harnessOn: true,
          env: mockEnv({ OVERMIND_KERNEL_HTTP_URL: baseUrl }),
        },
      );
      assertEquals(result.decision.kind, "deny");
      if (result.decision.kind === "deny") {
        assertEquals(
          result.decision.reason.includes("File locked by agent B"),
          true,
        );
        assertEquals(
          result.decision.reason.includes("session S2"),
          true,
        );
      }
    });
  },
);

Deno.test(
  "evaluateLockClaim: integration — kernel unreachable fails open with warn",
  async () => {
    // Closed port: 1 is reserved and never bound on Darwin/Linux.
    const result = await evaluateLockClaim(
      {
        tool_name: "Edit",
        tool_input: { file_path: "/repo/integration-down.ts" },
        session_id: "S1",
        agentId: "A",
      },
      {
        harnessOn: true,
        env: mockEnv({ OVERMIND_KERNEL_HTTP_URL: "http://127.0.0.1:1" }),
      },
    );
    assertEquals(result.decision.kind, "allow");
    assertEquals(result.warn?.includes("kernel unreachable"), true);
  },
);

Deno.test(
  "evaluateLockClaim: integration — scout mode skips network call",
  async () => {
    // Even with kernel running, scout mode short-circuits in the client.
    await withKernelServer(async (baseUrl) => {
      const result = await evaluateLockClaim(
        {
          tool_name: "Edit",
          tool_input: { file_path: "/repo/integration-scout.ts" },
          session_id: "S1",
          agentId: "A",
        },
        {
          harnessOn: true,
          env: mockEnv({
            OVERMIND_KERNEL_HTTP_URL: baseUrl,
            OVERMIND_MODE: "scout",
          }),
        },
      );
      assertEquals(result.decision.kind, "allow");
      assertEquals(result.warn, undefined);
    });
  },
);

// --- F3: transient paths skip the lock check ---

Deno.test("evaluateLockClaim: skips /tmp paths without fetching", async () => {
  const r = recorder({ status: "ok" });
  const result = await evaluateLockClaim(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/scratch.ts" },
      session_id: "S1",
      agentId: "A",
    },
    { harnessOn: true, fetcher: r.fn },
  );
  assertEquals(result.decision.kind, "allow");
  // The hook never reaches out to the kernel for transient paths — the
  // fetcher should not be called even once. This avoids both the wasted
  // localhost RTT and the spurious cross-agent conflict on shared scratch
  // files in /tmp / /var/folders.
  assertEquals(r.calls.length, 0);
});

Deno.test("evaluateLockClaim: skips paths under the harness cache dir", async () => {
  // The cache dir lives under HOME. evaluateHarness skips it via
  // isTransientPath; evaluateLockClaim must mirror so the lock layer
  // doesn't end up keying on the agent's own state files.
  const home = await Deno.makeTempDir();
  const cwd = await Deno.makeTempDir();
  try {
    const r = recorder({ status: "ok" });
    // Compute the cache file path the same way evaluateHarness does.
    const cachePath = `${home}/.overmind/edit-harness-cache.json`;
    const result = await evaluateLockClaim(
      {
        tool_name: "Edit",
        tool_input: { file_path: cachePath },
        session_id: "S1",
        agentId: "A",
        cwd,
      },
      { harnessOn: true, fetcher: r.fn, home },
    );
    assertEquals(result.decision.kind, "allow");
    assertEquals(r.calls.length, 0);
  } finally {
    await Deno.remove(home, { recursive: true });
    await Deno.remove(cwd, { recursive: true });
  }
});

// --- F2: identity-fallback warn fires on stderr (via injected logger) ---

Deno.test("evaluateLockClaim: logs warn when sessionId falls back to default", async () => {
  const messages: string[] = [];
  const r = recorder({ status: "ok" });
  const result = await evaluateLockClaim(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/x.ts" },
      // No sessionId / session_id — fallback fires.
      agentId: "A",
    },
    {
      harnessOn: true,
      fetcher: r.fn,
      logger: (m) => messages.push(m),
    },
  );
  assertEquals(result.decision.kind, "allow");
  assertEquals(messages.length, 1);
  assertEquals(messages[0].includes("identity fallback"), true);
  assertEquals(messages[0].includes("sessionId=default"), true);
});

Deno.test("evaluateLockClaim: logs warn when agentId falls back to unknown", async () => {
  const messages: string[] = [];
  const r = recorder({ status: "ok" });
  await evaluateLockClaim(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/x.ts" },
      session_id: "S1",
      // No agentId / agent_type — fallback fires.
    },
    {
      harnessOn: true,
      fetcher: r.fn,
      logger: (m) => messages.push(m),
    },
  );
  assertEquals(messages.length, 1);
  assertEquals(messages[0].includes("agentId=unknown"), true);
});

Deno.test("evaluateLockClaim: no fallback warn when both fields present", async () => {
  const messages: string[] = [];
  const r = recorder({ status: "ok" });
  await evaluateLockClaim(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/x.ts" },
      session_id: "S1",
      agentId: "A",
    },
    {
      harnessOn: true,
      fetcher: r.fn,
      logger: (m) => messages.push(m),
    },
  );
  assertEquals(messages.length, 0);
});

// --- F4: end-to-end composition — kernel-unreachable warn + .env nudge ---
//
// The composition lives inline in main()'s switch (newline-join). Test it
// by running the script as a subprocess so we exercise the same code path
// CC will hit. This is the only way to verify the composition without
// extracting the switch into a new function.

Deno.test(
  "main(): kernel-unreachable warn + .env-write nudge are both surfaced",
  async () => {
    const home = await Deno.makeTempDir();
    const cwd = await Deno.makeTempDir();
    try {
      const filePath = `${cwd}/.env`;
      await Deno.writeTextFile(filePath, "SECRET=x\n");
      // Seed the M1 cache so the hash check passes (file content matches).
      const data = await Deno.readFile(filePath);
      const digest = await crypto.subtle.digest("SHA-256", data);
      const sha = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const cachePath = getCachePath(cwd, home);
      const realPath = await Deno.realPath(filePath);
      await saveCache(
        cachePath,
        upsertEntry(emptyCache(), realPath, sha, "S1"),
      );

      const stdinJson = JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: filePath },
        session_id: "S1",
        agentId: "A",
        cwd,
      });

      // Pass `--config` explicitly so the subprocess picks up the project's
      // JSR import map (`deno.json` at the repo root). Otherwise it would
      // walk up from the script's path and could miss the project config
      // depending on how the test runner was invoked. Without `clearEnv`
      // the subprocess also inherits HOME/DENO_DIR from the parent so
      // `@std/...` resolution stays warm across runs.
      const scriptUrl = new URL("./pre-tool-enforcer.ts", import.meta.url);
      const projectRoot = new URL("../../../deno.json", import.meta.url);
      const cmd = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-all",
          "--quiet",
          "--config",
          projectRoot.pathname,
          scriptUrl.pathname,
        ],
        env: {
          HOME: home,
          OVERMIND_EDIT_HARNESS: "1",
          // Closed port — kernel "unreachable", forcing the warn path.
          OVERMIND_KERNEL_HTTP_URL: "http://127.0.0.1:1",
          // Drop any inherited mode override so the lock check actually runs.
          OVERMIND_MODE: "",
        },
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      });
      const child = cmd.spawn();
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(stdinJson));
      await writer.close();
      const out = await child.output();
      const stdout = new TextDecoder().decode(out.stdout).trim();
      if (out.code !== 0) {
        const stderr = new TextDecoder().decode(out.stderr).trim();
        throw new Error(
          `subprocess exited ${out.code}\nstdout: ${stdout}\nstderr: ${stderr}`,
        );
      }

      const result = JSON.parse(stdout);
      assertEquals(result.continue, true);
      const ctx = result.hookSpecificOutput?.additionalContext as
        | string
        | undefined;
      // Both nudges land in additionalContext, joined by newline. The lock
      // warn precedes the .env nudge per main()'s ordering.
      assertEquals(typeof ctx, "string");
      assertEquals(ctx!.includes("kernel unreachable"), true);
      assertEquals(ctx!.includes(".env"), true);
      assertEquals(ctx!.split("\n").length >= 2, true);
    } finally {
      await Deno.remove(home, { recursive: true });
      await Deno.remove(cwd, { recursive: true });
    }
  },
);

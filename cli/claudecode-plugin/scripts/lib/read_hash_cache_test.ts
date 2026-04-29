import { assertEquals, assertNotEquals } from "@std/assert";
import {
  computeSha256,
  DEFAULT_MAX_BYTES,
  emptyCache,
  enforceMaxBytes,
  getCachePath,
  getEntry,
  getProjectSlug,
  isTransientPath,
  loadCache,
  pruneStale,
  resolvePathSafely,
  saveCache,
  upsertEntry,
} from "./read_hash_cache.ts";

Deno.test("getProjectSlug matches CC's folder convention", () => {
  // Verified against real entries under ~/.claude/projects/. Both "/" and "."
  // become "-".
  assertEquals(
    getProjectSlug("/Users/benedikt.schnatterbeck/code/overmind"),
    "-Users-benedikt-schnatterbeck-code-overmind",
  );
  assertEquals(getProjectSlug("/a/b/c"), "-a-b-c");
});

Deno.test("getCachePath composes the home/.claude/projects path", () => {
  const path = getCachePath("/a/b", "/home/user");
  assertEquals(
    path,
    "/home/user/.claude/projects/-a-b/overmind/read_hashes.json",
  );
});

Deno.test("loadCache returns empty on missing file", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const cache = await loadCache(`${tmp}/does_not_exist.json`);
    assertEquals(cache, emptyCache());
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("loadCache returns empty on malformed JSON", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const path = `${tmp}/bad.json`;
    await Deno.writeTextFile(path, "{ this is not json");
    const cache = await loadCache(path);
    assertEquals(cache, emptyCache());
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("loadCache returns empty when shape is wrong", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const path = `${tmp}/wrong.json`;
    await Deno.writeTextFile(path, JSON.stringify({ stuff: 1 }));
    const cache = await loadCache(path);
    assertEquals(cache, emptyCache());
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("saveCache + loadCache round-trip", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const path = `${tmp}/cache.json`;
    const original = upsertEntry(
      emptyCache(),
      "/foo.ts",
      "abc",
      "s1",
      1_000_000_000_000,
    );
    await saveCache(path, original);
    const loaded = await loadCache(path);
    assertEquals(loaded, original);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("upsertEntry overwrites existing entry", () => {
  let cache = upsertEntry(emptyCache(), "/foo.ts", "aaa", "s1", 1_000);
  cache = upsertEntry(cache, "/foo.ts", "bbb", "s2", 2_000);
  assertEquals(getEntry(cache, "/foo.ts"), {
    sha256: "bbb",
    readAt: 2,
    sessionId: "s2",
  });
});

Deno.test("getEntry returns undefined when missing", () => {
  assertEquals(getEntry(emptyCache(), "/missing.ts"), undefined);
});

Deno.test("pruneStale removes entries older than TTL", () => {
  let cache = upsertEntry(emptyCache(), "/old.ts", "h1", "s", 0);
  cache = upsertEntry(cache, "/fresh.ts", "h2", "s", 10_000_000_000_000);
  const pruned = pruneStale(cache, 100, 10_000_000_000_000);
  assertEquals(getEntry(pruned, "/old.ts"), undefined);
  assertNotEquals(getEntry(pruned, "/fresh.ts"), undefined);
});

Deno.test("enforceMaxBytes drops oldest entries first", () => {
  let cache = emptyCache();
  for (let i = 0; i < 100; i++) {
    cache = upsertEntry(cache, `/file_${i}.ts`, "x".repeat(64), "s", i * 1000);
  }
  const trimmed = enforceMaxBytes(cache, 1024);
  const remaining = Object.keys(trimmed.entries);
  // The newest (highest readAt = highest i) survive; oldest are dropped.
  const allRemainingAreFresher = remaining.every((path) => {
    const i = Number(path.match(/_(\d+)\.ts$/)![1]);
    return i >= 50;
  });
  assertEquals(allRemainingAreFresher, true);
  assertEquals(JSON.stringify(trimmed).length <= 1024, true);
});

// Benchmark-style test: enforceMaxBytes with 5000 entries must complete
// within a wall-clock budget (500 ms is very generous; the O(n) impl runs in
// single-digit ms on any modern machine). This guards against regression to
// the O(n²) JSON.stringify-per-iteration approach.
Deno.test("enforceMaxBytes O(n) performance: 5000 entries within 500ms", () => {
  let cache = emptyCache();
  // Build 5000 entries with paths/sessionIds that vary in length to stress
  // the byte estimator.
  for (let i = 0; i < 5000; i++) {
    cache = upsertEntry(
      cache,
      `/project/src/module_${i}/component_${i}.tsx`,
      "a".repeat(64),
      `session-${i}`,
      i * 1000,
    );
  }
  const start = performance.now();
  const trimmed = enforceMaxBytes(cache, DEFAULT_MAX_BYTES);
  const elapsed = performance.now() - start;
  // Must finish well within 500 ms even on a slow CI box.
  assertEquals(
    elapsed < 500,
    true,
    `enforceMaxBytes took ${
      elapsed.toFixed(1)
    }ms for 5000 entries (limit: 500ms)`,
  );
  // Result must fit within the byte limit.
  assertEquals(JSON.stringify(trimmed).length <= DEFAULT_MAX_BYTES, true);
});

Deno.test("computeSha256 returns null for missing file", async () => {
  assertEquals(await computeSha256("/no/such/file/xyz.txt"), null);
});

Deno.test("computeSha256 produces a stable hex digest", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const path = `${tmp}/data.txt`;
    await Deno.writeTextFile(path, "hello world");
    const hash = await computeSha256(path);
    // sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
    assertEquals(
      hash,
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("isTransientPath detects /tmp, /var/folders, .git", () => {
  assertEquals(isTransientPath("/tmp/foo"), true);
  assertEquals(isTransientPath("/var/folders/abc/T/file.txt"), true);
  assertEquals(isTransientPath("/private/tmp/foo"), true);
  assertEquals(isTransientPath("/repo/.git/HEAD"), true);
  assertEquals(isTransientPath(""), true);
});

Deno.test("isTransientPath detects cacheDir prefix", () => {
  assertEquals(
    isTransientPath(
      "/home/u/.claude/projects/-r/overmind/x",
      "/home/u/.claude/projects/-r/overmind",
    ),
    true,
  );
});

Deno.test("isTransientPath leaves source files alone", () => {
  assertEquals(isTransientPath("/repo/src/main.ts"), false);
  assertEquals(isTransientPath("/Users/u/code/repo/file.ts"), false);
});

Deno.test("resolvePathSafely: absolute path with cwd given is a no-op (cwd ignored)", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const file = `${tmp}/file.ts`;
    await Deno.writeTextFile(file, "x");
    const real = await Deno.realPath(file);
    // Pass an unrelated cwd; result must still match `realPath(file)`,
    // not `realPath(join(cwd, file))`.
    const resolved = await resolvePathSafely(file, "/some/other/dir");
    assertEquals(resolved, real);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolvePathSafely: relative path resolves against cwd", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const file = `${tmp}/data.txt`;
    await Deno.writeTextFile(file, "x");
    const real = await Deno.realPath(file);
    // Relative path "data.txt" + cwd should land on the same realPath.
    const resolved = await resolvePathSafely("data.txt", tmp);
    assertEquals(resolved, real);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolvePathSafely: relative path without cwd falls through (no resolve)", async () => {
  // No cwd given: the function may not realPath successfully; falls back
  // to the input path unchanged.
  const result = await resolvePathSafely("./not_an_absolute_path.ts");
  // Either the realPath resolved (if the file exists relative to cwd) or
  // the original is returned. Either way, no exception.
  assertEquals(typeof result, "string");
});

Deno.test("isTransientPath respects cwd: paths under cwd are never transient", () => {
  // macOS Deno.makeTempDir lands under /var/folders, normally flagged transient.
  // A test cwd or a scratch project under /tmp is still the active project root.
  assertEquals(
    isTransientPath(
      "/var/folders/abc/T/proj/src/x.ts",
      undefined,
      "/var/folders/abc/T/proj",
    ),
    false,
  );
  assertEquals(
    isTransientPath("/tmp/proj/src/x.ts", undefined, "/tmp/proj"),
    false,
  );
});

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
// within a wall-clock budget (50 ms). The O(n) impl runs in single-digit ms
// on any modern machine; an O(n²) regression on a fast laptop takes ~250 ms,
// so 50 ms is a meaningful guard. The maxBytes limit is set to 5000 bytes so
// eviction actually fires (5000 entries >> 5000 bytes), exercising the full
// trim + while-loop boundary path rather than the early-exit fast path.
Deno.test("enforceMaxBytes O(n) performance: 5000 entries within 50ms", () => {
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
  // Use a tiny limit so eviction is forced (exercises the rewritten trim path,
  // not just the early-exit fast path).
  const smallLimit = 5_000;
  const start = performance.now();
  const trimmed = enforceMaxBytes(cache, smallLimit);
  const elapsed = performance.now() - start;
  // Must finish well within 50 ms even on a slow CI box.
  assertEquals(
    elapsed < 50,
    true,
    `enforceMaxBytes took ${
      elapsed.toFixed(1)
    }ms for 5000 entries (limit: 50ms)`,
  );
  // Eviction must have happened — result must be smaller than the input.
  assertEquals(
    Object.keys(trimmed.entries).length < 5000,
    true,
    "eviction should have removed entries",
  );
  // Result must fit within the byte limit.
  assertEquals(JSON.stringify(trimmed).length <= smallLimit, true);
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

Deno.test("resolvePathSafely: absolute path within cwd resolves to realPath", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // Use the canonical form of tmp as cwd so the containment check works on
    // macOS where /var/folders -> /private/var/folders via symlink.
    const realTmp = await Deno.realPath(tmp);
    const file = `${realTmp}/file.ts`;
    await Deno.writeTextFile(file, "x");
    const real = await Deno.realPath(file);
    // cwd matches the file's location: containment passes, realPath is returned.
    const resolved = await resolvePathSafely(file, realTmp);
    assertEquals(resolved, real);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolvePathSafely: absolute path escaping cwd returns unresolved path", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const file = `${tmp}/file.ts`;
    await Deno.writeTextFile(file, "x");
    // Pass an unrelated cwd that doesn't contain the file.
    // The resolved realPath will escape cwd, so the function returns the
    // unresolved absolute path (the symlink itself, not its target).
    const resolved = await resolvePathSafely(file, "/some/other/dir");
    // Must equal the input (already absolute), not the realPath.
    assertEquals(resolved, file);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// Symlink containment: a symlink inside cwd that points to a target outside
// cwd must NOT have its target returned. The unresolved symlink path (inside
// cwd) is returned instead, so the cache key stays within the project.
Deno.test("resolvePathSafely: symlink escaping cwd returns unresolved symlink path", async () => {
  // Two separate temp dirs: one is our "project cwd", the other is "outside".
  const cwdDir = await Deno.makeTempDir();
  const outsideDir = await Deno.makeTempDir();
  try {
    // Canonicalize both dirs to handle macOS /var -> /private/var symlink.
    const realCwd = await Deno.realPath(cwdDir);
    const realOutside = await Deno.realPath(outsideDir);

    // Create the escape target outside cwd.
    const target = `${realOutside}/secret.ts`;
    await Deno.writeTextFile(target, "secret content");

    // Create a symlink inside cwd pointing to the outside target.
    const symlink = `${realCwd}/link.ts`;
    await Deno.symlink(target, symlink);

    // resolvePathSafely must detect the escape and return the symlink path,
    // NOT the resolved target outside cwd.
    const result = await resolvePathSafely(symlink, realCwd);
    assertEquals(
      result,
      symlink,
      `Expected unresolved symlink path ${symlink}, got ${result}`,
    );
    // Sanity: the symlink really does resolve outside cwd.
    const realTarget = await Deno.realPath(symlink);
    assertEquals(realTarget.startsWith(realCwd), false);
  } finally {
    await Deno.remove(cwdDir, { recursive: true });
    await Deno.remove(outsideDir, { recursive: true });
  }
});

Deno.test("resolvePathSafely: relative path resolves against cwd", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // Use canonical cwd so containment check matches the realPath output.
    const realTmp = await Deno.realPath(tmp);
    const file = `${realTmp}/data.txt`;
    await Deno.writeTextFile(file, "x");
    const real = await Deno.realPath(file);
    // Relative path "data.txt" + cwd should land on the same realPath.
    const resolved = await resolvePathSafely("data.txt", realTmp);
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

// N3: resolvePathSafely must resolve cwd internally so callers don't need to
// pre-canonicalize it. On macOS, Deno.makeTempDir() returns a path under
// /var/folders which is a symlink to /private/var/folders. Passing this raw
// (unresolved) cwd must still produce correct containment: a file inside cwd
// is contained, a file outside cwd is not.
Deno.test("resolvePathSafely: containment works when cwd is an unresolved symlink path", async () => {
  // Deno.makeTempDir() returns the raw path before symlink resolution.
  // On macOS this is typically /var/folders/... -> /private/var/folders/...
  // On Linux both are the same, so the test still passes (no-op normalization).
  const rawCwd = await Deno.makeTempDir();
  // Do NOT call Deno.realPath on rawCwd — callers historically omit this step.
  try {
    // Create a file inside rawCwd.
    const fileInside = `${rawCwd}/inside.ts`;
    await Deno.writeTextFile(fileInside, "x");

    // resolvePathSafely must detect that fileInside is within cwd and return
    // its realPath (not the unresolved path).
    const resolved = await resolvePathSafely(fileInside, rawCwd);
    // The result must be the canonical realPath of the file, which stays
    // within the realPath of rawCwd.
    const realCwd = await Deno.realPath(rawCwd);
    assertEquals(
      resolved.startsWith(realCwd),
      true,
      `Expected resolved path "${resolved}" to start with realCwd "${realCwd}"`,
    );

    // Now create a file outside rawCwd and assert it is blocked.
    const outsideDir = await Deno.makeTempDir();
    try {
      const fileOutside = `${outsideDir}/outside.ts`;
      await Deno.writeTextFile(fileOutside, "y");
      const resolvedOutside = await resolvePathSafely(fileOutside, rawCwd);
      // Must NOT resolve to a path inside cwd — containment must reject it
      // and return the unresolved absolute input.
      assertEquals(
        resolvedOutside,
        fileOutside,
        `Expected unresolved path "${fileOutside}", got "${resolvedOutside}"`,
      );
    } finally {
      await Deno.remove(outsideDir, { recursive: true });
    }
  } finally {
    await Deno.remove(rawCwd, { recursive: true });
  }
});

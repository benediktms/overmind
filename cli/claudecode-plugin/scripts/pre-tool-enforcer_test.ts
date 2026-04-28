import { assertEquals } from "@std/assert";
import {
  decideStaleness,
  evaluateBash,
  evaluateEnvWrite,
  evaluateHarness,
  isHarnessEnabled,
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

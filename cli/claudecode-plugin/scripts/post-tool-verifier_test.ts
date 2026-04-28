import { assertEquals, assertNotEquals } from "@std/assert";
import {
  detectBashFailure,
  detectWriteFailure,
  generateMessage,
  processRememberTags,
  refreshCacheIfApplicable,
} from "./post-tool-verifier.ts";
import { getCachePath, getEntry, loadCache } from "./lib/read_hash_cache.ts";

// --- detectBashFailure ---

Deno.test("detectBashFailure catches line-start error:", () => {
  assertEquals(detectBashFailure("error: file not found"), true);
  assertEquals(detectBashFailure("Error: something broke"), true);
});

Deno.test("detectBashFailure catches permission denied", () => {
  assertEquals(detectBashFailure("bash: /etc/shadow: Permission denied"), true);
});

Deno.test("detectBashFailure catches command not found", () => {
  assertEquals(detectBashFailure("bash: foobar: command not found"), true);
});

Deno.test("detectBashFailure catches exit codes", () => {
  assertEquals(detectBashFailure("exit code: 1"), true);
  assertEquals(detectBashFailure("exit status 127"), true);
});

Deno.test("detectBashFailure catches fatal:", () => {
  assertEquals(detectBashFailure("fatal: not a git repository"), true);
});

Deno.test("detectBashFailure does not false-positive on normal output", () => {
  assertEquals(detectBashFailure("6 passed | 0 failed"), false);
  assertEquals(detectBashFailure("npm warn deprecated request@2.88.2"), false);
  assertEquals(detectBashFailure("Build succeeded in 3.2s"), false);
});

Deno.test("detectBashFailure does not match 'error' mid-line in content", () => {
  assertEquals(detectBashFailure("grep found 'error' in file.ts"), false);
  assertEquals(detectBashFailure("The error handling is correct"), false);
});

Deno.test("detectBashFailure does not match 'failed' in normal text", () => {
  assertEquals(detectBashFailure("if the assertion failed, retry"), false);
  assertEquals(detectBashFailure("previously failed tests now pass"), false);
});

Deno.test("detectBashFailure catches exit code 0 as clean", () => {
  assertEquals(detectBashFailure("exit code: 0"), false);
});

// --- detectWriteFailure ---

Deno.test("detectWriteFailure catches write failures", () => {
  assertEquals(detectWriteFailure("error: disk full"), true);
  assertEquals(detectWriteFailure("write failed on /tmp/foo"), true);
  assertEquals(detectWriteFailure("Permission denied"), true);
  assertEquals(detectWriteFailure("read-only file system"), true);
});

Deno.test("detectWriteFailure passes clean output", () => {
  assertEquals(detectWriteFailure("File written successfully"), false);
  assertEquals(detectWriteFailure("Edit applied to line 42"), false);
});

// --- processRememberTags ---

Deno.test("processRememberTags extracts priority tags", () => {
  const output = "text <remember priority>critical info</remember> more text";
  const { priority, regular } = processRememberTags(output);
  assertEquals(priority, ["critical info"]);
  assertEquals(regular.length, 0);
});

Deno.test("processRememberTags extracts regular tags", () => {
  const output = "text <remember>some note</remember> end";
  const { priority, regular } = processRememberTags(output);
  assertEquals(priority.length, 0);
  assertEquals(regular, ["some note"]);
});

Deno.test("processRememberTags extracts multiple tags", () => {
  const output = `
    <remember priority>first priority</remember>
    <remember>first regular</remember>
    <remember priority>second priority</remember>
    <remember>second regular</remember>
  `;
  const { priority, regular } = processRememberTags(output);
  assertEquals(priority.length, 2);
  assertEquals(regular.length, 2);
  assertEquals(priority[0], "first priority");
  assertEquals(regular[1], "second regular");
});

Deno.test("processRememberTags skips empty tags", () => {
  const output = "<remember></remember><remember priority>  </remember>";
  const { priority, regular } = processRememberTags(output);
  assertEquals(priority.length, 0);
  assertEquals(regular.length, 0);
});

Deno.test("processRememberTags returns empty for no tags", () => {
  const { priority, regular } = processRememberTags("no tags here");
  assertEquals(priority.length, 0);
  assertEquals(regular.length, 0);
});

// --- generateMessage ---

Deno.test("generateMessage returns failure message for Bash errors", () => {
  const msg = generateMessage("Bash", "error: file not found");
  assertEquals(typeof msg, "string");
  assertEquals(msg!.includes("failed"), true);
});

Deno.test("generateMessage returns undefined for clean Bash output", () => {
  assertEquals(generateMessage("Bash", "6 passed | 0 failed"), undefined);
});

Deno.test("generateMessage returns failure for failed Edit", () => {
  const msg = generateMessage("Edit", "error: oldString not found in content");
  assertEquals(typeof msg, "string");
  assertEquals(msg!.includes("failed"), true);
});

Deno.test("generateMessage returns undefined for successful Edit", () => {
  assertEquals(
    generateMessage("Edit", "Edit applied successfully."),
    undefined,
  );
});

Deno.test("generateMessage returns failure for failed Write", () => {
  const msg = generateMessage("Write", "Permission denied: /etc/passwd");
  assertEquals(typeof msg, "string");
});

Deno.test("generateMessage returns undefined for successful Write", () => {
  assertEquals(generateMessage("Write", "Wrote file successfully."), undefined);
});

Deno.test("generateMessage returns hint for empty Grep results", () => {
  const msg = generateMessage("Grep", "0");
  assertEquals(typeof msg, "string");
});

Deno.test("generateMessage returns undefined for unknown tools", () => {
  assertEquals(generateMessage("SomeUnknownTool", "any output"), undefined);
});

// --- refreshCacheIfApplicable ---

async function withTempEnv(
  fn: (home: string, cwd: string, filePath: string) => Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir();
  const cwd = await Deno.makeTempDir();
  const filePath = `${cwd}/file.ts`;
  await Deno.writeTextFile(filePath, "export const x = 1;\n");
  const prevHome = Deno.env.get("HOME");
  const prevHarness = Deno.env.get("OVERMIND_EDIT_HARNESS");
  Deno.env.set("HOME", home);
  try {
    await fn(home, cwd, filePath);
  } finally {
    if (prevHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", prevHome);
    if (prevHarness === undefined) Deno.env.delete("OVERMIND_EDIT_HARNESS");
    else Deno.env.set("OVERMIND_EDIT_HARNESS", prevHarness);
    await Deno.remove(home, { recursive: true });
    await Deno.remove(cwd, { recursive: true });
  }
}

Deno.test("refreshCacheIfApplicable does nothing when harness off", async () => {
  await withTempEnv(async (home, cwd, filePath) => {
    Deno.env.delete("OVERMIND_EDIT_HARNESS");
    await refreshCacheIfApplicable(
      { tool_name: "Read", tool_input: { file_path: filePath }, cwd },
      "ok",
    );
    const cache = await loadCache(getCachePath(cwd, home));
    assertEquals(cache.entries, {});
  });
});

Deno.test("refreshCacheIfApplicable populates cache on Read success", async () => {
  await withTempEnv(async (home, cwd, filePath) => {
    Deno.env.set("OVERMIND_EDIT_HARNESS", "1");
    await refreshCacheIfApplicable(
      { tool_name: "Read", tool_input: { file_path: filePath }, cwd },
      "file contents read successfully",
    );
    const real = await Deno.realPath(filePath);
    const cache = await loadCache(getCachePath(cwd, home));
    assertNotEquals(getEntry(cache, real), undefined);
  });
});

Deno.test("refreshCacheIfApplicable refreshes on Edit success", async () => {
  await withTempEnv(async (home, cwd, filePath) => {
    Deno.env.set("OVERMIND_EDIT_HARNESS", "1");
    await refreshCacheIfApplicable(
      { tool_name: "Read", tool_input: { file_path: filePath }, cwd },
      "ok",
    );
    const real = await Deno.realPath(filePath);
    const before = getEntry(await loadCache(getCachePath(cwd, home)), real)!;

    await Deno.writeTextFile(filePath, "export const x = 2;\n"); // mutate
    await refreshCacheIfApplicable(
      { tool_name: "Edit", tool_input: { file_path: filePath }, cwd },
      "Edit applied successfully",
    );

    const after = getEntry(await loadCache(getCachePath(cwd, home)), real)!;
    assertNotEquals(after.sha256, before.sha256);
  });
});

Deno.test("refreshCacheIfApplicable refreshes on Write success", async () => {
  await withTempEnv(async (home, cwd, filePath) => {
    Deno.env.set("OVERMIND_EDIT_HARNESS", "1");
    // No prior Read — Write success on a freshly-created file should still
    // populate the cache so a subsequent Edit can validate.
    await Deno.writeTextFile(filePath, "export const x = 7;\n");
    await refreshCacheIfApplicable(
      { tool_name: "Write", tool_input: { file_path: filePath }, cwd },
      "Wrote file successfully.",
    );
    const real = await Deno.realPath(filePath);
    const entry = getEntry(await loadCache(getCachePath(cwd, home)), real);
    assertNotEquals(entry, undefined);
  });
});

Deno.test("refreshCacheIfApplicable skips on detected write failure", async () => {
  await withTempEnv(async (home, cwd, filePath) => {
    Deno.env.set("OVERMIND_EDIT_HARNESS", "1");
    await refreshCacheIfApplicable(
      { tool_name: "Edit", tool_input: { file_path: filePath }, cwd },
      "Permission denied", // matches WRITE_ERROR_PATTERNS
    );
    const cache = await loadCache(getCachePath(cwd, home));
    assertEquals(cache.entries, {});
  });
});

Deno.test("refreshCacheIfApplicable skips non-cache-relevant tools", async () => {
  await withTempEnv(async (home, cwd, filePath) => {
    Deno.env.set("OVERMIND_EDIT_HARNESS", "1");
    await refreshCacheIfApplicable(
      { tool_name: "Bash", tool_input: { command: "ls" }, cwd },
      "ok",
      // No file_path even available; ensures the early-return is by tool name.
    );
    // Spell out: even if filePath happened to match cwd, Bash is skipped.
    void filePath;
    const cache = await loadCache(getCachePath(cwd, home));
    assertEquals(cache.entries, {});
  });
});

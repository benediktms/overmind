import { assertEquals } from "@std/assert";
import { exists } from "@std/fs";

Deno.test("CLI version command returns 0", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "cli/main.ts", "version"],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  const stdout = new TextDecoder().decode(result.stdout);

  assertEquals(result.code, 0);
  assertEquals(stdout.includes("overmind v"), true);
});

Deno.test("CLI help command returns 0", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "cli/main.ts", "help"],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  const stdout = new TextDecoder().decode(result.stdout);

  assertEquals(result.code, 0);
  assertEquals(stdout.includes("USAGE:"), true);
  assertEquals(stdout.includes("delegate"), true);
});

Deno.test("CLI delegate without objective returns error", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "cli/main.ts", "delegate"],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();

  assertEquals(result.code !== 0, true);
});

Deno.test("CLI setup creates state directory", async () => {
  const tempDir = await Deno.makeTempDir();

  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "cli/main.ts", "setup"],
    stdout: "piped",
    stderr: "piped",
    cwd: tempDir,
    env: { OVERMIND_BASE_DIR: `${tempDir}/.overmind` },
  });
  await cmd.output();

  const stateExists = await exists(`${tempDir}/.overmind/state`);
  assertEquals(stateExists, true);

  await Deno.remove(tempDir, { recursive: true });
});

import { assertEquals, assert } from "@std/assert";

Deno.test("readStdin reads piped input completely", async () => {
  const cmd = new Deno.Command("deno", {
    args: ["eval", `
      import { readStdin } from "./cli/claudecode-plugin/scripts/lib/stdin.ts";
      const result = await readStdin(2000);
      Deno.stdout.writeSync(new TextEncoder().encode(result));
    `],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const process = cmd.spawn();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode('{"test": true}'));
  await writer.close();
  const output = await process.output();
  const text = new TextDecoder().decode(output.stdout);
  assertEquals(text, '{"test": true}');
  assertEquals(output.code, 0);
});

Deno.test("readStdin returns empty string for empty input", async () => {
  const cmd = new Deno.Command("deno", {
    args: ["eval", `
      import { readStdin } from "./cli/claudecode-plugin/scripts/lib/stdin.ts";
      const result = await readStdin(1000);
      Deno.stdout.writeSync(new TextEncoder().encode(result));
    `],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const process = cmd.spawn();
  const writer = process.stdin.getWriter();
  await writer.close();
  const output = await process.output();
  const text = new TextDecoder().decode(output.stdout);
  assertEquals(text, "");
  assertEquals(output.code, 0);
});

Deno.test("readStdin handles large payloads", async () => {
  const payload = JSON.stringify({ data: "x".repeat(8192) });
  const cmd = new Deno.Command("deno", {
    args: ["eval", `
      import { readStdin } from "./cli/claudecode-plugin/scripts/lib/stdin.ts";
      const result = await readStdin(3000);
      Deno.stdout.writeSync(new TextEncoder().encode(String(result.length)));
    `],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const process = cmd.spawn();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(payload));
  await writer.close();
  const output = await process.output();
  const text = new TextDecoder().decode(output.stdout);
  assertEquals(text, String(payload.length));
  assertEquals(output.code, 0);
});

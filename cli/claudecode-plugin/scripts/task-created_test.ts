import { assertEquals } from "@std/assert";
import {
  buildSummary,
  parsePayload,
  type TaskCreatedPayload,
} from "./task-created.ts";

// --- parsePayload ---

Deno.test("parsePayload returns empty object for empty string", () => {
  assertEquals(parsePayload(""), {});
});

Deno.test("parsePayload returns empty object for invalid JSON", () => {
  assertEquals(parsePayload("{not json}"), {});
});

Deno.test("parsePayload parses valid payload", () => {
  const payload = parsePayload(
    JSON.stringify({ task_id: "t-1", title: "Do thing" }),
  );
  assertEquals(payload.task_id, "t-1");
  assertEquals(payload.title, "Do thing");
});

Deno.test("parsePayload accepts camelCase taskId", () => {
  const payload = parsePayload(JSON.stringify({ taskId: "t-42" }));
  assertEquals(payload.taskId, "t-42");
});

// --- buildSummary ---

Deno.test("buildSummary includes task_id and title", () => {
  const p: TaskCreatedPayload = { task_id: "t-1", title: "Implement X" };
  const s = buildSummary(p);
  assertEquals(s.includes("[TaskCreated]"), true);
  assertEquals(s.includes("t-1"), true);
  assertEquals(s.includes("Implement X"), true);
});

Deno.test("buildSummary falls back to 'unknown' for missing id", () => {
  const s = buildSummary({});
  assertEquals(s.includes("unknown"), true);
});

Deno.test("buildSummary falls back to camelCase taskId", () => {
  const s = buildSummary({ taskId: "t-99" });
  assertEquals(s.includes("t-99"), true);
});

// --- positive path: flag on, valid payload, exit 0 ---

Deno.test("handler exits 0 with flag on and valid payload", async () => {
  const payload = JSON.stringify({ task_id: "t-1", title: "Do thing" });
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--quiet",
      new URL("./task-created.ts", import.meta.url).pathname,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: { ...Deno.env.toObject(), CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" },
  });
  const proc = cmd.spawn();
  const writer = proc.stdin.getWriter();
  await writer.write(new TextEncoder().encode(payload));
  await writer.close();
  const { code, stdout } = await proc.output();
  assertEquals(code, 0);
  const out = JSON.parse(new TextDecoder().decode(stdout));
  assertEquals(out.continue, true);
});

// --- no-op when flag off ---

Deno.test("handler exits 0 without reading stdin when flag is off", async () => {
  // TODO(ovr-396.23.13.2): when real gate logic lands, this test should assert
  // that invalid tasks cause exit 1. For now the no-op path exits 0.
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--quiet",
      new URL("./task-created.ts", import.meta.url).pathname,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: { ...Deno.env.toObject(), CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "0" },
  });
  const { code, stdout } = await cmd.output();
  assertEquals(code, 0);
  const out = JSON.parse(new TextDecoder().decode(stdout));
  assertEquals(out.continue, true);
});

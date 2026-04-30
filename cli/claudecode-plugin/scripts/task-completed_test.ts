import { assertEquals } from "@std/assert";
import {
  buildSummary,
  parsePayload,
  type TaskCompletedPayload,
} from "./task-completed.ts";

// --- parsePayload ---

Deno.test("parsePayload returns empty object for empty string", () => {
  assertEquals(parsePayload(""), {});
});

Deno.test("parsePayload returns empty object for invalid JSON", () => {
  assertEquals(parsePayload("{not json}"), {});
});

Deno.test("parsePayload parses valid payload", () => {
  const payload = parsePayload(
    JSON.stringify({
      task_id: "t-5",
      title: "Ship feature",
      outcome: "delivered",
    }),
  );
  assertEquals(payload.task_id, "t-5");
  assertEquals(payload.title, "Ship feature");
  assertEquals(payload.outcome, "delivered");
});

Deno.test("parsePayload accepts camelCase taskId", () => {
  const payload = parsePayload(JSON.stringify({ taskId: "t-77" }));
  assertEquals(payload.taskId, "t-77");
});

// --- buildSummary ---

Deno.test("buildSummary includes task_id, title, and outcome", () => {
  const p: TaskCompletedPayload = {
    task_id: "t-5",
    title: "Ship feature",
    outcome: "delivered",
  };
  const s = buildSummary(p);
  assertEquals(s.includes("[TaskCompleted]"), true);
  assertEquals(s.includes("t-5"), true);
  assertEquals(s.includes("Ship feature"), true);
  assertEquals(s.includes("delivered"), true);
});

Deno.test("buildSummary falls back to 'unknown' for missing id", () => {
  const s = buildSummary({});
  assertEquals(s.includes("unknown"), true);
});

Deno.test("buildSummary falls back to camelCase taskId", () => {
  const s = buildSummary({ taskId: "t-77" });
  assertEquals(s.includes("t-77"), true);
});

// --- positive path: flag on, valid payload, exit 0 ---

Deno.test("handler exits 0 with flag on and valid payload", async () => {
  const payload = JSON.stringify({
    task_id: "t-5",
    title: "Ship feature",
    outcome: "delivered",
  });
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--quiet",
      new URL("./task-completed.ts", import.meta.url).pathname,
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

// --- current behavior: exits 0 when flag is unset (no gate logic yet) ---

Deno.test("exits 0 when CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS is unset", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--quiet",
      new URL("./task-completed.ts", import.meta.url).pathname,
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

// --- placeholder: gate logic not yet implemented ---

Deno.test.ignore(
  "TODO(ovr-396.23.13.1): asserts exit 2 when lock journal is inconsistent at task completion",
  () => {
    // Implement once TaskCompleted gate logic lands (ovr-396.23.13.1:
    // TaskCompleted lock journal consistency check). Expect handler to emit
    // { continue: false } and exit non-zero when the completed task has
    // unresolved lock-journal entries or missing deliverables.
  },
);

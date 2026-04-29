import { assertEquals } from "@std/assert";
import {
  buildSummary,
  parsePayload,
  type TeammateIdlePayload,
} from "./teammate-idle.ts";

// --- parsePayload ---

Deno.test("parsePayload returns empty object for empty string", () => {
  assertEquals(parsePayload(""), {});
});

Deno.test("parsePayload returns empty object for invalid JSON", () => {
  assertEquals(parsePayload("{not json}"), {});
});

Deno.test("parsePayload parses valid payload", () => {
  const payload = parsePayload(
    JSON.stringify({ teammate_id: "drone-1", reason: "done" }),
  );
  assertEquals(payload.teammate_id, "drone-1");
  assertEquals(payload.reason, "done");
});

Deno.test("parsePayload accepts camelCase field", () => {
  const payload = parsePayload(JSON.stringify({ teammateId: "weaver-2" }));
  assertEquals(payload.teammateId, "weaver-2");
});

// --- buildSummary ---

Deno.test("buildSummary includes teammate_id and reason", () => {
  const p: TeammateIdlePayload = {
    teammate_id: "drone-1",
    reason: "task done",
  };
  const s = buildSummary(p);
  assertEquals(s.includes("[TeammateIdle]"), true);
  assertEquals(s.includes("drone-1"), true);
  assertEquals(s.includes("task done"), true);
});

Deno.test("buildSummary falls back to 'unknown' for missing id", () => {
  const s = buildSummary({});
  assertEquals(s.includes("unknown"), true);
});

Deno.test("buildSummary falls back to camelCase teammateId", () => {
  const s = buildSummary({ teammateId: "weaver-2" });
  assertEquals(s.includes("weaver-2"), true);
});

// --- positive path: flag on, valid payload, exit 0 ---

Deno.test("handler exits 0 with flag on and valid payload", async () => {
  const payload = JSON.stringify({ teammate_id: "drone-1", reason: "idle" });
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--quiet",
      new URL("./teammate-idle.ts", import.meta.url).pathname,
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
      new URL("./teammate-idle.ts", import.meta.url).pathname,
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
  "TODO(ovr-396.23.13.2): asserts exit 2 when teammate holds locks at idle time",
  () => {
    // Implement once TeammateIdle gate logic lands (ovr-396.23.13.2:
    // TeammateIdle <remember> persistence nudge). Expect handler to emit
    // { continue: false } and exit non-zero when the teammate has open
    // lock-journal entries at idle time.
  },
);

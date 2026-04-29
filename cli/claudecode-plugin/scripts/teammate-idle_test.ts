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

// --- no-op when flag off (positive path: flag on, exit 0) ---

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

// --- no-op when flag off ---

Deno.test("handler exits 0 without reading stdin when flag is off", async () => {
  // TODO(ovr-396.23.13.1): when real gate logic lands, this test should assert
  // that blocked payloads cause exit 1. For now the no-op path exits 0.
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

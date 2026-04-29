import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";

import { ClaudeCodeDispatcher } from "./claude_code.ts";

const RUN_ID = "run-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

interface SpawnCall {
  cmd: string;
  options: Deno.CommandOptions;
}

/**
 * Build a fake `Deno.ChildProcess` whose stdout/stderr immediately close and
 * whose `status` resolves with the supplied exit code.
 */
function fakeChild(opts: { code?: number } = {}): Deno.ChildProcess {
  const closedStream = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  const status: Deno.CommandStatus = {
    success: (opts.code ?? 0) === 0,
    code: opts.code ?? 0,
    signal: null,
  };
  let killed = false;
  return {
    pid: 0,
    stdout: closedStream(),
    stderr: closedStream(),
    stdin: undefined as unknown as WritableStream<Uint8Array>,
    status: Promise.resolve(status),
    output: () =>
      Promise.resolve({
        ...status,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      }),
    kill: (_signal?: Deno.Signal) => {
      killed = true;
    },
    ref: () => {},
    unref: () => {},
    [Symbol.asyncDispose]: async () => {
      if (killed) return;
    },
    // Test helper — not on the real interface, but readable via casting.
    get __killed(): boolean {
      return killed;
    },
  } as unknown as Deno.ChildProcess;
}

function makeDispatcher(opts: {
  spawnCalls?: SpawnCall[];
  child?: Deno.ChildProcess;
  logsDir?: string;
}): ClaudeCodeDispatcher {
  const calls = opts.spawnCalls ?? [];
  const dispatcher = new ClaudeCodeDispatcher({
    binaryPath: "claude-test",
    logsDir: opts.logsDir,
    spawn: (cmd, options) => {
      calls.push({ cmd, options });
      return opts.child ?? fakeChild();
    },
  });
  // Force availability without invoking probeAvailability (which would shell
  // out to a real binary).
  // deno-lint-ignore no-explicit-any
  (dispatcher as any).available = true;
  return dispatcher;
}

Deno.test("ClaudeCodeDispatcher.dispatch passes role + room env vars to claude", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "ovr-disp-" });
  try {
    const calls: SpawnCall[] = [];
    const dispatcher = makeDispatcher({ spawnCalls: calls, logsDir: tempDir });

    const result = await dispatcher.dispatch({
      agentId: `${RUN_ID}-probe-1`,
      role: "probe",
      prompt: "Map the kernel modes/ directory",
      roomId: "room_abc123",
      participantId: "probe-1",
      workspace: tempDir,
    });

    assertEquals(result.launched, true);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].cmd, "claude-test");

    const env = calls[0].options.env as Record<string, string>;
    assertEquals(env.OVERMIND_RUN_ID, RUN_ID);
    assertEquals(env.OVERMIND_AGENT_ID, `${RUN_ID}-probe-1`);
    assertEquals(env.OVERMIND_ROLE, "probe");
    assertEquals(env.OVERMIND_ROOM_ID, "room_abc123");
    assertEquals(env.OVERMIND_PARTICIPANT_ID, "probe-1");

    const args = (calls[0].options.args ?? []) as string[];
    assertEquals(args[0], "--print");
    assertStringIncludes(args[1], "room_abc123");
    assertStringIncludes(args[1], "probe-1");
    assertStringIncludes(args[1], "Map the kernel modes/ directory");
    assertEquals(args.includes("--permission-mode"), true);
    assertEquals(args.includes("bypassPermissions"), true);
    assertEquals(args.includes("--no-session-persistence"), true);
    assertEquals(calls[0].options.cwd, tempDir);
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("ClaudeCodeDispatcher.dispatch creates per-run log directory", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "ovr-disp-" });
  const logsDir = await Deno.makeTempDir({ prefix: "ovr-logs-" });
  try {
    const dispatcher = makeDispatcher({ logsDir });
    const agentId = `${RUN_ID}-probe-1`;
    await dispatcher.dispatch({
      agentId,
      role: "probe",
      prompt: "x",
      roomId: "room_xyz",
      participantId: "probe-1",
      workspace: tempDir,
    });

    const expectedLog = join(logsDir, RUN_ID, `${agentId}.log`);
    const stat = await Deno.stat(expectedLog);
    assertEquals(stat.isFile, true);
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    await Deno.remove(logsDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("ClaudeCodeDispatcher.dispatch returns error when isAvailable is false", async () => {
  const dispatcher = new ClaudeCodeDispatcher({ binaryPath: "claude-test" });
  // probeAvailability has not been called → available is null → isAvailable() → false
  const result = await dispatcher.dispatch({
    agentId: `${RUN_ID}-probe-1`,
    role: "probe",
    prompt: "x",
    roomId: "room_xyz",
    participantId: "probe-1",
    workspace: "/tmp",
  });
  assertEquals(result.launched, false);
  assertStringIncludes(
    String(result.error ?? ""),
    "claude binary not available",
  );
});

Deno.test("ClaudeCodeDispatcher.cancelRun signals all in-flight children for the run", async () => {
  const logsDir = await Deno.makeTempDir({ prefix: "ovr-logs-" });
  try {
    // Build a child that we can inspect post-cancel.
    let killCount = 0;
    const killable = (): Deno.ChildProcess => {
      const stream = () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            c.close();
          },
        });
      let resolveStatus: (s: Deno.CommandStatus) => void = () => {};
      const status = new Promise<Deno.CommandStatus>((r) => {
        resolveStatus = r;
      });
      return {
        pid: 0,
        stdout: stream(),
        stderr: stream(),
        stdin: undefined as unknown as WritableStream<Uint8Array>,
        status,
        output: () =>
          Promise.resolve({
            success: false,
            code: 143,
            signal: null,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
          }),
        kill: () => {
          killCount += 1;
          resolveStatus({ success: false, code: 143, signal: null });
        },
        ref: () => {},
        unref: () => {},
        [Symbol.asyncDispose]: async () => {},
      } as unknown as Deno.ChildProcess;
    };

    let nextChildKillable = true;
    const dispatcher = new ClaudeCodeDispatcher({
      binaryPath: "claude-test",
      logsDir,
      spawn: () => (nextChildKillable ? killable() : fakeChild()),
    });
    // deno-lint-ignore no-explicit-any
    (dispatcher as any).available = true;

    await dispatcher.dispatch({
      agentId: `${RUN_ID}-probe-1`,
      role: "probe",
      prompt: "x",
      roomId: "room_xyz",
      participantId: "probe-1",
      workspace: logsDir,
    });
    await dispatcher.dispatch({
      agentId: `${RUN_ID}-probe-2`,
      role: "probe",
      prompt: "x",
      roomId: "room_xyz",
      participantId: "probe-2",
      workspace: logsDir,
    });

    // The unrelated run uses a child that exits cleanly so its log file
    // closes without needing cancellation — keeps the test free of leaks.
    nextChildKillable = false;
    const otherRun = "run-ffffffff-ffff-ffff-ffff-ffffffffffff";
    await dispatcher.dispatch({
      agentId: `${otherRun}-probe-1`,
      role: "probe",
      prompt: "x",
      roomId: "room_other",
      participantId: "probe-1",
      workspace: logsDir,
    });
    // Yield once so the fakeChild's status promise resolves and pipeToFile
    // closes the log file before we proceed.
    await new Promise((r) => setTimeout(r, 0));

    assertEquals(killCount, 0);
    const cancelled = dispatcher.cancelRun(RUN_ID);
    assertEquals(cancelled, 2);
    assertEquals(killCount, 2);
    // Yield again so the cancelled children's pipeToFile closes their files.
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    await Deno.remove(logsDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("ClaudeCodeDispatcher.probeAvailability returns false for missing binary", async () => {
  const dispatcher = new ClaudeCodeDispatcher({
    binaryPath: "/this/binary/does/not/exist/claude",
  });
  const available = await dispatcher.probeAvailability();
  assertEquals(available, false);
  assertEquals(dispatcher.isAvailable(), false);
});

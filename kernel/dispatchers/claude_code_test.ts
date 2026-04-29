import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";

import { ClaudeCodeDispatcher } from "./claude_code.ts";

const RUN_ID = "run-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

interface SpawnCall {
  cmd: string;
  options: Deno.CommandOptions;
}

/**
 * A minimal writable stream that collects all written bytes.
 */
function collectingWritable(): {
  stream: WritableStream<Uint8Array>;
  bytes: () => Uint8Array;
} {
  const chunks: Uint8Array[] = [];
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
  });
  return {
    stream,
    bytes: () => {
      const total = chunks.reduce((acc, c) => acc + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      return out;
    },
  };
}

/**
 * Build a fake `Deno.ChildProcess` whose stdout/stderr immediately close and
 * whose `status` resolves with the supplied exit code. Optionally accepts a
 * sink for stdin so tests can inspect what was written.
 */
function fakeChild(
  opts: { code?: number; stdinSink?: WritableStream<Uint8Array> } = {},
): Deno.ChildProcess {
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
  const stdin = opts.stdinSink ??
    new WritableStream<Uint8Array>({ write() {} });
  return {
    pid: 0,
    stdout: closedStream(),
    stderr: closedStream(),
    stdin,
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
  killGraceMs?: number;
}): ClaudeCodeDispatcher {
  const calls = opts.spawnCalls ?? [];
  const dispatcher = new ClaudeCodeDispatcher({
    binaryPath: "claude-test",
    logsDir: opts.logsDir,
    killGraceMs: opts.killGraceMs,
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

// ---------------------------------------------------------------------------
// Original tests (5)
// ---------------------------------------------------------------------------

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
    // After Change 3: prompt goes to stdin, args[1] is the literal "-" sentinel.
    assertEquals(args[1], "-");
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

    const stdoutLog = join(logsDir, RUN_ID, `${agentId}.stdout.log`);
    const stderrLog = join(logsDir, RUN_ID, `${agentId}.stderr.log`);
    const stdoutStat = await Deno.stat(stdoutLog);
    const stderrStat = await Deno.stat(stderrLog);
    assertEquals(stdoutStat.isFile, true);
    assertEquals(stderrStat.isFile, true);
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
      const stdin = new WritableStream<Uint8Array>({ write() {} });
      return {
        pid: 0,
        stdout: stream(),
        stderr: stream(),
        stdin,
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
      killGraceMs: 50,
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

// ---------------------------------------------------------------------------
// New tests (Changes 1–5)
// ---------------------------------------------------------------------------

Deno.test("env allowlist: strips secrets, keeps OVERMIND_* and PATH", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "ovr-env-" });
  try {
    // Inject a secret into the process env before constructing the dispatcher
    // so that it is present in Deno.env.toObject() during baseEnv capture.
    Deno.env.set("SECRET_TEST_KEY", "super-secret");
    Deno.env.set("OVERMIND_CUSTOM_VAR", "should-survive");

    const calls: SpawnCall[] = [];
    const dispatcher = makeDispatcher({ spawnCalls: calls, logsDir: tempDir });

    await dispatcher.dispatch({
      agentId: `${RUN_ID}-probe-1`,
      role: "probe",
      prompt: "test",
      roomId: "room_env",
      participantId: "probe-1",
      workspace: tempDir,
    });

    const env = calls[0].options.env as Record<string, string>;

    // Secrets must be absent.
    assertEquals(
      env["SECRET_TEST_KEY"],
      undefined,
      "SECRET_TEST_KEY must be stripped",
    );

    // OVERMIND_* vars (including overrides and the custom one) must survive.
    assertEquals(env["OVERMIND_RUN_ID"], RUN_ID);
    assertEquals(env["OVERMIND_CUSTOM_VAR"], "should-survive");

    // PATH must survive (explicit allowlist key).
    const pathValue = Deno.env.get("PATH");
    if (pathValue !== undefined) {
      assertEquals(env["PATH"], pathValue);
    }
  } finally {
    Deno.env.delete("SECRET_TEST_KEY");
    Deno.env.delete("OVERMIND_CUSTOM_VAR");
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("env caching: post-construction env mutations do not affect spawned env", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "ovr-cache-" });
  try {
    // Make sure the key is absent at construction time.
    Deno.env.delete("OVERMIND_LATE_ADD");

    const calls: SpawnCall[] = [];
    const dispatcher = makeDispatcher({ spawnCalls: calls, logsDir: tempDir });

    // Add the var AFTER the dispatcher was constructed.
    Deno.env.set("OVERMIND_LATE_ADD", "should-not-appear");

    await dispatcher.dispatch({
      agentId: `${RUN_ID}-probe-1`,
      role: "probe",
      prompt: "test",
      roomId: "room_cache",
      participantId: "probe-1",
      workspace: tempDir,
    });

    const env = calls[0].options.env as Record<string, string>;

    // The cached base env was taken before the mutation, so it must not appear.
    assertEquals(
      env["OVERMIND_LATE_ADD"],
      undefined,
      "Post-construction env mutation must not bleed into spawned env",
    );
  } finally {
    Deno.env.delete("OVERMIND_LATE_ADD");
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("stdin prompt: args contains literal '-', prompt written to stdin", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "ovr-stdin-" });
  try {
    const { stream: stdinSink, bytes: stdinBytes } = collectingWritable();
    const child = fakeChild({ stdinSink });

    const calls: SpawnCall[] = [];
    const dispatcher = new ClaudeCodeDispatcher({
      binaryPath: "claude-test",
      logsDir: tempDir,
      spawn: (cmd, options) => {
        calls.push({ cmd, options });
        return child;
      },
    });
    // deno-lint-ignore no-explicit-any
    (dispatcher as any).available = true;

    const prompt = "Map the kernel modes/ directory";
    await dispatcher.dispatch({
      agentId: `${RUN_ID}-probe-1`,
      role: "probe",
      prompt,
      roomId: "room_stdin",
      participantId: "probe-1",
      workspace: tempDir,
    });

    // Give the async stdin write a tick to complete.
    await new Promise((r) => setTimeout(r, 0));

    const args = (calls[0].options.args ?? []) as string[];

    // args[1] must be the stdin sentinel, not the prompt.
    assertEquals(args[0], "--print");
    assertEquals(args[1], "-", "args[1] must be '-' (stdin sentinel)");

    // The prompt text must NOT appear anywhere in args.
    for (const arg of args) {
      assertEquals(
        arg.includes(prompt),
        false,
        `arg '${arg}' must not contain the raw prompt`,
      );
    }

    // The prompt must have been written to stdin.
    const written = new TextDecoder().decode(stdinBytes());
    assertStringIncludes(written, prompt);
    assertStringIncludes(written, "room_stdin");
    assertStringIncludes(written, "probe-1");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("idempotent cancel: double cancelRun returns same count, entry not double-deleted", async () => {
  const logsDir = await Deno.makeTempDir({ prefix: "ovr-idem-" });
  try {
    const signals: Deno.Signal[] = [];
    const neverExiting = (): Deno.ChildProcess => {
      const stream = () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            c.close();
          },
        });
      // A status promise that never resolves keeps the entry in-flight.
      const status = new Promise<Deno.CommandStatus>(() => {});
      const stdin = new WritableStream<Uint8Array>({ write() {} });
      return {
        pid: 0,
        stdout: stream(),
        stderr: stream(),
        stdin,
        status,
        output: () =>
          Promise.resolve({
            success: false,
            code: 0,
            signal: null,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
          }),
        kill: (sig?: Deno.Signal) => {
          signals.push(sig ?? "SIGTERM");
        },
        ref: () => {},
        unref: () => {},
        [Symbol.asyncDispose]: async () => {},
      } as unknown as Deno.ChildProcess;
    };

    // killGraceMs: 0 so the SIGKILL timer fires immediately; we yield below
    // to drain it, which also proves the timer does not leak.
    const dispatcher = new ClaudeCodeDispatcher({
      binaryPath: "claude-test",
      logsDir,
      killGraceMs: 0,
      spawn: neverExiting,
    });
    // deno-lint-ignore no-explicit-any
    (dispatcher as any).available = true;

    await dispatcher.dispatch({
      agentId: `${RUN_ID}-probe-1`,
      role: "probe",
      prompt: "x",
      roomId: "room_idem",
      participantId: "probe-1",
      workspace: logsDir,
    });

    // First cancel: should send SIGTERM and arm the SIGKILL timer.
    const first = dispatcher.cancelRun(RUN_ID);
    assertEquals(first, 1);
    assertEquals(signals[0], "SIGTERM");

    // Yield so the zero-delay SIGKILL timer fires and drains — prevents leak.
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(signals[1], "SIGKILL");

    // The entry should still be in-flight (only onExit deletes it).
    assertEquals(dispatcher.getInflight().length, 1);

    // Second cancel is a no-op (already cancelled): same count, no new signal.
    const second = dispatcher.cancelRun(RUN_ID);
    assertEquals(second, 1);
    assertEquals(
      signals.length,
      2,
      "No additional kill() calls on second cancel",
    );

    // Entry still in inflight map (child never exited).
    assertEquals(dispatcher.getInflight().length, 1);
  } finally {
    await Deno.remove(logsDir, { recursive: true }).catch(() => {});
  }
});

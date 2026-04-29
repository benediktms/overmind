import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";

import {
  daemonStatus,
  ensureDaemonRunning,
  isDaemonReachable,
  OvermindDaemon,
  selectDispatcher,
  sendToSocket,
  stopDaemon,
} from "./daemon.ts";
import { ClientSideDispatcher } from "./dispatchers/client_side.ts";
import { ClaudeCodeDispatcher } from "./dispatchers/claude_code.ts";
import { Mode } from "./types.ts";

function createTestPaths(
  tempDir: string,
): { baseDir: string; pidPath: string; socketPath: string } {
  const baseDir = `${tempDir}/.overmind`;
  return {
    baseDir,
    pidPath: `${baseDir}/daemon.pid`,
    socketPath: `${baseDir}/daemon.sock`,
  };
}

async function sendRawSocketRequest(
  socketPath: string,
  requestBody: string,
): Promise<string> {
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  await conn.write(encoder.encode(requestBody + "\n"));

  const chunks: Uint8Array[] = [];
  const buf = new Uint8Array(4096);
  while (true) {
    const n = await conn.read(buf);
    if (n === null) break;
    const chunk = buf.slice(0, n);
    chunks.push(chunk);
    if (chunk.includes(0x0a)) break;
  }
  conn.close();

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  const raw = decoder.decode(merged);
  const newlineIndex = raw.indexOf("\n");
  return newlineIndex >= 0 ? raw.slice(0, newlineIndex) : raw;
}

Deno.test("OvermindDaemon creates PID and socket files on start", async () => {
  const tempDir = await Deno.makeTempDir();
  const { baseDir, pidPath, socketPath } = createTestPaths(tempDir);
  const daemon = new OvermindDaemon({ baseDir });

  try {
    await daemon.start();

    const pidText = await Deno.readTextFile(pidPath);
    const socketInfo = await Deno.stat(socketPath);

    assertEquals(Number(pidText.trim()), Deno.pid);
    assert(socketInfo.isSocket);
    assertEquals(daemon.isRunning(), true);
  } finally {
    await daemon.shutdown();
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("OvermindDaemon accepts valid mode_request payloads", async () => {
  const tempDir = await Deno.makeTempDir();
  const { baseDir, socketPath } = createTestPaths(tempDir);
  const daemon = new OvermindDaemon({ baseDir });

  try {
    await daemon.start();

    const responseText = await sendRawSocketRequest(
      socketPath,
      JSON.stringify({
        type: "mode_request",
        run_id: "run-test-1",
        mode: "scout",
        objective: "test objective",
        workspace: tempDir,
      }),
    );
    const response = JSON.parse(responseText) as {
      status: string;
      run_id: string;
      error: string | null;
    };

    assertEquals(response.status, "accepted");
    assertEquals(response.run_id, "run-test-1");
    assertEquals(response.error, null);
  } finally {
    await daemon.shutdown();
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("OvermindDaemon returns error for malformed JSON", async () => {
  const tempDir = await Deno.makeTempDir();
  const { baseDir, socketPath } = createTestPaths(tempDir);
  const daemon = new OvermindDaemon({ baseDir });

  try {
    await daemon.start();

    const responseText = await sendRawSocketRequest(socketPath, "{not-json");
    const response = JSON.parse(responseText) as {
      status: string;
      run_id: string;
      error: string | null;
    };

    assertEquals(response.status, "error");
    assertStringIncludes(response.error ?? "", "Malformed request");
  } finally {
    await daemon.shutdown();
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("OvermindDaemon returns error for invalid mode_request shape", async () => {
  const tempDir = await Deno.makeTempDir();
  const { baseDir, socketPath } = createTestPaths(tempDir);
  const daemon = new OvermindDaemon({ baseDir });

  try {
    await daemon.start();

    const responseText = await sendRawSocketRequest(
      socketPath,
      JSON.stringify({
        type: "mode_request",
        mode: "scout",
        objective: "missing run_id and workspace",
      }),
    );
    const response = JSON.parse(responseText) as {
      status: string;
      run_id: string;
      error: string | null;
    };

    assertEquals(response.status, "error");
    assertStringIncludes(response.error ?? "", "Invalid request");
  } finally {
    await daemon.shutdown();
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("OvermindDaemon removes PID and socket files on shutdown", async () => {
  const tempDir = await Deno.makeTempDir();
  const { baseDir, pidPath, socketPath } = createTestPaths(tempDir);
  const daemon = new OvermindDaemon({ baseDir });

  await daemon.start();
  await daemon.shutdown();

  await assertRejectsNotFound(pidPath);
  await assertRejectsNotFound(socketPath);
  assertEquals(daemon.isRunning(), false);

  await Deno.remove(tempDir, { recursive: true });
});

Deno.test("OvermindDaemon cleans stale PID file before startup", async () => {
  const tempDir = await Deno.makeTempDir();
  const { baseDir, pidPath } = createTestPaths(tempDir);

  await Deno.mkdir(baseDir, { recursive: true });
  await Deno.writeTextFile(pidPath, "99999999\n");

  const daemon = new OvermindDaemon({ baseDir });

  try {
    await daemon.start();

    const pidText = await Deno.readTextFile(pidPath);
    assertNotEquals(Number(pidText.trim()), 99999999);
    assertEquals(Number(pidText.trim()), Deno.pid);
  } finally {
    await daemon.shutdown();
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("OvermindDaemon removes stale socket path before binding", async () => {
  const tempDir = await Deno.makeTempDir();
  const { baseDir, socketPath } = createTestPaths(tempDir);

  await Deno.mkdir(baseDir, { recursive: true });
  await Deno.writeTextFile(socketPath, "stale");

  const daemon = new OvermindDaemon({ baseDir });

  try {
    await daemon.start();

    const socketInfo = await Deno.stat(socketPath);
    assert(socketInfo.isSocket);
  } finally {
    await daemon.shutdown();
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("OvermindDaemon shutdown is safe when daemon was never started", async () => {
  const tempDir = await Deno.makeTempDir();
  const { baseDir } = createTestPaths(tempDir);
  const daemon = new OvermindDaemon({ baseDir });

  await daemon.shutdown();
  assertEquals(daemon.isRunning(), false);

  await Deno.remove(tempDir, { recursive: true });
});

Deno.test("ensureDaemonRunning auto-starts daemon and accepts socket requests", async () => {
  const tempDir = await Deno.makeTempDir();
  const { baseDir, pidPath, socketPath } = createTestPaths(tempDir);

  try {
    await ensureDaemonRunning(baseDir);

    const pidText = await Deno.readTextFile(pidPath);
    assert(Number(pidText.trim()) > 0);

    const response = await sendToSocket({
      type: "mode_request",
      run_id: "run-auto-start",
      mode: Mode.Scout,
      objective: "validate auto-start",
      workspace: tempDir,
    }, socketPath);

    assertEquals(response.status, "accepted");
    assertEquals(response.run_id, "run-auto-start");
  } finally {
    await terminateDaemonFromPidFile(pidPath);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ensureDaemonRunning is idempotent with concurrent calls", async () => {
  const tempDir = await Deno.makeTempDir();
  const { baseDir, pidPath, socketPath } = createTestPaths(tempDir);

  try {
    await Promise.all([
      ensureDaemonRunning(baseDir),
      ensureDaemonRunning(baseDir),
    ]);

    const pidText = await Deno.readTextFile(pidPath);
    const pid = Number(pidText.trim());
    assert(pid > 0);

    const response = await sendToSocket({
      type: "mode_request",
      run_id: "run-idempotent",
      mode: Mode.Scout,
      objective: "validate idempotency",
      workspace: tempDir,
    }, socketPath);

    assertEquals(response.status, "accepted");
  } finally {
    await terminateDaemonFromPidFile(pidPath);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ensureDaemonRunning respects lockfile and waits for daemon readiness", async () => {
  const tempDir = await Deno.makeTempDir();
  const { baseDir, pidPath } = createTestPaths(tempDir);
  const lockPath = `${baseDir}/daemon.lock`;

  await Deno.mkdir(baseDir, { recursive: true });
  const lockHandle = await Deno.open(lockPath, {
    write: true,
    createNew: true,
  });

  try {
    const waitingEnsure = ensureDaemonRunning(baseDir);

    await delay(250);
    lockHandle.close();
    await Deno.remove(lockPath);

    await waitingEnsure;

    const pidText = await Deno.readTextFile(pidPath);
    assert(Number(pidText.trim()) > 0);
    await assertRejects(() => Deno.stat(lockPath), Deno.errors.NotFound);
  } finally {
    await terminateDaemonFromPidFile(pidPath);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("sendToSocket retries until socket becomes available", async () => {
  const tempDir = await Deno.makeTempDir();
  const { baseDir, socketPath } = createTestPaths(tempDir);

  await Deno.mkdir(baseDir, { recursive: true });

  const delayedServer = (async () => {
    await delay(450);
    const listener = Deno.listen({ transport: "unix", path: socketPath });
    const conn = await listener.accept();
    try {
      const reqRaw = await readNdjsonPayload(conn);
      const req = JSON.parse(reqRaw) as { run_id: string };
      const response = {
        status: "accepted",
        run_id: req.run_id,
        error: null,
      };
      await conn.write(
        new TextEncoder().encode(JSON.stringify(response) + "\n"),
      );
    } finally {
      conn.close();
      listener.close();
      await assertRejectsNotFound(socketPath);
    }
  })();

  try {
    const response = await sendToSocket({
      type: "mode_request",
      run_id: "run-retry",
      mode: Mode.Relay,
      objective: "retry",
      workspace: tempDir,
    }, socketPath);

    assertEquals(response.status, "accepted");
    assertEquals(response.run_id, "run-retry");
    await delayedServer;
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

async function assertRejectsNotFound(path: string): Promise<void> {
  try {
    await Deno.stat(path);
    throw new Error(`Expected ${path} to be removed`);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }
}

async function terminateDaemonFromPidFile(pidPath: string): Promise<void> {
  try {
    const pidText = await Deno.readTextFile(pidPath);
    const pid = Number(pidText.trim());
    if (Number.isInteger(pid) && pid > 0) {
      Deno.kill(pid, "SIGTERM");
      await waitFor(async () => {
        try {
          await Deno.stat(pidPath);
          try {
            Deno.kill(pid, 0);
            return false;
          } catch (err) {
            if (err instanceof Deno.errors.NotFound) {
              await Deno.remove(pidPath);
              return true;
            }
            throw err;
          }
        } catch (err) {
          return err instanceof Deno.errors.NotFound;
        }
      }, 2000);
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) {
      return;
    }
    await delay(50);
  }

  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function readNdjsonPayload(conn: Deno.Conn): Promise<string> {
  const chunks: Uint8Array[] = [];
  const buf = new Uint8Array(4096);

  while (true) {
    const n = await conn.read(buf);
    if (n === null) break;
    const chunk = buf.slice(0, n);
    chunks.push(chunk);
    if (chunk.includes(0x0a)) break;
  }

  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }

  const raw = new TextDecoder().decode(merged);
  const newlineIndex = raw.indexOf("\n");
  return newlineIndex >= 0 ? raw.slice(0, newlineIndex) : raw;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Lifecycle: daemonStatus / stopDaemon ──────────────────────────────────
// Drive the pure pieces with synthetic PID files. We never spawn a real
// daemon here — alive cases use Deno.pid (the test runner itself, which is
// guaranteed alive); dead cases use a high PID that's vanishingly unlikely
// to be in use. Stop tests use a short-lived child we control.

Deno.test("daemonStatus reports not-running when no PID file exists", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const { baseDir } = createTestPaths(tempDir);
    await Deno.mkdir(baseDir, { recursive: true });
    const status = await daemonStatus(baseDir);
    assertEquals(status, { running: false, pid: null, stale: false });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("daemonStatus reports running when PID file points at a live process", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const { baseDir, pidPath } = createTestPaths(tempDir);
    await Deno.mkdir(baseDir, { recursive: true });
    // Use the test runner's own PID — guaranteed alive throughout the test.
    await Deno.writeTextFile(pidPath, `${Deno.pid}\n`);
    const status = await daemonStatus(baseDir);
    assertEquals(status.running, true);
    assertEquals(status.pid, Deno.pid);
    assertEquals(status.stale, false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("daemonStatus reports stale when PID file points at a dead process", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const { baseDir, pidPath } = createTestPaths(tempDir);
    await Deno.mkdir(baseDir, { recursive: true });
    // PID 99999999 is far above max_pid on Linux/macOS — guaranteed not in use.
    await Deno.writeTextFile(pidPath, "99999999\n");
    const status = await daemonStatus(baseDir);
    assertEquals(status.running, false);
    assertEquals(status.pid, 99999999);
    assertEquals(status.stale, true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("daemonStatus tolerates a malformed PID file", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const { baseDir, pidPath } = createTestPaths(tempDir);
    await Deno.mkdir(baseDir, { recursive: true });
    await Deno.writeTextFile(pidPath, "not-a-pid\n");
    const status = await daemonStatus(baseDir);
    assertEquals(status, { running: false, pid: null, stale: false });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("isDaemonReachable returns false when no PID file exists", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const { baseDir } = createTestPaths(tempDir);
    await Deno.mkdir(baseDir, { recursive: true });
    assertEquals(await isDaemonReachable(baseDir), false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("isDaemonReachable returns false when PID file is stale (process is dead)", async () => {
  // Regression: the old MCP status probe checked HTTP /health and could
  // report kernel_available: true while the actual delegate transport
  // (Unix socket) was unreachable. This pins the post-fix contract — a
  // dead PID means unreachable, regardless of HTTP.
  const tempDir = await Deno.makeTempDir();
  try {
    const { baseDir, pidPath } = createTestPaths(tempDir);
    await Deno.mkdir(baseDir, { recursive: true });
    await Deno.writeTextFile(pidPath, "99999999\n");
    assertEquals(await isDaemonReachable(baseDir), false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("isDaemonReachable returns false when PID is live but socket is missing", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const { baseDir, pidPath } = createTestPaths(tempDir);
    await Deno.mkdir(baseDir, { recursive: true });
    // Live PID (the test runner) but no socket file → not reachable.
    await Deno.writeTextFile(pidPath, `${Deno.pid}\n`);
    assertEquals(await isDaemonReachable(baseDir), false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("isDaemonReachable returns true when PID is live and socket accepts connections", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const { baseDir } = createTestPaths(tempDir);
    const daemon = new OvermindDaemon({ baseDir, enableHttp: false });
    await daemon.start();
    try {
      assertEquals(await isDaemonReachable(baseDir), true);
    } finally {
      await daemon.shutdown();
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("stopDaemon returns 'not running' and leaves filesystem alone when no PID file", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const { baseDir } = createTestPaths(tempDir);
    await Deno.mkdir(baseDir, { recursive: true });
    const msg = await stopDaemon(baseDir);
    assertStringIncludes(msg, "not running");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("stopDaemon removes a stale PID file and reports it", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const { baseDir, pidPath } = createTestPaths(tempDir);
    await Deno.mkdir(baseDir, { recursive: true });
    await Deno.writeTextFile(pidPath, "99999999\n");
    const msg = await stopDaemon(baseDir);
    assertStringIncludes(msg, "stale PID file");
    assertStringIncludes(msg, "99999999");
    // PID file should be gone.
    await assertRejects(() => Deno.stat(pidPath), Deno.errors.NotFound);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("stopDaemon SIGTERMs a live child and waits for exit", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const { baseDir, pidPath } = createTestPaths(tempDir);
    await Deno.mkdir(baseDir, { recursive: true });

    // Long-running sleep — we'll send SIGTERM to it and assert it exits.
    const child = new Deno.Command("sleep", {
      args: ["60"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    await Deno.writeTextFile(pidPath, `${child.pid}\n`);

    const msg = await stopDaemon(baseDir, {
      timeoutMs: 3_000,
      pollIntervalMs: 50,
    });
    assertStringIncludes(msg, "stopped");
    assertStringIncludes(msg, String(child.pid));

    // PID file removed, process actually exited.
    await assertRejects(() => Deno.stat(pidPath), Deno.errors.NotFound);
    const exit = await child.status;
    assert(!exit.success, "child should have been killed by SIGTERM");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ── sendToSocket: hang resilience ─────────────────────────────────────────
// A peer that accepts the connection but never writes a response used to
// hang sendToSocket forever (Deno.Conn.read has no inherent timeout). The
// fix is a per-attempt timer that closes the conn, forcing the read to
// throw and the retry loop to advance. These tests pin both that timeout
// and the AbortSignal escape hatch.

Deno.test("sendToSocket aborts when caller signal fires before response", async () => {
  const tempDir = await Deno.makeTempDir();
  const { socketPath } = createTestPaths(tempDir);
  await Deno.mkdir(`${tempDir}/.overmind`, { recursive: true });

  // Hung peer: accepts the connection, reads the request, never writes.
  const listener = Deno.listen({ transport: "unix", path: socketPath });
  const acceptedConns: Deno.Conn[] = [];
  const acceptLoop = (async () => {
    while (true) {
      try {
        const conn = await listener.accept();
        acceptedConns.push(conn);
        // Drain the request but deliberately never respond.
        const buf = new Uint8Array(4096);
        await conn.read(buf).catch(() => {});
      } catch {
        return;
      }
    }
  })();

  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const started = Date.now();
    await assertRejects(
      () =>
        sendToSocket(
          {
            type: "mode_request",
            run_id: "abort-test",
            mode: Mode.Scout,
            objective: "x",
            workspace: tempDir,
          },
          socketPath,
          ac.signal,
        ),
      Error,
    );
    const elapsed = Date.now() - started;
    // Aborts should unwind well before the per-attempt timeout (~5s) × retries.
    assert(elapsed < 2_000, `expected fast abort, took ${elapsed}ms`);
  } finally {
    listener.close();
    for (const c of acceptedConns) {
      try {
        c.close();
      } catch {
        // already closed
      }
    }
    await acceptLoop.catch(() => {});
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("sendToSocket times out per-attempt against a hung peer (no abort signal)", async () => {
  // Pins the PRIMARY fix for the original 290s hang: a per-attempt timer
  // that closes the conn so a half-open socket can't wait forever. Uses
  // the injectable timeoutMs so CI doesn't sit on the production 5s.
  const tempDir = await Deno.makeTempDir();
  const { socketPath } = createTestPaths(tempDir);
  await Deno.mkdir(`${tempDir}/.overmind`, { recursive: true });

  const listener = Deno.listen({ transport: "unix", path: socketPath });
  const acceptedConns: Deno.Conn[] = [];
  const acceptLoop = (async () => {
    while (true) {
      try {
        const conn = await listener.accept();
        acceptedConns.push(conn);
        const buf = new Uint8Array(4096);
        await conn.read(buf).catch(() => {});
      } catch {
        return;
      }
    }
  })();

  try {
    const started = Date.now();
    await assertRejects(
      () =>
        sendToSocket(
          {
            type: "mode_request",
            run_id: "timeout-test",
            mode: Mode.Scout,
            objective: "x",
            workspace: tempDir,
          },
          socketPath,
          undefined,
          150, // tight per-attempt timeout for fast CI
        ),
      Error,
    );
    const elapsed = Date.now() - started;
    // Once the post-connect timeout fires we break out of the retry loop
    // (see kernel/daemon.ts: `if (connected) break;`), so worst case is
    // ~timeoutMs + small overhead. Without the per-attempt timer this
    // call would hang until acceptLoop teardown forced a close.
    assert(
      elapsed < 1_000,
      `expected ~150ms timeout to surface quickly, took ${elapsed}ms`,
    );
  } finally {
    listener.close();
    for (const c of acceptedConns) {
      try {
        c.close();
      } catch {
        // already closed
      }
    }
    await acceptLoop.catch(() => {});
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ── selectDispatcher ──────────────────────────────────────────────────────

Deno.test("selectDispatcher: env OVERMIND_CLIENT_DISPATCHER=1 forces client_side over config", async () => {
  const dispatcher = await selectDispatcher(
    "subprocess",
    (k) => k === "OVERMIND_CLIENT_DISPATCHER" ? "1" : undefined,
  );
  assert(dispatcher instanceof ClientSideDispatcher);
});

Deno.test("selectDispatcher: env OVERMIND_CLIENT_DISPATCHER=0 forces subprocess over config", async () => {
  const dispatcher = await selectDispatcher(
    "client_side",
    (k) => k === "OVERMIND_CLIENT_DISPATCHER" ? "0" : undefined,
  );
  assert(
    dispatcher === undefined || dispatcher instanceof ClaudeCodeDispatcher,
    "expected ClaudeCodeDispatcher or undefined (Noop fallback) when env forces subprocess",
  );
});

Deno.test("selectDispatcher: config 'client_side' is honored when env is unset", async () => {
  const dispatcher = await selectDispatcher("client_side", (_k) => undefined);
  assert(dispatcher instanceof ClientSideDispatcher);
});

Deno.test("selectDispatcher: config 'subprocess' (default) returns ClaudeCodeDispatcher or Noop when env unset", async () => {
  const dispatcher = await selectDispatcher("subprocess", (_k) => undefined);
  assert(
    dispatcher === undefined || dispatcher instanceof ClaudeCodeDispatcher,
    "expected ClaudeCodeDispatcher or undefined when env unset",
  );
});

Deno.test("selectDispatcher: omitting both args defaults to subprocess (matches doc)", async () => {
  // The first overload — `selectDispatcher()` with no args — defaults to
  // configMode='subprocess' and reads real Deno.env. This test only asserts
  // the function is callable with no args (regression guard); the actual
  // dispatcher type depends on whether `claude` is on PATH in the test env.
  const dispatcher = await selectDispatcher();
  assert(
    dispatcher === undefined ||
      dispatcher instanceof ClaudeCodeDispatcher ||
      dispatcher instanceof ClientSideDispatcher,
    "expected one of the three dispatcher branches",
  );
});

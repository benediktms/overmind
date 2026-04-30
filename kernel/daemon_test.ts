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
  selectDaemonSpawnArgs,
  selectDispatcher,
  selectDispatchers,
  sendToSocket,
  stopDaemon,
} from "./daemon.ts";
import { ClientSideDispatcher } from "./dispatchers/client_side.ts";
import { ClaudeCodeDispatcher } from "./dispatchers/claude_code.ts";
import { Mode } from "./types.ts";
import { Kernel } from "./kernel.ts";
import { AdapterRegistry } from "./adapters.ts";
import type { AgentDispatcher } from "./agent_dispatcher.ts";
import { type BrainAdapter } from "../adapters/brain/adapter.ts";
import { type NeuralLinkAdapter } from "../adapters/neural_link/adapter.ts";
import { MockBrainAdapter } from "./test_helpers/mock_brain.ts";
import { MockNeuralLinkAdapter } from "./test_helpers/mock_neural_link.ts";

/**
 * Build a Kernel with mocked brain + neural_link adapters (no real child
 * processes spawned). Tests that need a started kernel use this to avoid
 * Deno's leak detector flagging the spawned MCP subprocesses.
 */
async function buildTestKernel(
  options: {
    dispatchers?: Partial<Record<"subprocess" | "client_side", AgentDispatcher>>;
    defaultDispatcherMode?: "subprocess" | "client_side";
  } = {},
): Promise<Kernel> {
  const seed = new Kernel();
  const registry = new AdapterRegistry(seed, {
    brain: new MockBrainAdapter() as unknown as BrainAdapter,
    neuralLink: new MockNeuralLinkAdapter() as unknown as NeuralLinkAdapter,
  });
  const kernel = new Kernel({
    registry,
    dispatchers: options.dispatchers,
    defaultDispatcherMode: options.defaultDispatcherMode,
  });
  await kernel.start();
  return kernel;
}

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

Deno.test({
  name: "OvermindDaemon accepts valid mode_request payloads",
  // Wire-protocol test: verifies the daemon's accept path. The daemon
  // hands the request to executeMode in fire-and-forget mode; persistence
  // writes complete on microtasks after the socket response. Disable leak
  // sanitization for this specific test — the in-flight async I/O is the
  // contract, not a bug. Kernel-level lifecycle is tested separately.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const { baseDir, socketPath } = createTestPaths(tempDir);
    // The daemon now requires a wired kernel to accept mode_requests —
    // the kernel-presence guard rejects requests on a kernel-less
    // daemon (silent-acceptance regression check, oculus team review).
    const kernel = await buildTestKernel();
    const daemon = new OvermindDaemon({ baseDir, kernel, enableHttp: false });

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

      // Cancel the in-flight run so executeScout unwinds before cleanup.
      // Best-effort — even with cancel, persistence may still flush
      // writes after we return; that's why sanitizeOps is off.
      await sendRawSocketRequest(
        socketPath,
        JSON.stringify({ type: "cancel_request", run_id: "run-test-1" }),
      );
    } finally {
      await daemon.shutdown();
      await kernel.shutdown();
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Late persistence writes may have repopulated the dir between
        // shutdown and remove. Best-effort cleanup; OS-level temp dir
        // janitor handles the leftovers.
      }
    }
  },
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

// ── daemon lifetime advisory lock ─────────────────────────────────────────

Deno.test(
  "OvermindDaemon advisory lock prevents a second daemon while the first is running",
  async () => {
    const tempDir = await Deno.makeTempDir();
    const { baseDir } = createTestPaths(tempDir);
    const first = new OvermindDaemon({ baseDir, enableHttp: false });
    await first.start();
    try {
      const second = new OvermindDaemon({ baseDir, enableHttp: false });
      let secondError: unknown;
      try {
        await second.start();
        await second.shutdown();
      } catch (err) {
        secondError = err;
      }
      assert(
        secondError !== undefined,
        "second daemon's start() should reject while first holds the lock",
      );
      assertStringIncludes(
        String(
          secondError instanceof Error ? secondError.message : secondError,
        ),
        "Daemon already running",
      );
    } finally {
      await first.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "OvermindDaemon advisory lock auto-releases after first daemon shuts down",
  async () => {
    const tempDir = await Deno.makeTempDir();
    const { baseDir } = createTestPaths(tempDir);
    const first = new OvermindDaemon({ baseDir, enableHttp: false });
    await first.start();
    await first.shutdown();

    // After clean shutdown, the second daemon must be able to start
    // without any manual lockfile cleanup. This is the core property
    // that the OS-advisory lock provides over the old create-O_EXCL
    // pattern: a crashed/closed first daemon never blocks the next one.
    const second = new OvermindDaemon({ baseDir, enableHttp: false });
    try {
      await second.start();
    } finally {
      await second.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

// ── selectDaemonSpawnArgs ─────────────────────────────────────────────────

Deno.test(
  "selectDaemonSpawnArgs: dev mode (deno binary) uses `run --allow-all`",
  () => {
    const args = selectDaemonSpawnArgs(
      "/usr/local/bin/deno",
      "/repo/kernel/daemon.ts",
    );
    assertEquals(args, ["run", "--allow-all", "/repo/kernel/daemon.ts"]);
  },
);

Deno.test(
  "selectDaemonSpawnArgs: compiled binary uses `daemon start` subcommand",
  () => {
    // The compiled binary path is whatever the user installed; the
    // decision must NOT bake in a specific name — just absence of a
    // trailing "deno" segment. Auto-respawn from a compiled MCP server
    // (regression: the previous code used `run --allow-all`, which
    // fell through cli/overmind.ts's runCli default and printed help
    // instead of starting the daemon).
    const args = selectDaemonSpawnArgs(
      "/Users/x/.local/bin/overmind",
      "/repo/kernel/daemon.ts",
    );
    assertEquals(args, ["daemon", "start"]);
  },
);

Deno.test(
  "selectDaemonSpawnArgs: compiled binary path with non-overmind name still uses subcommand form",
  () => {
    // Robustness: the decision is "is this deno or not" — any non-deno
    // path is treated as a compiled binary, since the compile step
    // emits `runDaemon` behind the `daemon start` subcommand.
    const args = selectDaemonSpawnArgs(
      "/some/wrapper/path",
      "/repo/kernel/daemon.ts",
    );
    assertEquals(args, ["daemon", "start"]);
  },
);

// ── selectDispatchers (registry) ──────────────────────────────────────────

Deno.test(
  "selectDispatchers always exposes client_side (no preconditions)",
  async () => {
    const { dispatchers, defaultMode } = await selectDispatchers();
    assert(
      dispatchers.client_side instanceof ClientSideDispatcher,
      "client_side dispatcher must always be present",
    );
    assert(
      defaultMode === "subprocess" || defaultMode === "client_side",
      "defaultMode must be one of the two known modes",
    );
    // subprocess presence depends on `claude` binary in the test env;
    // either branch is valid as long as the type matches when present.
    if (dispatchers.subprocess) {
      assert(dispatchers.subprocess instanceof ClaudeCodeDispatcher);
    }
  },
);

Deno.test(
  "selectDispatchers prefers subprocess as default when available",
  async () => {
    const { dispatchers, defaultMode } = await selectDispatchers();
    if (dispatchers.subprocess) {
      assertEquals(
        defaultMode,
        "subprocess",
        "defaultMode must be subprocess when subprocess dispatcher is available",
      );
    } else {
      assertEquals(
        defaultMode,
        "client_side",
        "defaultMode falls back to client_side only when subprocess is unavailable",
      );
    }
  },
);

// ── dispatcher_mode loud-fail at request handle time ──────────────────────

Deno.test(
  "OvermindDaemon rejects mode_request with unknown dispatcher_mode value (loud parse fail)",
  async () => {
    const tempDir = await Deno.makeTempDir();
    const { baseDir, socketPath } = createTestPaths(tempDir);
    await Deno.mkdir(baseDir, { recursive: true });
    const daemon = new OvermindDaemon({ baseDir, enableHttp: false });
    await daemon.start();
    try {
      const requestBody = JSON.stringify({
        type: "mode_request",
        run_id: "run-bad-dispatcher-mode",
        mode: Mode.Scout,
        objective: "anything",
        workspace: tempDir,
        dispatcher_mode: "totally-bogus",
      });
      const responseText = await sendRawSocketRequest(socketPath, requestBody);
      const response = JSON.parse(responseText) as {
        status: string;
        run_id: string;
        error: string | null;
      };
      assertEquals(response.status, "error");
      assertStringIncludes(
        String(response.error ?? ""),
        "mode_request contract",
      );
    } finally {
      await daemon.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "OvermindDaemon rejects mode_request when caller asks for a dispatcher the kernel doesn't have (loud-fail at runtime)",
  async () => {
    // Covers the runtime guard in the request handler: the request passes
    // the parse/enum check (dispatcher_mode: "client_side" is a valid
    // enum value) but the kernel's registry only has "subprocess", so
    // the daemon must reject synchronously with a structured error
    // instead of silently queuing into a missing backend. This is the
    // primary behaviour the per-request dispatcher_mode refactor
    // exists to guarantee.
    const tempDir = await Deno.makeTempDir();
    const { baseDir, socketPath } = createTestPaths(tempDir);
    await Deno.mkdir(baseDir, { recursive: true });

    const subStub: AgentDispatcher = {
      dispatch: async (_req) => ({ launched: true }),
      isAvailable: () => true,
    };
    const kernel = await buildTestKernel({
      dispatchers: { subprocess: subStub },
      defaultDispatcherMode: "subprocess",
    });

    const daemon = new OvermindDaemon({ baseDir, kernel, enableHttp: false });
    await daemon.start();

    try {
      const requestBody = JSON.stringify({
        type: "mode_request",
        run_id: "run-no-such-dispatcher",
        mode: Mode.Scout,
        objective: "anything",
        workspace: tempDir,
        dispatcher_mode: "client_side",
      });
      const responseText = await sendRawSocketRequest(socketPath, requestBody);
      const response = JSON.parse(responseText) as {
        status: string;
        run_id: string;
        error: string | null;
      };
      assertEquals(response.status, "error");
      assertStringIncludes(
        String(response.error ?? ""),
        "is not available on this daemon",
      );
    } finally {
      await daemon.shutdown();
      await kernel.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "OvermindDaemon drain_dispatches queries client_side dispatcher (regression: registry default may be subprocess)",
  async () => {
    // Regression: after the dispatcher registry landed, `getDispatcher()`
    // (no mode) resolves to the registry's default — which is `subprocess`
    // when `claude` is on PATH. drain_dispatches was using that default
    // and querying subprocess's nonexistent `drainPending`, so callers
    // received empty arrays even when client_side had legitimately
    // queued dispatches for the run. Verify the handler queries
    // client_side explicitly regardless of what the default is.
    const tempDir = await Deno.makeTempDir();
    const { baseDir, socketPath } = createTestPaths(tempDir);
    await Deno.mkdir(baseDir, { recursive: true });

    // Manually queue a dispatch on the client_side dispatcher so we can
    // observe the drain returning it. We don't actually run executeScout —
    // this test is a focused unit-of-routing test.
    // The runId must be a UUID-shaped `run-<uuid>` so ClientSideDispatcher's
    // `extractRunId` regex matches and keys the queue by the run prefix
    // rather than the full agentId.
    const runId = "run-deadbeef-1234-5678-9abc-def012345678";
    const clientSide = new ClientSideDispatcher();
    await clientSide.dispatch({
      agentId: `${runId}-probe-1`,
      role: "probe" as unknown as string,
      prompt: "test",
      roomId: "room-test",
      participantId: "p1",
      workspace: tempDir,
    } as unknown as Parameters<typeof clientSide.dispatch>[0]);

    // Subprocess stub deliberately has no drainPending — proving the
    // handler doesn't accidentally pick it as the default.
    const subStub: AgentDispatcher = {
      dispatch: async () => ({ launched: true }),
      isAvailable: () => true,
    };

    const kernel = await buildTestKernel({
      dispatchers: { subprocess: subStub, client_side: clientSide },
      defaultDispatcherMode: "subprocess",
    });

    const daemon = new OvermindDaemon({ baseDir, kernel, enableHttp: false });
    await daemon.start();

    try {
      const requestBody = JSON.stringify({
        type: "drain_dispatches",
        run_id: runId,
      });
      const responseText = await sendRawSocketRequest(socketPath, requestBody);
      const response = JSON.parse(responseText) as {
        status: string;
        run_id: string;
        error: string | null;
        dispatches: unknown[];
      };
      assertEquals(response.status, "accepted");
      assertEquals(response.dispatches.length, 1);
      const drained = response.dispatches[0] as { agentId?: string };
      assertEquals(drained.agentId, `${runId}-probe-1`);
    } finally {
      await daemon.shutdown();
      await kernel.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "OvermindDaemon rejects mode_request when no kernel is wired (script-mode silent-acceptance regression)",
  async () => {
    // Covers the kernel-presence guard: a daemon without a wired kernel
    // must NOT respond status: "accepted" while skipping executeMode.
    // Without this guard the response was a successful-looking run_id
    // and zero work — exactly the silent-failure mode the refactor
    // exists to eliminate (oculus team review).
    const tempDir = await Deno.makeTempDir();
    const { baseDir, socketPath } = createTestPaths(tempDir);
    await Deno.mkdir(baseDir, { recursive: true });

    // No kernel passed to the daemon constructor.
    const daemon = new OvermindDaemon({ baseDir, enableHttp: false });
    await daemon.start();

    try {
      const requestBody = JSON.stringify({
        type: "mode_request",
        run_id: "run-no-kernel",
        mode: Mode.Scout,
        objective: "anything",
        workspace: tempDir,
      });
      const responseText = await sendRawSocketRequest(socketPath, requestBody);
      const response = JSON.parse(responseText) as {
        status: string;
        run_id: string;
        error: string | null;
      };
      assertEquals(response.status, "error");
      assertStringIncludes(
        String(response.error ?? ""),
        "kernel not available",
      );
    } finally {
      await daemon.shutdown();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

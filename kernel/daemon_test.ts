import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";

import { OvermindDaemon } from "./daemon.ts";

function createTestPaths(tempDir: string): { baseDir: string; pidPath: string; socketPath: string } {
  const baseDir = `${tempDir}/.overmind`;
  return {
    baseDir,
    pidPath: `${baseDir}/daemon.pid`,
    socketPath: `${baseDir}/daemon.sock`,
  };
}

async function sendRawSocketRequest(socketPath: string, requestBody: string): Promise<string> {
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  await conn.write(encoder.encode(requestBody));

  const buf = new Uint8Array(4096);
  const n = await conn.read(buf);
  conn.close();

  return decoder.decode(buf.subarray(0, n ?? 0));
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
    const response = JSON.parse(responseText) as { status: string; run_id: string; error: string | null };

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
    const response = JSON.parse(responseText) as { status: string; run_id: string; error: string | null };

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
    const response = JSON.parse(responseText) as { status: string; run_id: string; error: string | null };

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

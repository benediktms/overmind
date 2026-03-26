const DEFAULT_TIMEOUT_MS = 5000;

export async function readStdin(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  const chunks: Uint8Array[] = [];
  const buffer = new Uint8Array(4096);
  const decoder = new TextDecoder();

  const deadline = Date.now() + timeoutMs;

  try {
    const readableStream = Deno.stdin.readable.getReader();
    try {
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;

        const result = await Promise.race([
          readableStream.read(),
          new Promise<{ done: true; value: undefined }>((resolve) =>
            setTimeout(() => resolve({ done: true, value: undefined }), remaining)
          ),
        ]);

        if (result.done) break;
        if (result.value) chunks.push(result.value);
      }
    } finally {
      readableStream.releaseLock();
    }
  } catch {
    // Stream closed or interrupted — fall through to return what we have
  }

  if (chunks.length === 0) return "";
  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return decoder.decode(result);
}

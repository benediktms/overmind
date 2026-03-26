const DEFAULT_TIMEOUT_MS = 5000;

export async function readStdin(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    try {
      Deno.stdin.close();
    } catch {
      // Already closed
    }
  }, timeoutMs);

  try {
    const buffer = new Uint8Array(4096);
    while (true) {
      const read = await Deno.stdin.read(buffer);
      if (read === null) break;
      chunks.push(buffer.slice(0, read));
    }
  } catch {
    // stdin closed by timeout or externally
  } finally {
    if (!timedOut) clearTimeout(timer);
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

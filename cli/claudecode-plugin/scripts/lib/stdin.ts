const DEFAULT_TIMEOUT_MS = 5000;

export async function readStdin(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  const chunks: Uint8Array[] = [];
  const buffer = new Uint8Array(4096);
  const decoder = new TextDecoder();

  const timeoutId = setTimeout(() => {
    // Just stop reading after timeout - return what we have
  }, timeoutMs);

  try {
    while (true) {
      const read = await Deno.stdin.read(buffer);
      if (read === null) break;
      chunks.push(buffer.slice(0, read));
    }
  } catch {
    // Interrupted or error
  } finally {
    clearTimeout(timeoutId);
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

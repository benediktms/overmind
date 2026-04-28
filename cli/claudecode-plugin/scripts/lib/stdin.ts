const DEFAULT_TIMEOUT_MS = 5000;
// Hook payloads are tiny (tool_name + tool_input). Cap protects the Deno
// hook process against an unbounded stdin pipe (defense-in-depth — CC
// controls the pipe today, but a misconfigured wrapper or future change
// shouldn't be able to OOM the hook).
const MAX_STDIN_BYTES = 10 * 1024 * 1024;

export async function readStdin(
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_STDIN_BYTES,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let timedOut = false;
  let totalLen = 0;

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
      // Clamp the final chunk so totalLen never exceeds maxBytes by more
      // than zero. Without the clamp the cap could over-read by up to one
      // buffer (4KB), making the contract fuzzy.
      const room = maxBytes - totalLen;
      if (read > room) {
        if (room > 0) {
          chunks.push(buffer.slice(0, room));
          totalLen += room;
        }
        break;
      }
      chunks.push(buffer.slice(0, read));
      totalLen += read;
    }
  } catch {
    // stdin closed by timeout or externally
  } finally {
    if (!timedOut) clearTimeout(timer);
  }

  if (chunks.length === 0) return "";
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return decoder.decode(result);
}

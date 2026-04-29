// Per-session read-hash cache for the Overmind edit harness.
//
// Stores `{path -> {sha256, readAt, sessionId}}` so the PreToolUse hook can
// detect a stale read before an Edit/Write lands. Fail-open everywhere:
// missing file, malformed JSON, permission errors -> empty cache, no error.
//
// Cache file: ~/.claude/projects/<project-slug>/overmind/read_hashes.json
// Project-slug convention matches CC's own folder naming (replace "/" with "-",
// preserving the leading dash for absolute paths). Verified against
// `~/.claude/projects/-Users-...-overmind/`.

import { dirname, isAbsolute, join, resolve } from "@std/path";

export interface CacheEntry {
  sha256: string;
  readAt: number;
  sessionId: string;
}

export interface CacheFile {
  entries: Record<string, CacheEntry>;
}

export const DEFAULT_TTL_SECONDS = 3600;
export const DEFAULT_MAX_BYTES = 1_048_576;

export function emptyCache(): CacheFile {
  return { entries: {} };
}

export function getProjectSlug(cwd: string): string {
  // CC slug rule: replace path separators "/" and dots "." with "-". Verified
  // against real entries under `~/.claude/projects/`, e.g.
  //   /Users/benedikt.schnatterbeck/code/overmind
  //   -> -Users-benedikt-schnatterbeck-code-overmind
  // Absolute paths keep the leading dash that comes from the leading "/".
  return cwd.replaceAll("/", "-").replaceAll(".", "-");
}

export function getCachePath(cwd: string, home?: string): string {
  const homeDir = home ?? Deno.env.get("HOME") ?? "/";
  const slug = getProjectSlug(cwd);
  return join(
    homeDir,
    ".claude",
    "projects",
    slug,
    "overmind",
    "read_hashes.json",
  );
}

// 50 MB ceiling. Comfortably covers any source/text file we expect an agent
// to Edit. Larger files (binaries, dumps, multi-GB logs) skip the cache —
// returning null treats them as if no entry exists (allow), which is the
// fail-open default for the harness.
export const MAX_HASH_BYTES = 50 * 1024 * 1024;

export async function loadCache(path: string): Promise<CacheFile> {
  // Missing file is the normal cold-start case — silent.
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return emptyCache();
  }
  // A read that succeeded but doesn't parse / has the wrong shape is a real
  // signal: the file was tampered with, the schema drifted, or another tool
  // wrote there. Surface to stderr without blocking. Fail-open by design —
  // see edit-harness-spike.md "Persistence file corruption" risk row.
  try {
    const parsed = JSON.parse(text);
    if (
      parsed && typeof parsed === "object" && parsed.entries &&
      typeof parsed.entries === "object"
    ) {
      return parsed as CacheFile;
    }
    console.warn(
      `[OVERMIND] read-hash cache at ${path} has unexpected shape; treating as empty.`,
    );
    return emptyCache();
  } catch (e) {
    console.warn(
      `[OVERMIND] read-hash cache at ${path} is malformed (${
        (e as Error).message
      }); treating as empty.`,
    );
    return emptyCache();
  }
}

export async function saveCache(path: string, cache: CacheFile): Promise<void> {
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(cache));
    // Restrict to owner-only. Defends against same-user sibling agents reading
    // the path/hash inventory or forging entries to bypass staleness checks.
    // Best-effort: chmod is a no-op on Windows.
    try {
      await Deno.chmod(tmp, 0o600);
    } catch {
      // Non-POSIX or perms not supported — skip silently.
    }
    await Deno.rename(tmp, path);
  } catch {
    // Fail-open: cache writes are best-effort.
  }
}

export async function computeSha256(path: string): Promise<string | null> {
  try {
    const stat = await Deno.stat(path);
    if (!stat.isFile) return null;
    if (stat.size > MAX_HASH_BYTES) return null;
    const data = await Deno.readFile(path);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

export function upsertEntry(
  cache: CacheFile,
  path: string,
  sha256: string,
  sessionId: string,
  now = Date.now(),
): CacheFile {
  return {
    entries: {
      ...cache.entries,
      [path]: { sha256, readAt: Math.floor(now / 1000), sessionId },
    },
  };
}

export function getEntry(
  cache: CacheFile,
  path: string,
): CacheEntry | undefined {
  return cache.entries[path];
}

export function pruneStale(
  cache: CacheFile,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  now = Date.now(),
): CacheFile {
  const cutoff = Math.floor(now / 1000) - ttlSeconds;
  const fresh: Record<string, CacheEntry> = {};
  for (const [path, entry] of Object.entries(cache.entries)) {
    if (entry.readAt >= cutoff) fresh[path] = entry;
  }
  return { entries: fresh };
}

// Estimate the serialized byte cost for a single cache entry (path -> entry).
//
// JSON shape for one key-value pair inside "entries":
//   "PATH":{"sha256":"HHHH...64","readAt":NNNNNNNNN,"sessionId":"SID"}
//
// Fixed chars per entry (excluding variable parts):
//   "  "  :  {  "sha256":"  "  ,  "readAt":  ,  "sessionId":"  "  }
//   1+1+1+1+8+1+64+1+1+8+1+12+1+11+1+sid+1+1  = 114 + path.length + sid.length
// We round up to 150 to absorb readAt digit variance and any JSON encoder
// overhead. The final boundary check (one JSON.stringify) is the authoritative
// gate; this estimate only needs to be accurate enough to avoid under-evicting.
const ENTRY_FIXED_OVERHEAD = 150;

function estimateEntryBytes(path: string, entry: CacheEntry): number {
  return ENTRY_FIXED_OVERHEAD + path.length + entry.sessionId.length;
}

// Outer object framing: {"entries":{}} = 14 bytes.
const OBJECT_FRAMING = 14;

export function enforceMaxBytes(
  cache: CacheFile,
  maxBytes = DEFAULT_MAX_BYTES,
): CacheFile {
  // Fast path: skip the O(n) size estimate entirely when the cache is clearly
  // within budget. Use JSON.stringify once here (not in the loop below).
  if (JSON.stringify(cache).length <= maxBytes) return cache;

  // Sort newest-first so we keep the most recently read entries.
  const sorted = Object.entries(cache.entries).sort(
    (a, b) => b[1].readAt - a[1].readAt,
  );

  // Walk entries newest-to-oldest, accumulating a byte estimate.
  // Stop adding entries once we would exceed maxBytes. This is O(n).
  let runningBytes = OBJECT_FRAMING;
  let separatorBytes = 0; // commas between entries: first entry has none
  const kept: Array<[string, CacheEntry]> = [];
  for (const [path, entry] of sorted) {
    const cost = estimateEntryBytes(path, entry) + separatorBytes;
    if (runningBytes + cost > maxBytes) break;
    runningBytes += cost;
    separatorBytes = 1; // subsequent entries need a leading comma
    kept.push([path, entry]);
  }

  const trimmed: Record<string, CacheEntry> = Object.fromEntries(kept);

  // Single authoritative boundary check. If the estimate was generous we may
  // have kept one entry too many; drop it and re-check until we fit.
  while (
    JSON.stringify({ entries: trimmed }).length > maxBytes && kept.length > 0
  ) {
    const evicted = kept.pop()!;
    delete trimmed[evicted[0]];
  }

  return { entries: trimmed };
}

// Best-effort wrapper around Deno.realPath that never throws.
async function safeRealPath(p: string): Promise<string | null> {
  try {
    return await Deno.realPath(p);
  } catch {
    return null;
  }
}

// Canonicalize a path so cache keys agree across calls. With `cwd`,
// relative paths are resolved against the project root first — otherwise
// `Deno.realPath` would resolve against the hook process's cwd, which
// happens to match today but isn't a contract. Falls back to the input
// path on any error (missing file, permission denied) so the staleness
// check stays fail-open.
//
// Symlink containment: when `cwd` is provided we enforce that the resolved
// path stays within the cwd subtree. If `Deno.realPath` follows a symlink
// that escapes cwd (e.g. a link pointing to /etc/passwd or any path outside
// the project), we return the pre-resolution absolute path instead.
//
// Callers do NOT need to pre-resolve cwd: this function resolves cwd
// internally via safeRealPath so containment is correct even when cwd
// itself is a symlink (e.g. macOS /var/folders -> /private/var/folders).
//
// Design decision — return unresolved rather than null:
//   Returning null would cause the harness to treat the path as "no entry
//   exists" (fail-open), which silently skips the staleness check for
//   symlink targets. Returning the unresolved absolute path means the cache
//   key is the symlink itself, not its target; the staleness check still fires
//   for the symlink inode. This is marginally less accurate (two symlinks
//   pointing to the same file get separate entries) but safe: it preserves
//   the fail-open invariant without silently bypassing the check.
export async function resolvePathSafely(
  path: string,
  cwd?: string,
): Promise<string> {
  if (!path) return path;
  const absolute = isAbsolute(path) || !cwd ? path : resolve(cwd, path);
  try {
    const real = await Deno.realPath(absolute);
    // Containment check: if a cwd was given and the resolved path escapes it,
    // fall back to the unresolved absolute path so the cache key stays within
    // the project. A trailing separator is added to cwdReal to avoid false
    // matches where cwd is a strict prefix of an unrelated sibling directory
    // (e.g. cwd=/foo matching /foobar/...).
    // cwdReal resolves cwd itself through any symlinks so the comparison
    // works correctly even when cwd is a symlink (e.g. macOS
    // /var/folders -> /private/var/folders).
    if (cwd) {
      const cwdReal = (await safeRealPath(cwd)) ?? cwd;
      if (!real.startsWith(cwdReal + "/") && real !== cwdReal) {
        return absolute;
      }
    }
    return real;
  } catch {
    return absolute;
  }
}

const TRANSIENT_PREFIXES = [
  "/tmp/",
  "/var/folders/",
  "/private/tmp/",
  "/private/var/folders/",
];

export function isTransientPath(
  path: string,
  cacheDir?: string,
  cwd?: string,
): boolean {
  if (!path) return true;
  // Files inside the active project (cwd) are never transient, even if cwd
  // happens to live under /tmp or /var/folders (common in tests, occasionally
  // in scratch projects).
  if (cwd && path.startsWith(cwd)) return false;
  for (const prefix of TRANSIENT_PREFIXES) {
    if (path.startsWith(prefix)) return true;
  }
  if (path.includes("/.git/")) return true;
  if (cacheDir && path.startsWith(cacheDir)) return true;
  return false;
}

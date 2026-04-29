import { dirname } from "@std/path";

export interface LockEntry {
  readonly path: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly acquiredAt: string;
}

export type LockHolder = Pick<LockEntry, "sessionId" | "agentId">;

// Discriminated union so the HTTP layer can distinguish capacity exhaustion
// (no holder, no contention — the registry is full) from a real cross-agent
// conflict. The previous shape conflated both as `{ok: false}` which the
// hook client could only treat as "kernel unavailable" — masking a real
// operational signal behind the same fail-open status.
export type AcquireResult =
  | { readonly ok: true }
  | {
    readonly ok: false;
    readonly holder: LockHolder;
    readonly reason?: undefined;
  }
  | {
    readonly ok: false;
    readonly holder?: undefined;
    readonly reason: "capacity";
  };

export type AcquireInput = Omit<LockEntry, "acquiredAt">;

// Cap the in-memory lock map so a misbehaving (or malicious) localhost caller
// cannot OOM the kernel by spamming /lock with unique paths. 10k locks is far
// above any plausible legitimate working set; agents typically hold <50 at
// once.
const MAX_LOCKS = 10_000;

interface JournalEvent {
  readonly ts: string;
  readonly kind: "acquired" | "released";
  readonly entry: LockEntry;
}

// Resolve symlinks and `.`/`..` segments so two agents posting different
// representations of the same physical file (e.g. macOS `/var/folders` vs
// `/private/var/folders`, a workspace symlink, or `./foo` vs `foo`) collide
// on a single map key. Falls back to the caller's path only when the target
// does not exist yet — a Write that creates a new file legitimately fails
// realPath with NotFound, and the lock-before-create case must remain
// fail-open. Other realPath errors (ELOOP, EACCES, etc.) propagate so the
// HTTP layer surfaces a 500 rather than silently defeating normalization
// (e.g. an ELOOP fallback would let a symlink loop bypass the very
// collision detection this exists to provide). Sync to preserve the
// LockRegistry's "no await before map mutation" atomicity invariant.
function normalizePath(path: string): string {
  try {
    return Deno.realPathSync(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return path;
    throw err;
  }
}

/**
 * Per-session file lock store. Owner identity is `(sessionId, agentId)` from
 * CC's hook payload; re-entrant when both match, conflict when either differs.
 * Every transition is appended to a JSONL journal so the registry can be
 * rebuilt on kernel restart. Synchronous map mutation runs before any await,
 * so concurrent acquire/release calls are race-free without an explicit mutex.
 */
export class LockRegistry {
  private readonly locks = new Map<string, LockEntry>();
  private appendQueue: Promise<void> = Promise.resolve();
  private journalDirReady = false;

  constructor(private readonly journalPath: string) {}

  async load(): Promise<void> {
    this.locks.clear();
    let content: string;
    try {
      content = await Deno.readTextFile(this.journalPath);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return;
      throw err;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let event: JournalEvent;
      try {
        event = JSON.parse(line) as JournalEvent;
      } catch {
        console.warn(
          `LockRegistry: skipping malformed journal line: ${
            line.slice(0, 120)
          }`,
        );
        continue;
      }
      const entry = event.entry;
      if (!entry?.path || !entry.sessionId || !entry.agentId) continue;
      // Replay paths verbatim. Pre-normalization journals may contain
      // non-canonical paths; those become orphans because new acquires
      // normalize and won't match the legacy keys. The orphans cannot cause
      // false conflicts (different keys), only consume cap slots until the
      // journal is compacted (deferred to ovr-396.23.10).
      if (event.kind === "acquired") {
        this.locks.set(entry.path, entry);
      } else if (event.kind === "released") {
        const current = this.locks.get(entry.path);
        if (
          current &&
          current.sessionId === entry.sessionId &&
          current.agentId === entry.agentId
        ) {
          this.locks.delete(entry.path);
        }
      }
    }
  }

  async acquire(input: AcquireInput): Promise<AcquireResult> {
    const normalizedPath = normalizePath(input.path);
    const existing = this.locks.get(normalizedPath);
    if (
      existing &&
      (existing.sessionId !== input.sessionId ||
        existing.agentId !== input.agentId)
    ) {
      return {
        ok: false,
        holder: {
          sessionId: existing.sessionId,
          agentId: existing.agentId,
        },
      };
    }
    if (!existing && this.locks.size >= MAX_LOCKS) {
      return { ok: false, reason: "capacity" };
    }
    const entry: LockEntry = {
      ...input,
      path: normalizedPath,
      acquiredAt: new Date().toISOString(),
    };
    this.locks.set(normalizedPath, entry);
    await this.appendEvents([{
      ts: entry.acquiredAt,
      kind: "acquired",
      entry,
    }]);
    return { ok: true };
  }

  async release(
    path: string,
    sessionId: string,
    agentId: string,
  ): Promise<boolean> {
    const normalizedPath = normalizePath(path);
    const existing = this.locks.get(normalizedPath);
    if (!existing) return true;
    if (existing.sessionId !== sessionId || existing.agentId !== agentId) {
      return false;
    }
    this.locks.delete(normalizedPath);
    await this.appendEvents([{
      ts: new Date().toISOString(),
      kind: "released",
      entry: existing,
    }]);
    return true;
  }

  async releaseAllForSession(sessionId: string): Promise<number> {
    const targets: LockEntry[] = [];
    for (const entry of this.locks.values()) {
      if (entry.sessionId === sessionId) targets.push(entry);
    }
    if (targets.length === 0) return 0;
    for (const entry of targets) {
      this.locks.delete(entry.path);
    }
    const now = new Date().toISOString();
    await this.appendEvents(
      targets.map((entry) => ({ ts: now, kind: "released" as const, entry })),
    );
    return targets.length;
  }

  snapshot(): readonly LockEntry[] {
    return Array.from(this.locks.values());
  }

  private appendEvents(events: readonly JournalEvent[]): Promise<void> {
    // Chain journal writes so concurrent acquire/release calls cannot produce
    // torn JSONL lines via interleaved file appends.
    const next = this.appendQueue.then(async () => {
      if (!this.journalDirReady) {
        await Deno.mkdir(dirname(this.journalPath), { recursive: true });
        this.journalDirReady = true;
      }
      const payload = events.map((e) => `${JSON.stringify(e)}\n`).join("");
      await Deno.writeTextFile(this.journalPath, payload, {
        append: true,
        create: true,
      });
    });
    this.appendQueue = next.catch(() => {});
    return next;
  }
}

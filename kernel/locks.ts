import { dirname } from "@std/path";

export interface LockEntry {
  readonly path: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly acquiredAt: string;
}

export type LockHolder = Pick<LockEntry, "sessionId" | "agentId">;

export interface AcquireResult {
  readonly ok: boolean;
  readonly holder?: LockHolder;
}

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
    const existing = this.locks.get(input.path);
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
      return { ok: false };
    }
    const entry: LockEntry = {
      ...input,
      acquiredAt: new Date().toISOString(),
    };
    this.locks.set(input.path, entry);
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
    const existing = this.locks.get(path);
    if (!existing) return true;
    if (existing.sessionId !== sessionId || existing.agentId !== agentId) {
      return false;
    }
    this.locks.delete(path);
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

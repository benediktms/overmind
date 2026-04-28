# Edit Harness and Safe Write Contract

## Summary

Wrap Claude Code's built-in `Edit` and `Write` so every agent edit either lands on the file version the agent saw or fails loudly with a structured re-plan signal. Two independent mechanisms compose: a **per-session read-fingerprint cache** in the existing PreToolUse / PostToolUse hooks (catches stale-context overwrites within one CC session), and a **per-task file lock** served by the kernel (catches cross-agent races in swarm and team modes). Bash writes get a defense-in-depth warning. Ship behind `OVERMIND_EDIT_HARNESS=1` for one release cycle, default-on after the soak.

**Key Goals:**
- Agents keep using `Edit` / `Write` — no new MCP tool, no agent-catalog rewrites.
- Stale reads fail closed with `{ continue: false, stopReason: "..." }` so CC surfaces a re-plan prompt to the agent.
- Swarm / team teammates cannot silently race on the same file.
- The whole subsystem can be turned off with one env var while it bakes.

**Risk:** Medium | **Dependencies:** spike `ovr-396.17` design source (`docs/edit-harness-spike.md`); kernel currently exposes only a Unix socket — milestones M3+ stand up a new HTTP listener for lock endpoints.

---

## Current State vs Desired State

### Current State

```
  Agent (drone / weaver / evolver / scribe / guardian)
        |
        | Edit / Write tool call
        v
  Claude Code built-ins
   - Edit:  must Read in this session, old_string unique
   - Write: must Read existing files first
        |
        v   PreToolUse hook
  cli/claudecode-plugin/scripts/pre-tool-enforcer.ts (~91 lines)
   - Bash danger patterns (rm -rf /, fork-bomb, ...)
   - .env path warn
   - NO hash check, NO lock check
        |
        v   tool runs
        v   PostToolUse hook
  post-tool-verifier.ts (~200 lines)
   - Pattern-matches result string for "error", "failed", ...
   - Best-effort POST to OVERMIND_KERNEL_HTTP_URL/event (no listener yet)
   - Reactive: cannot detect silent stale-overwrite
        |
        v
  File written. Lead has no protocol-level guarantee about staleness.

  Cross-agent races: only mitigated by skill prose
  ("teammate must git status before claiming") — kernel does not enforce.
```

**Limitations:**
- An agent that reads at t=0, plans for 10 minutes, edits at t=10 — and another writer mutated the file at t=5 — produces a silent merge. CC's "must Read first" guard does not check freshness.
- Two parallel teammates whose file scopes drift into the same path overwrite each other; the only defense is the prose pre-claim check in `drone.md` / `weaver.md` / `team-build.md`.
- `Write` replaces the current file unconditionally once the read-precondition is met; growth between read and write is invisible.
- Bash writes (`sed -i`, `>`, `>>`) bypass the harness entirely and never will be fully covered — but today there is not even a warning surface.
- The kernel does not run an HTTP server. Existing scripts (`post-tool-verifier`, `session-start`, `pre-compact`, ...) already POST to `OVERMIND_KERNEL_HTTP_URL` but those calls silently fail; no module listens on `:8080`.

### Desired State

```
  Agent (drone / weaver / evolver / scribe / guardian)
        |
        | Edit / Write tool call
        v
  Claude Code built-ins (unchanged contract)
        |
        v   PreToolUse hook (extended)
  pre-tool-enforcer.ts
   1. OVERMIND_EDIT_HARNESS=1 ?  no -> existing behavior, exit
   2. tool != Edit/Write/Bash ?  -> existing behavior, exit
   3. Read fingerprint cache (per-session JSON):
        ~/.claude/projects/<slug>/overmind/read_hashes.json
      a. compute sha256(file) NOW
      b. cache entry?
            yes & match  -> step 4
            yes & differ -> { continue: false,
                              stopReason: "Stale read detected. ..." }
            no entry     -> step 4 (CC's own Read-first guard still runs)
   4. Per-task lock probe (kernel HTTP, non-blocking, fail-open if kernel down):
        POST <OVERMIND_KERNEL_HTTP_URL>/lock { path, taskId, agentId }
            200 ok / lock held by same task -> proceed
            409 conflict (lock held by other task) -> { continue: false, ... }
            network error -> additionalContext warn, proceed
   5. Bash matcher: sed -i / awk -i / >|>> on a hash-cached path ->
        warn-only [OVERMIND SAFETY] note (do not block)
        |
        v   tool runs
        v   PostToolUse hook (extended)
  post-tool-verifier.ts
   - Read success         -> refresh cache entry { sha256, readAt, sessionId }
   - Edit/Write success   -> refresh cache entry to post-write sha256
   - Cache rotation: prune stale entries (>1h), rebuild file if >1MB
        |
        v
  File written. Cache + lock guarantee freshness for every harness-covered edit.

                              kernel
                              +---------------------------------+
                              |  Unix socket (existing)         |
                              |  HTTP listener  (NEW, M3+)      |
                              |   POST /lock    POST /unlock    |
                              |   POST /event   (existing       |
                              |                  silent route)  |
                              |  LockRegistry (in-memory map +  |
                              |   journal via persistence.ts)   |
                              |  Auto-release on cancel/close   |
                              |   (CancellationRegistry hook)   |
                              +---------------------------------+
```

**Benefits:**
- Stale-context overwrites are caught with no agent change — the agent sees a structured stop reason and re-reads.
- Swarm / team races are caught at the kernel, not by hope-and-pray skill prose.
- Bash slips get a visible diagnostic without the false-positive cost of blocking.
- The opt-in flag means we land code without changing any agent's runtime behavior on day one.
- The new HTTP listener also retrofits the silent `/event` POSTs the rest of the plugin already issues.

---

## Why This Change?

### Business Impact

Today the only thing keeping concurrent edits safe is that most CC sessions serialize through one main agent. The moment swarm / team modes scale, that invariant breaks and we lose work. The harness raises the contract from "usually fine" to "fail loudly when wrong," which is the prerequisite for trusting parallel agents on production-shaped code.

### Technical Motivation

- The hook extension reuses an existing surface (`pre-tool-enforcer.ts`, `post-tool-verifier.ts`) instead of adding a new MCP edit tool — no need to retool every agent definition under `cli/claudecode-plugin/agents/`.
- The lock endpoints give the kernel a first piece of HTTP surface that the rest of the plugin's `OVERMIND_KERNEL_HTTP_URL` traffic (events, session start/end, pre-compact) can also benefit from.
- Hash-anchored read-modify-write is the standard pattern across Aider, Copilot Workspace, MorphLLM, and VS Code LSP versioned documents — this aligns Overmind with that convergence.

---

## Architecture Design

### Interaction between hash-cache (B) and locks (D)

These are **independent mechanisms with different scopes**. The order of checks in `pre-tool-enforcer.ts` is load-bearing:

```
Edit / Write PreToolUse:

  1. env gate           OVERMIND_EDIT_HARNESS=1 ?  no -> exit early
  2. path filter        skip transient paths (/tmp, /var, .git/objects, ...)
  3. hash check         intra-session staleness   <- B
  4. lock check         cross-agent race          <- D
  5. existing checks    .env warn, .env.example allow
```

**Rationale for the order:**
- Hash check is local (filesystem only) and cheap (sha256 of a source file is microseconds). Run it first so the kernel never sees a request for a file that's already stale.
- Lock check is a network call. It must run after the hash check so that a stale-reading agent doesn't burn a lock acquisition slot only to immediately reject. It also must run after the env gate because lock semantics are off when the harness is off.
- A failure at step 3 returns the **stale-read** stop reason. A failure at step 4 returns the **lock-conflict** stop reason. Never combined — the messages target different agent responses (re-read vs. wait/yield).

**Independence:**
- Hash cache works in scout / relay / swarm / team / one-off. It is purely per-session and per-path.
- Locks are no-ops in scout / relay (single-writer modes) — the lock endpoint accepts but treats the call as a successful no-op when the kernel sees the run's mode is single-writer. They are active in swarm and team.

### Read-fingerprint cache shape

Per-session JSON, per project, lazily created:

```
~/.claude/projects/<project-slug>/overmind/read_hashes.json

{
  "/abs/path/to/file.ts": {
    "sha256": "abc...",
    "readAt": 1714291200,
    "sessionId": "session-abc"
  },
  ...
}
```

Refresh / invalidation rules:
- `Read` PostToolUse (success) -> upsert entry with current sha256.
- `Edit` / `Write` PostToolUse (success) -> upsert entry with the new content's sha256.
- Entry is forgotten if `now - readAt > 3600s` (1 h TTL).
- File is rotated (oldest entries dropped) when its size crosses 1 MB.
- Parse failure -> treat as empty cache, log a one-line warn, proceed (fail-open).

The cache is keyed by absolute path. Symlinks are resolved with `Deno.realPath` before lookup.

### Lock semantics

In-memory map plus journal:

```
LockRegistry  (kernel/locks.ts, NEW)

  Map<absolutePath, LockEntry>
  LockEntry: { taskId, agentId, runId, acquiredAt }

  acquire(path, taskId, agentId, runId):
    no entry              -> insert, journal `lock_acquired`, return ok
    same taskId           -> refresh acquiredAt, return ok (re-entrant)
    different taskId      -> return conflict { holder: { taskId, agentId } }

  release(path, taskId):
    entry & same taskId   -> delete, journal `lock_released`, return ok
    entry & wrong taskId  -> return error (do not steal)
    no entry              -> return ok (idempotent)

  releaseAllForRun(runId):
    delete every entry whose runId matches; journal each.
```

Persistence: append a JSONL journal next to existing run journals, e.g. `~/.overmind/state/locks/<runId>.jsonl`, mirroring the `appendJournal` pattern in `kernel/persistence.ts:267`. On kernel restart the registry rebuilds by replaying the journal until either `lock_released` or a run-finish event clears it. Crashes leave stale entries; the TTL at the registry level (default 30 min) reaps them.

Auto-release wiring: in `kernel/kernel.ts` the cancellation path (`Kernel.cancelRun`, calls `CancellationRegistry.cancel`) gains a hook that calls `lockRegistry.releaseAllForRun(runId)`. The same call is added to the run-completion path so a clean finish frees its locks.

### HTTP listener

The kernel currently runs only a Unix socket (`kernel/daemon.ts`). The hook scripts already point at `OVERMIND_KERNEL_HTTP_URL` (default `http://localhost:8080`) but no listener answers; calls fail silently. M3 stands up a `Deno.serve` listener inside the kernel process that:

```
POST /lock      { path, taskId, agentId, runId }       -> 200 / 409
POST /unlock    { path, taskId }                       -> 200
POST /event     existing best-effort drop (kept idempotent so plugin
                scripts that already POST events do not break)
```

Bound to localhost-only by default. Port is `OVERMIND_KERNEL_HTTP_PORT` (default 8080) so tests can pick a free port. The listener lifecycle is owned by the daemon: `OvermindDaemon.start` brings it up, `OvermindDaemon.shutdown` tears it down. The existing `OvermindDaemonOptions` interface gains a `httpPort?` field.

### Complete flow (swarm two-agent example)

```
  Lead spawns drone-A (taskId=T1) and drone-B (taskId=T2)

  drone-A          drone-B          pre-tool-enforcer       LockRegistry
  Read foo.ts                                              {}
  hash=H1          hash=H1          cache[foo.ts]=H1
                   Read foo.ts
                                    cache[foo.ts]=H1       (already)

  Edit foo.ts                       sha(foo.ts)=H1 ok      acquire(foo.ts, T1, A)
                                                           => ok
                                    proceed
                                    PostToolUse: cache[foo.ts]=H2

                   Edit foo.ts      sha(foo.ts)=H1
                                    cache says H1, file=H2
                                    => stale detected, reject
                                    { continue: false,
                                      stopReason:
                                        "Stale read detected ..." }

                   (drone-B's CC surfaces stop reason; drone-B re-reads,
                    finds H2, retries Edit)

                   Edit foo.ts      sha(foo.ts)=H2 ok      acquire(foo.ts, T2, B)
                                                           => 409 conflict
                                                              holder=T1
                                    => { continue: false,
                                         stopReason:
                                           "File locked by task T1
                                            (agent A). Pick another
                                            file or wait." }

  Task T1 closes -> kernel calls releaseAllForRun -> foo.ts unlocked.

                   Edit foo.ts      ok                      acquire ok
                                    PostToolUse: cache[foo.ts]=H3
```

Both stale-read and lock-conflict produce structured `stopReason` text the agent can act on. The agent role prompts (M5) tell teammates how to respond.

---

## Implementation Milestones

### Milestone 1: Read-fingerprint cache + stale-write rejection (env-gated, hooks only)

**Deliverable:** With `OVERMIND_EDIT_HARNESS=1`, every `Edit` / `Write` PreToolUse compares a fresh sha256 of the target against a per-session cache populated by `Read` / `Edit` / `Write` PostToolUse, and rejects with a structured stop reason on mismatch. No kernel changes. Single-PR landable.

**What we'll build:**
- New module `cli/claudecode-plugin/scripts/lib/read_hash_cache.ts`:
  - `getCachePath(sessionId): string` — resolves `~/.claude/projects/<slug>/overmind/read_hashes.json`. Project slug derived from `Deno.cwd()` the same way CC derives it (replace `/` with `-`, strip leading dash).
  - `loadCache(path): Promise<CacheFile>` — read + JSON.parse; on any error return `{ entries: {} }` (fail-open).
  - `saveCache(path, cache): Promise<void>` — atomic write via `Deno.writeTextFile` to `${path}.tmp` then `Deno.rename`.
  - `computeSha256(path): Promise<string | null>` — null when file is missing / unreadable.
  - `upsertEntry`, `getEntry`, `pruneStale(ttlSeconds=3600)`, `enforceMaxBytes(maxBytes=1_048_576)`.
  - `resolvePathSafely(path)` — `Deno.realPath` with fallthrough.
- Extend `cli/claudecode-plugin/scripts/pre-tool-enforcer.ts`:
  - Read `OVERMIND_EDIT_HARNESS` from env at top of `main`. If unset / not "1", behavior is unchanged (existing `.env` and Bash danger checks still run).
  - Add `session_id` / `sessionId` and `cwd` / `directory` to `HookData`. Mirror `post-tool-verifier.ts:11-23`.
  - For `Edit` / `Write`: extract `file_path`. Skip transient paths (`/tmp`, `/var/folders`, paths inside `.git/`, paths under the cache dir itself). Compute sha256 now. Look up cache entry. On mismatch, output `{ "continue": false, "stopReason": "Stale read detected. <path> changed since you last read it. Re-read the file before editing." }`. On match or absent entry, fall through to existing behavior.
  - Output shape change: introduce a `outputDeny(reason: string)` helper that prints `{ continue: false, stopReason }`. Reuse the existing `outputHookResult` for the allow / warn paths.
- Extend `cli/claudecode-plugin/scripts/post-tool-verifier.ts`:
  - On `Read` success, on `Edit` success, on `Write` success: call `upsertEntry` with the post-state sha256. Existing message-generation logic is untouched — the cache update is additive and runs before the message generator.
  - The pattern-matchers `detectWriteFailure` and `detectBashFailure` are the success / failure signal. Only refresh the cache when `tool_response` does **not** match `WRITE_ERROR_PATTERNS`.

**Key files:**
- Create: `cli/claudecode-plugin/scripts/lib/read_hash_cache.ts` — the cache module described above.
- Create: `cli/claudecode-plugin/scripts/lib/read_hash_cache_test.ts` — unit tests, see below.
- Modify: `cli/claudecode-plugin/scripts/pre-tool-enforcer.ts` — env gate, session/cwd parsing, harness branch for Edit/Write, transient-path skip list, deny output helper. Add at the top of `main` after parsing `data`. Keep existing branches unchanged.
- Modify: `cli/claudecode-plugin/scripts/post-tool-verifier.ts:164-198` — after `getToolOutputAsString`, branch on `toolName` to refresh the cache when the tool succeeded. Done before the existing `processRememberTags` call so cache writes are not blocked by remember-tag work.
- Create: `cli/claudecode-plugin/scripts/pre-tool-enforcer_test.ts` — does not exist today (only `post-tool-verifier_test.ts` does). Mirror that test's stdin-piping pattern.

**Tests added:**
- `read_hash_cache_test.ts`: load missing file -> empty cache; load malformed -> empty cache + warn; upsert + retrieve; pruneStale removes expired entries; enforceMaxBytes drops oldest entries; computeSha256 of known fixture matches expected digest.
- `pre-tool-enforcer_test.ts`:
  - Harness off (`OVERMIND_EDIT_HARNESS` unset): Edit on a stale file returns `{ continue: true }`.
  - Harness on, no cache entry: Edit returns `{ continue: true }`.
  - Harness on, cache match: Edit returns `{ continue: true }`.
  - Harness on, cache mismatch: Edit returns `{ continue: false, stopReason: /Stale read detected/ }`.
  - Harness on, transient path (`/tmp/x`): Edit returns `{ continue: true }` even with mismatch (transient skip).
  - Harness on, missing file: Edit returns `{ continue: true }` (fail-open; CC will surface its own error).
  - Bash danger pattern still blocked when harness is on (existing test parity).
- `post-tool-verifier_test.ts`: extend with cases for cache refresh on `Read`, `Edit`, `Write` success; no refresh on detected error patterns.

**Acceptance criteria:**
- All existing scout / relay / swarm tests pass unchanged with `OVERMIND_EDIT_HARNESS=0` and with the variable unset.
- With `OVERMIND_EDIT_HARNESS=1`, two manual repro steps in the M1 PR description succeed:
  1. `Read` a file, externally `echo>>` to it, `Edit` it -> stop reason surfaces.
  2. `Read` a file, `Edit` it twice -> first edit applies, cache refreshes, second edit applies cleanly.
- `deno check cli/claudecode-plugin/scripts/pre-tool-enforcer.ts` and `post-tool-verifier.ts` clean.

**Risks specific to M1:**
- Project-slug derivation. The cache directory path must match what CC itself uses for `~/.claude/projects/<slug>/`, otherwise the cache leaks across projects. Mitigation: derive from `Deno.cwd()` and add a unit test fixture verifying against a known-good slug; document the derivation rule in a comment.
- `session_id` may not be present in PreToolUse payloads on older CC builds. Mitigation: when missing, fall back to a `default` session bucket — the cache still works per-cwd; document in the PR that pre-merge we have verified the field is present in the CC version we ship.
- Cache file growth. The 1 MB cap is the only bound. Mitigation: prune-on-read at the top of every PreToolUse / PostToolUse handler before the lookup / update.

---

### Milestone 2: Bash defense-in-depth warning (hook only, low risk)

**Deliverable:** When the harness is on and a Bash command appears to write to a hash-cached path, the agent receives a `[OVERMIND SAFETY]` `additionalContext` note. Warn-only, never blocks.

**What we'll build:**
- Extend the `case "Bash":` branch in `pre-tool-enforcer.ts` (currently lines 50-65). After the existing dangerous-pattern check, parse the command for:
  - `sed -i` / `sed -i'...'` / `sed --in-place`
  - `awk -i ...`
  - Output redirection to a file: `>`, `>>`, `1>`, `2>`, `&>` followed by a path (use a permissive regex; we are warning, not blocking).
  - `tee path` (writes to its arg).
- Resolve each candidate path against the read-hash cache. If any path has an entry, append:
  > "[OVERMIND SAFETY] Bash write detected on a hash-cached path: `<path>`. The edit harness will not see it. Prefer `Edit` / `Write`, or `Read` the file again afterwards to refresh the cache."
- Multiple paths -> single message, comma-separated.

**Key files:**
- Modify: `cli/claudecode-plugin/scripts/pre-tool-enforcer.ts:50-65` — extend the existing Bash branch. Reuse the cache loader from M1.
- Modify: `cli/claudecode-plugin/scripts/pre-tool-enforcer_test.ts` — add cases for each pattern (cached path, uncached path, mixed).

**Tests added:**
- `Bash` with `sed -i 's/x/y/' cached.ts` -> warn note containing `cached.ts`.
- `Bash` with `echo hi > /tmp/scratch` (uncached) -> no harness note (existing behavior preserved).
- `Bash` with `cat foo.ts > bar.ts` where both cached -> note lists both.
- `Bash` with combined danger + cache hit -> existing danger note wins (we keep one note per call).

**Acceptance criteria:**
- Warn-only — `continue: true` in every test.
- No false-block surfaces when M1 tests are re-run.

**Risks specific to M2:**
- Bash command surface is too varied to parse perfectly. False negatives are accepted (the spike's threat-model line is "warn, do not block"). False positives are merely noisy and recoverable.

---

### Milestone 3: Kernel HTTP listener + LockRegistry (no hook integration yet)

**Deliverable:** The kernel daemon listens on `http://localhost:<port>/lock` and `/unlock`, persists lock state via a journal, releases a run's locks on cancel / completion, and is exercised by direct kernel tests. Hooks do not call it yet.

**What we'll build:**
- New module `kernel/locks.ts`:
  ```ts
  export interface LockEntry {
    path: string;
    taskId: string;
    agentId: string;
    runId: string;
    acquiredAt: string;
  }
  export interface AcquireResult {
    ok: boolean;
    holder?: Pick<LockEntry, "taskId" | "agentId" | "runId">;
  }
  export class LockRegistry {
    constructor(private readonly journalPath: string);
    async load(): Promise<void>;
    acquire(input: Omit<LockEntry, "acquiredAt">): Promise<AcquireResult>;
    release(path: string, taskId: string): Promise<boolean>;
    releaseAllForRun(runId: string): Promise<number>;
    snapshot(): readonly LockEntry[];
  }
  ```
  Journal format mirrors `kernel/persistence.ts:267-275` (JSONL append, never rewrite). Each event is `{ ts, kind: "acquired" | "released", entry }`.
- New module `kernel/http.ts`:
  - `OvermindHttpServer` class with `start(port)` / `shutdown()`.
  - Routes: `POST /lock`, `POST /unlock`, `POST /event` (existing event drop, kept idempotent so no plugin script changes are needed).
  - Body parsing with size cap (matches the 1 MB cap in `daemon.ts:516`).
  - Localhost-only bind by default. Configurable via `OVERMIND_KERNEL_HTTP_BIND` (default `127.0.0.1`).
- Wire into `kernel/daemon.ts`:
  - Add `httpPort?: number` to `OvermindDaemonOptions` (current shape at `daemon.ts:12`). Default port `8080` to match existing `OVERMIND_KERNEL_HTTP_URL` defaults across the plugin.
  - Bring up the HTTP server in `OvermindDaemon.start` after the Unix listener.
  - Tear down in `shutdown`.
- Wire into `kernel/kernel.ts`:
  - Inject the `LockRegistry` instance into the kernel.
  - In `cancelRun(runId)` (post-call), invoke `lockRegistry.releaseAllForRun(runId)`.
  - In the run-completion path (`PersistenceCoordinator.completeRun` / `failRun` / `cancelRun`), call `releaseAllForRun` once. The kernel emits these terminal states already; the addition is one extra await per terminal transition.

**Key files:**
- Create: `kernel/locks.ts`
- Create: `kernel/locks_test.ts`
- Create: `kernel/http.ts`
- Create: `kernel/http_test.ts`
- Modify: `kernel/daemon.ts` — `OvermindDaemonOptions`, `start`, `shutdown`. Constructor accepts `httpPort`. Start the HTTP server after the Unix socket so failures there do not strand the socket.
- Modify: `kernel/kernel.ts` — inject `LockRegistry`, call `releaseAllForRun` on cancel and completion paths.
- Modify: `kernel/integration_test.ts` — extend the existing daemon-startup helper to also start the HTTP listener on a free port for the new test.

**Tests added:**
- `locks_test.ts`:
  - acquire on empty -> ok.
  - acquire with same taskId twice -> ok, second refreshes `acquiredAt`.
  - acquire with different taskId -> conflict; holder fields populated.
  - release with matching taskId -> ok.
  - release with mismatching taskId -> error (no steal).
  - releaseAllForRun frees only entries with that runId.
  - load() rebuilds in-memory state from a journal containing acquire-then-release pairs (released entries do not reappear).
- `http_test.ts`: spin up `OvermindHttpServer` on a free port, exercise `/lock` (200 / 409) and `/unlock` (200) round-trips, verify body validation rejects malformed payloads with 400.
- `kernel/integration_test.ts`: new test "swarm cancel releases locks" — open a swarm run, acquire two locks via the HTTP endpoint, cancel the run, assert `lockRegistry.snapshot()` returns no entries with that runId.

**Acceptance criteria:**
- All existing daemon / mode tests pass — the HTTP server is additive.
- Lock journal survives a kernel restart (manual `daemon stop && daemon start`, locks reload).
- `deno check kernel/{locks,http,daemon,kernel}.ts` clean.

**Risks specific to M3:**
- Port 8080 collision. Mitigation: the env var `OVERMIND_KERNEL_HTTP_PORT` overrides; tests pick a free port via `Deno.listen({ port: 0 })`.
- HTTP server lifecycle entanglement with the Unix daemon. Mitigation: HTTP server failures do not abort the daemon; failures log and continue. The Unix path is the source of truth for the daemon's running state.
- Journal corruption on partial write. Mitigation: load tolerates malformed lines (skip with a warn). A truly broken journal still leaves the in-memory registry empty; locks self-heal as runs cancel / complete.

---

### Milestone 4: Hook -> kernel lock check (cross-agent race coverage)

**Deliverable:** With `OVERMIND_EDIT_HARNESS=1`, `Edit` / `Write` PreToolUse posts a non-blocking lock acquire to the kernel and rejects with a structured stop reason on conflict. Mode is auto-detected — locks are no-ops in scout / relay.

**What we'll build:**
- Add `OVERMIND_KERNEL_HTTP_URL` reading to `pre-tool-enforcer.ts` (mirrors the constant at `post-tool-verifier.ts:9-10`).
- Add `OVERMIND_TASK_ID`, `OVERMIND_AGENT_ID`, `OVERMIND_RUN_ID`, and `OVERMIND_MODE` to `setup.md`'s required-env-vars list (M5). Hooks read these from `Deno.env`.
- New helper in `cli/claudecode-plugin/scripts/lib/lock_client.ts`:
  - `tryAcquire({ url, path, taskId, agentId, runId, mode, timeoutMs=300 })`.
  - Skip immediately when `mode` is `scout` or `relay` (single-writer modes).
  - `fetch` with `AbortSignal.timeout(timeoutMs)`. On 200 -> ok. On 409 -> conflict + parsed holder. On any other / network error -> open (return `{ status: "kernel_unavailable" }`).
- In `pre-tool-enforcer.ts`, after the M1 hash check passes, call `tryAcquire`. On conflict, emit `{ continue: false, stopReason: "File locked by task <taskId> (agent <agentId>). Pick another file or wait." }`. On `kernel_unavailable`, emit a one-line `additionalContext` warning ("Lock check skipped: kernel unreachable") and proceed.
- The hook does **not** call `/unlock`. Locks release on run completion / cancel (M3). This is intentional — `Edit` / `Write` is granular; per-edit unlock would thrash the journal and not match the per-task semantic.

**Key files:**
- Create: `cli/claudecode-plugin/scripts/lib/lock_client.ts`
- Create: `cli/claudecode-plugin/scripts/lib/lock_client_test.ts`
- Modify: `cli/claudecode-plugin/scripts/pre-tool-enforcer.ts` — add the lock-check call after the hash-check, before the existing `.env` warn. Pull env via a small helper to keep `main` flat.
- Modify: `cli/claudecode-plugin/scripts/pre-tool-enforcer_test.ts` — mock `fetch`-style behavior or stand up a mini HTTP server in-test (Deno makes this cheap) for the kernel reachable / unreachable / 409 paths.

**Tests added:**
- `lock_client_test.ts`: scout mode short-circuits; swarm mode 200 returns ok; 409 returns conflict; timeout returns `kernel_unavailable`; malformed body returns `kernel_unavailable`.
- `pre-tool-enforcer_test.ts`: with kernel mock returning 409, Edit returns `{ continue: false, stopReason: /File locked by task/ }`. With kernel mock unreachable, Edit returns `{ continue: true }` plus a warn `additionalContext`.

**Acceptance criteria:**
- All existing tests pass.
- New integration test in `kernel/integration_test.ts` ("swarm two-agent race"): start a daemon with HTTP, open a swarm run, simulate two PreToolUse calls for the same path with different taskIds — first wins with 200, second gets 409. Cancel the run, repeat — both succeed (locks freed).

**Risks specific to M4:**
- Kernel unavailable during a real run. Mitigation: fail-open — agents continue to write. The hash check from M1 still runs and catches intra-session staleness. Document this clearly in M5 skill prose.
- Latency. The lock POST is on the critical path of every `Edit` / `Write`. Mitigation: 300 ms timeout, localhost network, fail-open. Worst case the agent writes without the lock check, which matches today's behavior.
- Mode detection. The hook does not know its run's mode. Mitigation: `OVERMIND_MODE` env var is set by the kernel when it spawns subagents (this becomes a small contract in M5; in scout / relay it is set to those values, in swarm / team it is set to `swarm` / `team`). When unset, the hook treats the call as `swarm` (safe default — runs the lock check; never causes data loss).

---

### Milestone 5: Skill / agent guidance + setup wiring

**Deliverable:** `drone`, `weaver`, `evolver`, `team-build`, and `setup` skills document the new contract. `setup.md` lists `OVERMIND_EDIT_HARNESS=1` as the opt-in env var. Agents know how to react to stale-read and lock-conflict stop reasons.

**What we'll build:**
- Update `cli/claudecode-plugin/skills/drone.md`: in the "When to stop and ask" section, add a bullet: "If `Edit` / `Write` returns a stale-read error, **re-read the file and re-plan**. Do not retry blindly — the file changed under you. Mention the path in your next message to the lead." Also add a bullet under "File ownership rules": "If `Edit` returns `File locked by task <T>`, you raced another teammate. Send `kind: question` to the lead with the path; the lock will free when that task closes."
- Update `cli/claudecode-plugin/skills/weaver.md`: same two bullets. Refactors are uniquely conflict-prone.
- Update `cli/claudecode-plugin/agents/evolver.md` — note: the user task referred to `cli/claudecode-plugin/skills/evolver.md`, but that file lives under `agents/` (`cli/claudecode-plugin/skills/` does not contain `evolver.md` today). Update the file at the correct path.
- Update `cli/claudecode-plugin/skills/team-build.md`: in `<file_ownership>`, add: "Lock semantics: when the harness is on, the kernel rejects `Edit` from a teammate whose taskId does not hold the lock. A teammate that hits a lock conflict sends `kind: question` — respond by reassigning, not by removing the lock."
- Update `cli/claudecode-plugin/skills/setup.md`:
  - Add `OVERMIND_EDIT_HARNESS` (optional, "1" enables the harness) to required env vars list.
  - Add `OVERMIND_TASK_ID`, `OVERMIND_AGENT_ID`, `OVERMIND_RUN_ID`, `OVERMIND_MODE` (set by the kernel when spawning subagents — present at runtime, not configured by the user).
  - Add a validation step: "If `OVERMIND_EDIT_HARNESS=1`, probe `${OVERMIND_KERNEL_HTTP_URL}/lock` with a no-op acquire and release for path `/dev/null`, taskId `setup-probe`. Expect 200. Failure surfaces as a setup error."

**Key files:**
- Modify: `cli/claudecode-plugin/skills/drone.md`
- Modify: `cli/claudecode-plugin/skills/weaver.md`
- Modify: `cli/claudecode-plugin/agents/evolver.md` (correct location; not `skills/`)
- Modify: `cli/claudecode-plugin/skills/team-build.md`
- Modify: `cli/claudecode-plugin/skills/setup.md`

**Tests added:**
- None directly. The `installer_test.ts` should verify the env vars are surfaced — extend if a regression of the env var list is plausible.

**Acceptance criteria:**
- A teammate reading any one of the modified skills can reason about both error modes (stale read, lock conflict) without reading the spike.
- `setup.md` lets a user enable the harness with one shell line.

**Risks specific to M5:**
- Skills are prose; the only failure is silence. Mitigation: M5 lands together with the integration tests in M4 — the cross-agent race test is the actual contract.

---

### Milestone 6: Default-on flip and soak retrospective

**Deliverable:** After one release cycle of soak with `OVERMIND_EDIT_HARNESS=1` opt-in, flip the default in `pre-tool-enforcer.ts` and `post-tool-verifier.ts` from "off unless 1" to "on unless 0". Update setup docs.

**What we'll build:**
- Change the env-gate helper from `=== "1"` to `!== "0"`.
- Update `setup.md`: harness is enabled by default; document `OVERMIND_EDIT_HARNESS=0` as the kill switch.
- Soak retrospective note in the M6 PR: lock-conflict counts, stale-read counts, false-positive rate (manual sample of 20 hits), kernel-unavailable rate.

**Key files:**
- Modify: `cli/claudecode-plugin/scripts/pre-tool-enforcer.ts`
- Modify: `cli/claudecode-plugin/scripts/post-tool-verifier.ts`
- Modify: `cli/claudecode-plugin/scripts/lib/lock_client.ts` (if env-default lives here)
- Modify: `cli/claudecode-plugin/skills/setup.md`

**Tests added:** Update existing tests for the inverted default. No new tests.

**Acceptance criteria:**
- At least one full release cycle has passed with M1-M5 shipped behind the flag.
- No open bug filed against the harness with severity above "annoying" during soak.
- The retrospective is committed as a brief note alongside the PR.

**Risks specific to M6:**
- Some unknown-unknown failure surfaces only at default-on scale. Mitigation: keep `OVERMIND_EDIT_HARNESS=0` as the kill switch; document its effect; the inversion is one env var away from being undone.

---

## Rollout

Behind the env var `OVERMIND_EDIT_HARNESS`. Read in three places, each fail-closed (off by default):

| Surface | Where | Behavior when flag is off |
|---|---|---|
| `pre-tool-enforcer.ts` | top of `main`, after `JSON.parse` | Skip hash check, skip lock check. Existing `.env` and Bash danger checks still run. |
| `post-tool-verifier.ts` | top of `main`, after `JSON.parse` | Skip cache refresh. Existing remember-tag and message-generation logic still runs. |
| `kernel/http.ts` | per-route handler | `/lock` and `/unlock` accept the request, journal nothing, return 200 with `{ harness: "off" }`. The hook treats this as `kernel_unavailable` -> open. |

The kernel-side fail-shape matters: even if the hook is off and the kernel is on, or vice versa, the system still allows writes — there is never a state where the harness blocks an agent that the operator did not opt into.

M6 inverts the gate to default-on. The kill switch (`OVERMIND_EDIT_HARNESS=0`) keeps the same three early-outs.

---

## Success Criteria

- A `Read` followed by an external `echo>>` followed by an `Edit` produces a stop reason that mentions "stale", with the harness on. Fixed: never silent.
- Two parallel teammates in a swarm with overlapping file scope: the second `Edit` against a contested path produces a stop reason mentioning the holder taskId / agentId, with the harness on. Fixed: kernel-enforced, not skill-enforced.
- A `Read` followed by a `Bash` `sed -i` on the same file emits the `[OVERMIND SAFETY]` note in `additionalContext`. Warn-only, never blocks.
- The harness off (env unset) leaves all existing scout / relay / swarm / setup tests passing unchanged.
- Kernel daemon stop -> all in-memory locks gone; restart replays journals; locks reflect last persisted state.
- Run cancellation (existing `CancellationRegistry.cancel`) clears every lock owned by that run.
- `deno check` passes across all new and modified modules.

---

## Risks and Unknowns

- **Hook reliability across `/clear`, `/compact`, agent spawn boundaries.** The hash cache is keyed by `sessionId`; `/clear` and `/compact` may or may not preserve it across CC's internal state. Open question: does CC pass the same `session_id` to PreToolUse before and after `/compact`? Mitigation: log the sessionId in the cache file and emit a one-line warn when a tool call arrives with a sessionId we have not seen before. If the answer is "session changes," the cache is empty after `/compact` and the harness fails open until the agent's next `Read` repopulates it. That is a soft regression, not a correctness violation.
- **Agent spawn boundary.** When the lead spawns a subagent, does CC propagate the parent's `session_id` to the subagent? If not, the cache is per-subagent. That is correct semantically — the subagent has its own read history — but it means cross-agent staleness still relies on the lock check (D), not the hash check (B). This is acceptable; the spike's threat model already separates the two.
- **Kernel unreachable.** When the kernel HTTP listener is down, `tryAcquire` returns `kernel_unavailable` and the hook fails open. Stale-read protection (B) still works because it is local. Cross-agent race protection (D) is offline. Mitigation: `setup.md` validates the kernel is reachable; missing `OVERMIND_KERNEL_HTTP_URL` is surfaced at setup time, not at first Edit.
- **Lock journal bloat.** Long-running runs with many locks accumulate journal lines. Mitigation: rotate per-run journal at run completion (already aligned with `kernel/persistence.ts`'s per-run journal pattern). Snapshot the registry on cleanup so the next start does not replay every historical lock.
- **`OVERMIND_MODE` env-var contract.** The hook needs to know whether it is in scout / relay (skip lock) or swarm / team (run lock). The kernel does not currently propagate a mode env var to subagents. Open question: where does the kernel set this? Likely in the agent dispatcher (`kernel/agent_dispatcher.ts`). M4 must include this wiring; if it slips, the hook defaults to "run the lock check" which is safe for swarm and a pure no-op overhead for scout / relay (the kernel will accept and ignore in single-writer mode if we add that branch in `LockRegistry.acquire`).
- **Project-slug derivation drift.** If CC changes how it slugifies `cwd` for `~/.claude/projects/`, the cache directory diverges. Mitigation: one source-of-truth function in `read_hash_cache.ts` plus a fixture-based test; the rest of the codebase already encodes assumptions about this directory and breaks together if CC changes.
- **Bash false negatives.** `eval`, here-docs, indirect command construction, third-party tools that write files (e.g. formatters invoked through Bash) all bypass the warning. The contract is "warn, do not block" — false negatives are accepted by design.
- **False positives on benign external edits.** A formatter, an LSP code-action, the user's IDE — any of these can rewrite a file between read and edit. The harness will reject the next `Edit`. Mitigation: the agent's response is "re-read and re-plan," which is correct in every case. The cost is one wasted plan iteration. Document this in `drone.md`.

---

## Out of Scope

- **Transactional change-sets (Option C from the spike).** Whole-batch rollback, change-set staging in a worktree, `git apply --3way` semantics — all deferred to a separate v2 ADR. The v1 contract is intentionally local and stateless beyond the per-session cache and the per-run lock journal.
- **Bash blocking beyond the warning.** The Bash matcher emits `[OVERMIND SAFETY]` and does not return `continue: false`. Bash command surface is too varied for safe blocking; the contract is warn-only.
- **Cross-session and cross-machine coordination.** The hash cache is per-session and per-host. Two CC sessions on the same machine reading the same file each maintain their own cache. Locks are kernel-side and shared within one kernel process; multi-kernel coordination is not designed.
- **Diff-based edits.** The harness wraps the existing `Edit` anchored-string shape. We do not introduce a unified-diff edit primitive; LLMs are unreliable at producing clean diffs.
- **Rollback / undo of applied edits.** Once an `Edit` succeeds and the cache refreshes, there is no built-in undo. Lives in change-set v2 territory.
- **Replacing CC's `Edit` with an MCP tool (Option A).** Removing `Edit` from every subagent's `tools:` list under `cli/claudecode-plugin/agents/` is a wide cross-cut. The hook approach gets ~90% of the protection for ~10% of the effort. Reconsider when transactional change-sets are on the table.
- **Per-edit unlock.** Locks are per-task (acquired on first hit, released on run completion / cancel). Per-edit unlock would thrash the journal and create release-storm windows where a fast follow-up edit by another agent could slip through. Per-task semantics are intentional.

---

## Related Work

- Spike: `docs/edit-harness-spike.md` (ovr-396.17) — full design, threat model, four-option survey, decision log.
- Brain task: ovr-396.23 — implementation task this plan delivers.
- Existing planning style reference: `src/plannings/neural-link-coordination/plan.md` — mirrors this plan's milestone structure.
- Adjacent kernel work: `kernel/persistence.ts` — journal pattern reused for lock persistence.
- Adjacent kernel work: `kernel/cancellation.ts` — `CancellationRegistry.cancel` is the auto-release trigger for locks.
- Verification pipeline: `docs/verification-pipeline-spike.md` — stale-read errors will eventually integrate with the verification pipeline; out of scope for this plan.

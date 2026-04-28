# Lock Contract Redesign and Hook Integration

## Summary

Replace the shipped M3 cross-agent lock contract — keyed on `{path, taskId, agentId, runId}` — with one keyed on `{path, sessionId, agentId}`. The `runId` half of the original contract has no producer in the hook process today, so M4 as originally planned would emit dead code: locks would be acquired with no run identity, and `LockRegistry.releaseAllForRun` would never match anything in production. CC's hook payload already carries `session_id` and `agentId` (it powers the M1 read-hash cache), so the lock owner becomes the same identity tuple the hash cache uses, with auto-release pinned to the existing CC `SessionEnd` hook. M4 then lands on top of this new contract: the hook posts `{path, sessionId, agentId}` to `/lock`, blocks on 409, fails open on timeout, and is mode-gated via `OVERMIND_MODE`.

**Key Goals:**
- Make the cross-agent lock layer actually exercised in production today, without waiting for a future concrete `AgentDispatcher` that injects per-run env vars.
- Reuse the identity tuple the M1 hash cache already trusts (`session_id` + `agentId` from CC's hook stdin).
- Keep the parent plan's milestones M5 (skill prose) and M6 (default-on flip) intact, only with a smaller env-var surface.
- Net change is two single-PR milestones, ~300 lines each.

**Risk:** Medium | **Dependencies:** parent plan (`src/plannings/edit-harness/plan.md`), shipped M3 (`3f0fee5`, `ff5da10`); same `OVERMIND_EDIT_HARNESS=1` flag, same soak window before M6 flips the default.

---

## Current State vs Desired State

### Current State (after `3f0fee5` + `ff5da10`)

```
  pre-tool-enforcer.ts (PreToolUse)
   1. OVERMIND_EDIT_HARNESS gate  (kernel/locks.ts -> harness_config.ts)
   2. Hash check                  (M1, fully wired)
   3. Lock check                  (NOT wired — no producer for runId)
        |
        v
  No POST to /lock from any hook today.

  kernel/http.ts
   POST /lock    requires { path, taskId, agentId, runId }
   POST /unlock  requires { path, taskId }
   POST /event   best-effort drop

  kernel/locks.ts
   LockEntry: { path, taskId, agentId, runId, acquiredAt }
   acquire(input)            re-entrant on taskId match
   release(path, taskId)
   releaseAllForRun(runId)   <- only auto-release path

  kernel/kernel.ts
   cancelRun(runId)          -> lockRegistry.releaseAllForRun(runId)
   executeModeImpl finally   -> lockRegistry.releaseAllForRun(runId)

  kernel/agent_dispatcher.ts
   Interface only. NoopDispatcher and MockDispatcher do not spawn anything.
   No concrete dispatcher exists in the tree (verified by grep — only
   Deno.Command call in the kernel is daemon.ts:520, spawning the daemon
   itself as a subprocess).

  CC subagent processes
   Launched independently of the kernel. Inherit no OVERMIND_RUN_ID,
   OVERMIND_TASK_ID, or OVERMIND_AGENT_ID env vars unless an operator
   sets them by hand. The hook process (Deno.env.get(...)) sees nothing.
```

**Limitations:**
- The hook has no way to populate `runId`. Whatever it sends will not match any kernel-tracked run, so `releaseAllForRun(runId)` will never reach a lock created by the hook.
- `taskId` is similarly unsourced — the hook payload from CC carries `session_id` and `agentId`, not a task id.
- `cancelRun(runId)` calling `releaseAllForRun(runId)` is dead code in the production path: no entry was ever created with the matching `runId`. `executeModeImpl finally` has the same issue.
- The contract is testable only via direct kernel tests (and that is exactly what `kernel/locks_test.ts` and `kernel/http_test.ts` do today). It is not exercised end-to-end.
- Shipping M4 on top would make it look like the lock layer is enforcing safety in swarm/team modes when it isn't. Worst-case shape: present in code, not running.

### Desired State

```
  pre-tool-enforcer.ts (PreToolUse)
   1. OVERMIND_EDIT_HARNESS gate
   2. Hash check                        (M1, unchanged)
   3. Mode gate                         (skip lock check for scout/relay)
   4. Lock check via lock_client        (POST /lock with sessionId+agentId)
   5. existing checks (.env warn, Bash) (unchanged)
        |
        v
  CC writes (or does not). Cache refresh on PostToolUse (unchanged).

  kernel/http.ts
   POST /lock                  { path, sessionId, agentId }   -> 200 / 409
   POST /unlock                { path, sessionId }            -> 200
   POST /release-session-locks { sessionId }                  -> 200 (NEW)
   POST /event                 best-effort drop (unchanged)

  kernel/locks.ts
   LockEntry: { path, sessionId, agentId, acquiredAt }
   acquire(input)                  re-entrant on (sessionId, agentId) match
   release(path, sessionId)        steals refused if sessionId differs
   releaseAllForSession(sessionId) <- new auto-release path

  kernel/kernel.ts
   cancelRun(runId)            no longer fans out to lock release.
                               Cancel cascade reaches CC sessions via
                               existing channels; they fire SessionEnd
                               and the hook releases. Eventual, not
                               immediate.

  cli/.../scripts/session-end.ts
   POST /release-session-locks { sessionId }   <- new call, alongside
                                                 the existing /event POST
```

**Benefits:**
- The lock owner is the identity tuple CC already provides on every hook invocation. No new producer, no env var contract, no dependency on a concrete dispatcher.
- The auto-release path runs in production today: every CC session ends, fires `SessionEnd`, and the hook posts a release. No dead code.
- Run cancellation still releases locks — just via the cascade (kernel cancel -> mode executor winds down -> orchestrator's CC session ends -> SessionEnd hook -> /release-session-locks). Eventual, but covered.
- The wire format change is explicit: tests for the old four-field shape are deleted and rewritten, so reviewers see the contract change in the diff rather than reading shape-compatible adapters.

---

## Why This Change?

### Business Impact

The shipped M3 advertises swarm/team race protection but, with the original M4 plan, would not deliver it. Teammates would still race on files because the lock the kernel records will be discarded by `releaseAllForRun` invocations whose `runId` matches nothing the hook produced. The redesign turns the lock layer from "ships, never runs" into "ships, runs every swarm/team session." That is a step-change in trust for parallel agent runs on shared files — the explicit goal of the parent plan.

### Technical Motivation

- **Reuse existing identity.** The M1 hash cache (`cli/claudecode-plugin/scripts/lib/read_hash_cache.ts`) already trusts CC's `session_id` from hook stdin. Pinning the lock's owner to the same identity makes both layers fail in the same direction (same agent, same session = re-entrant; different session = conflict).
- **Drop a phantom contract.** `OVERMIND_TASK_ID` and `OVERMIND_RUN_ID` would be env vars the kernel was supposed to set when spawning subagents — but the kernel does not spawn subagents (verified: `kernel/agent_dispatcher.ts` is interface-only, the only `Deno.Command` use in `kernel/daemon.ts:520` spawns the daemon itself). Cutting the dependency is cheaper than building it.
- **Match CC's lifecycle.** `SessionEnd` fires every time, including on `/clear`, `/compact`, kernel-side cancel cascades, and ordinary user shutdown. It is the one event we can rely on across all run modes.

---

## Architecture Design

### Lock owner identity

The new tuple is `(sessionId, agentId)`:

- `sessionId` — CC's stable hook payload field (`data.session_id`, mirrored as `data.sessionId`). The M1 hash cache already keys on it (`post-tool-verifier.ts:222`). Constant for the life of one CC session.
- `agentId` — CC's hook payload `agentId` field (also normalized as `agent_type` in some payload shapes — see `subagent-coordinator.ts:43`). For lead agents it is the lead's identifier; for subagents it is the subagent name (`drone-1`, `weaver-2`, ...). Constant for the life of one subagent process.

A lock is re-entrant when **both** match. Anything else is a conflict — different session (different process), different agentId in the same session (subagent vs lead), or different session and different agent (cross-run race).

### Auto-release strategy: SessionEnd, not run cancel

The kernel can no longer auto-release directly because it does not own a `runId -> sessionId` map. The new strategy is the cascade:

```
  kernel.cancelRun(runId)
     |
     v
  CancellationRegistry.cancel signals the run
     |
     v
  Mode executor's loop checks signal, exits, finally runs (no lock release)
     |
     v
  Orchestrator's CC session is the run's outermost actor; it ends when
  the mode executor's neural_link traffic stops (existing behavior).
     |
     v
  CC fires SessionEnd hook for that session
     |
     v
  cli/.../scripts/session-end.ts
     POST /release-session-locks { sessionId }
     |
     v
  LockRegistry.releaseAllForSession(sessionId)
```

The cascade is **eventual**. A tight-loop racer between cancel and the next session's first edit could in principle slip through. In practice the gap is bounded by the SessionEnd hook firing within CC's tear-down window (single-digit seconds). Documented as a known property in the parent plan's risk section, not a regression: the shipped M3 had no end-to-end auto-release at all, since the runId path was dead.

### Cancellation also calls releaseAllForSession defensively

To shrink the eventual window for the kernel-knows-the-session case, `cancelRun` and `executeModeImpl finally` keep a best-effort hook: if the kernel has tracked a `(runId -> sessionId)` map for the orchestrator's session (filled when the orchestrator first POSTs `/lock`), it calls `releaseAllForSession(sessionId)` immediately. If no mapping exists (the run never acquired a lock), the call is a no-op and the SessionEnd cascade is the sole release path.

The session-id map is populated only by `/lock` calls. It is best-effort and bounded — a `Map<runId, Set<sessionId>>` cleared on `releaseAllForRun` (renamed below) or on registry restart. Lock data is unchanged on restart; the map rebuilds lazily as new locks come in.

This keeps the immediate-release intent of the original plan for the kernel-tracked path, while making SessionEnd the canonical correctness path.

### HTTP wire format diff

```
old:  POST /lock                  { path, taskId, agentId, runId }
      POST /unlock                { path, taskId }
new:  POST /lock                  { path, sessionId, agentId }
      POST /unlock                { path, sessionId }
      POST /release-session-locks { sessionId }

old conflict body:  { ok: false, holder: { taskId, agentId, runId } }
new conflict body:  { ok: false, holder: { sessionId, agentId } }
```

`/event` is unchanged. The 1 MB body cap, Host-header DNS-rebinding defense, and 405/404/400 responses in `kernel/http.ts:74-122` are unchanged.

### Two-agent swarm flow (revised)

```
  Lead spawns drone-A (sessionId=S1, agentId=A) and drone-B (S2, B)
  Both run under one swarm run R via the orchestrator's CC session S0.

  drone-A          drone-B          pre-tool-enforcer       LockRegistry
  Read foo.ts                                              {}
  hash=H1                            cache[foo.ts]=H1
                   Read foo.ts
                                    cache[foo.ts]=H1       (already)

  Edit foo.ts                       sha(foo.ts)=H1 ok      acquire(foo.ts, S1, A)
                                                           => ok
                                    proceed
                                    PostToolUse: cache[foo.ts]=H2

                   Edit foo.ts      sha(foo.ts)=H1
                                    cache says H1, file=H2
                                    => stale detected, reject (M1)

                   (drone-B re-reads, finds H2, retries)

                   Edit foo.ts      sha(foo.ts)=H2 ok      acquire(foo.ts, S2, B)
                                                           => 409 conflict
                                                              holder={S1, A}
                                    => { continue: false,
                                         stopReason:
                                           "File locked by agent A in
                                            session S1. Pick another
                                            file or wait." }

  drone-A's CC session ends -> SessionEnd hook fires
   POST /release-session-locks { sessionId: S1 }
                                                           freed: foo.ts

                   Edit foo.ts      sha(foo.ts)=H2 ok      acquire(foo.ts, S2, B)
                                                           => ok
                                    proceed
```

---

## Implementation Milestones

### Milestone 3-redesign: New lock contract on `(sessionId, agentId)` (single PR, lands first)

**Deliverable:** `LockRegistry`, `OvermindHttpServer`, kernel auto-release wiring, and `session-end.ts` all speak the new four-tuple-replaced-with-three-tuple contract. All tests for the old shape are deleted and rewritten — no shape-compatible adapters. End-to-end auto-release demonstrated by a new integration test that drives the full SessionEnd cascade.

**What we'll build:**

- Rewrite `kernel/locks.ts`:
  - `LockEntry`: `{ path, sessionId, agentId, acquiredAt }`. Drop `taskId` and `runId`.
  - `LockHolder`: `Pick<LockEntry, "sessionId" | "agentId">`.
  - `AcquireInput`: `Omit<LockEntry, "acquiredAt">`.
  - `acquire(input)`: re-entrant when **both** `sessionId` and `agentId` match; conflict when either differs. Holder shape mirrors the new pick.
  - `release(path, sessionId)`: refuse-to-steal stays — mismatching sessionId returns false.
  - **Replace** `releaseAllForRun(runId)` with `releaseAllForSession(sessionId)`. Same JSONL journal pattern; events keyed by sessionId in the released entries.
  - `MAX_LOCKS = 10_000` cap and append-queue serialization in `kernel/locks.ts:23-25, 141-156` are unchanged.
- Rewrite `kernel/http.ts`:
  - `isAcquireBody` (`http.ts:234-241`): require `path`, `sessionId`, `agentId` as non-empty strings.
  - `isReleaseBody` (`http.ts:243-247`): require `path`, `sessionId`.
  - Add `handleReleaseSessionLocks` for `POST /release-session-locks` with body `{ sessionId }`. Returns `{ ok: true, freed: <count> }`. When the harness is off, returns `{ ok: true, harness: "off" }` like the other routes (`http.ts:126-130`).
  - Conflict body returns `{ ok: false, holder: { sessionId, agentId } }`.
- Rewire `kernel/kernel.ts`:
  - `cancelRun(runId)` (`kernel.ts:117-129`): drop the direct `releaseAllForRun` call. Optionally call `releaseAllForSession` for any session ids the kernel has seen for this run via the new run-to-session map (see "Cancellation also calls releaseAllForSession defensively" above). Document inline that the canonical release is the SessionEnd cascade.
  - `executeModeImpl finally` (`kernel.ts:224-240`): same change. Direct `releaseAllForRun` call deleted; replace with optional `releaseAllForSession` over the run's known session ids. Failure logs and continues.
  - Add `LockRegistry.recordSessionForRun(runId, sessionId)` invoked by the `/lock` route handler (in `http.ts`, after a successful acquire). The map is in-memory only; no journal entry. On `releaseAllForSession` the map's entries for that sessionId are cleared.
- Rewire `cli/claudecode-plugin/scripts/session-end.ts`:
  - After the existing `notifyKernel("session_end", ...)` call (`session-end.ts:48-52`), add a second POST to `${OVERMIND_KERNEL_HTTP_URL}/release-session-locks` with body `{ sessionId }`, gated on `isHarnessEnabled()` (import from `lib/harness_config.ts` like the other scripts) and a non-empty sessionId. Network errors swallow silently — the hook must never fail an exit. Use `AbortSignal.timeout(500)` so a stuck kernel can't extend session teardown.
- Rewrite `kernel/locks_test.ts`:
  - Delete the existing nine tests that assert the `taskId`/`runId` contract (`locks_test.ts:17-286`). Replace with the new shape:
    - acquire on empty -> ok.
    - acquire with same `(sessionId, agentId)` twice -> ok, second refreshes `acquiredAt`.
    - acquire with same sessionId, different agentId -> conflict (subagent vs lead in one CC session).
    - acquire with different sessionId, same agentId -> conflict (two CC sessions sharing a name like `drone-1`).
    - release with matching sessionId -> ok.
    - release with mismatching sessionId -> error.
    - releaseAllForSession frees only the matching sessionId's entries.
    - load() rebuilds in-memory state from a journal of acquire-then-release pairs.
    - load tolerates a malformed line.
    - acquire honors the 10k cap.
- Rewrite `kernel/http_test.ts`:
  - Replace every test using `taskId`/`runId` (`http_test.ts:48-463`). Mirror the structure: 200, 409 with new holder shape, malformed-JSON 400, missing-fields 400, oversized 413, DNS-rebinding 403, harness-off 200+harness:off, 500 leak protection.
  - Add a `POST /release-session-locks` test: pre-load three locks (two for sessionId=S1, one for S2), POST `{ sessionId: "S1" }`, assert response `{ ok: true, freed: 2 }` and registry snapshot has only the S2 entry.
  - Add a `POST /release-session-locks` with malformed body returns 400.
- Update `kernel/integration_test.ts`:
  - Extend `createHarness` (`integration_test.ts:164-194`) with no surface change — the daemon already starts the HTTP listener (`daemon.ts:186-189`), and the kernel attaches the registry (`daemon.ts:246`).
  - New test "swarm cancel triggers session-end release": acquire two locks via the HTTP endpoint with different sessionIds, simulate the SessionEnd hook by POSTing `/release-session-locks` for one sessionId, assert that registry only retains the other sessionId's locks. This stand-in proves the wire path; full kernel-cancel-cascade is impractical to test without a real CC binary.

**Key files:**
- Modify: `kernel/locks.ts` — LockEntry shape, acquire/release semantics, `releaseAllForRun -> releaseAllForSession` (replacement, not addition).
- Modify: `kernel/http.ts` — body validators, conflict holder shape, new `/release-session-locks` route. Constants and security defenses (`http.ts:1-10, 74-122`) unchanged.
- Modify: `kernel/kernel.ts` — drop direct `releaseAllForRun` calls in `cancelRun` and `executeModeImpl finally`. Add the run-to-session map population from the HTTP server side. Optional `releaseAllForSession` over known sessions on cancel.
- Modify: `kernel/daemon.ts` — no changes; wiring already in place (`daemon.ts:236-249`).
- Modify: `cli/claudecode-plugin/scripts/session-end.ts` — new POST `/release-session-locks` after the existing `/event` notify call.
- Rewrite: `kernel/locks_test.ts` — every test updated to the new shape; old shape tests deleted in the same PR so reviewers see the contract diff.
- Rewrite: `kernel/http_test.ts` — same.
- Modify: `kernel/integration_test.ts` — new "session-end release" test.

**Acceptance criteria:**
- `deno check kernel/{locks,http,kernel,daemon}.ts` and `deno check cli/claudecode-plugin/scripts/session-end.ts` clean.
- `deno test kernel/locks_test.ts kernel/http_test.ts kernel/integration_test.ts` passes.
- All existing scout / relay / swarm tests in `kernel/integration_test.ts` (`integration_test.ts:202-660`) continue passing — the wire-format change is invisible to them because they do not call `/lock`.
- A reviewer reading the M3-redesign PR sees the deletion of every `taskId`/`runId` reference in `locks.ts`, `http.ts`, and the corresponding tests. No grep hits for `runId` or `taskId` remain in `kernel/locks.ts`, `kernel/http.ts`, `kernel/locks_test.ts`, or `kernel/http_test.ts`.
- New integration test confirms `/release-session-locks` empties the right rows.
- Net diff approximately 300 lines (mostly mechanical rename + test rewrite).

**Risks specific to M3-redesign:**
- **Forgotten consumer of the old shape.** The old contract leaked into a script or doc that grep does not catch (e.g., a markdown sample). Mitigation: a final pre-merge grep across `cli/`, `kernel/`, and `docs/` for `taskId` and `OVERMIND_RUN_ID`; anything that survives is renamed or deleted.
- **Run-to-session map drift.** The optional kernel-side immediate-release path needs the map to be cleared correctly. If a sessionId is never released the map grows unbounded. Mitigation: cap the map at the same 10k limit as the registry, evict oldest on insert overflow; and clear on `releaseAllForSession`. If the cap fires we lose the optional fast path but never miss a SessionEnd-driven release, which is the canonical path.
- **SessionEnd timing.** Eventual release is a behavior change from the original "immediate on cancel" plan. Documented as expected. The window is bounded by CC's SessionEnd hook latency.

---

### Milestone 4 (revised): Hook -> kernel lock check using sessionId+agentId (single PR, lands second)

**Deliverable:** With `OVERMIND_EDIT_HARNESS=1`, `Edit` / `Write` PreToolUse posts a non-blocking `/lock` call to the kernel using the sessionId and agentId from CC's hook stdin. 200 -> proceed. 409 -> deny with structured stop reason. Network error / timeout / unreachable -> fail open with a `[OVERMIND SAFETY]` `additionalContext` note. Mode-aware: scout / relay short-circuit before the network call. Demonstrated end-to-end by a swarm two-agent race integration test in `kernel/integration_test.ts`.

**What we'll build:**

- New helper `cli/claudecode-plugin/scripts/lib/lock_client.ts`:
  - Single export `tryAcquire({ url, path, sessionId, agentId, mode, timeoutMs = 300 })`.
  - Skip path: when `mode === "scout"` or `mode === "relay"`, return `{ status: "skipped" }` immediately. No network call.
  - `fetch(${url}/lock, { method: "POST", body: JSON.stringify({path, sessionId, agentId}), signal: AbortSignal.timeout(timeoutMs) })`.
  - Response handling:
    - 200 -> `{ status: "ok" }`.
    - 409 -> parse `holder` field; return `{ status: "conflict", holder }`. Bad/missing holder body -> degrade to `{ status: "kernel_unavailable" }`.
    - Any other status / network error / timeout / non-JSON body -> `{ status: "kernel_unavailable" }`.
  - No retries. The 300 ms cap is one-shot — repeating would push the total budget past the PreToolUse hook's 3 s timeout in `cli/claudecode-plugin/hooks/hooks.json:51`.
- Update `cli/claudecode-plugin/scripts/pre-tool-enforcer.ts`:
  - Read `OVERMIND_KERNEL_HTTP_URL` (default `http://localhost:8080`) and `OVERMIND_MODE` (no default — undefined means "run the lock check"; safe for swarm/team).
  - Extend `HookData` (`pre-tool-enforcer.ts:27-34`) with `session_id` / `sessionId`, `agentId` / `agent_type`. Mirror `post-tool-verifier.ts:24-37`.
  - In `evaluateHarness` (`pre-tool-enforcer.ts:343-382`), after the staleness decision returns `allow`, call `tryAcquire`. Use `data.session_id ?? data.sessionId ?? "default"` for `sessionId` (matching the M1 cache fallback at `post-tool-verifier.ts:222`) and `data.agentId ?? data.agent_type ?? "unknown"` for `agentId` (matching `subagent-coordinator.ts:43`).
  - On `{ status: "conflict", holder }`: deny with `"File locked by agent ${holder.agentId} in session ${holder.sessionId}. Pick another file or wait."`.
  - On `{ status: "kernel_unavailable" }`: allow with an `additionalContext` warn `[OVERMIND SAFETY] Lock check skipped: kernel unreachable. Cross-agent race protection is offline; the hash check still applies.`
  - On `{ status: "ok" }` or `{ status: "skipped" }`: allow silently.
  - The hook does not call `/unlock`. Per-edit unlock is intentional non-behavior — release happens on SessionEnd (M3-redesign).
- Mode propagation:
  - `OVERMIND_MODE` is set by setup (`cli/claudecode-plugin/skills/setup.md`; see M5 in parent plan) for operators who run mode-pinned shells. When unset, the hook treats the call as eligible for the lock check.
  - We do not require the kernel to inject `OVERMIND_MODE` into subagent processes — that was the producer-shaped contract that motivated the redesign in the first place. Documented in M5.
- Test: `cli/claudecode-plugin/scripts/lib/lock_client_test.ts`:
  - Scout mode short-circuits — no fetch call (verified by injecting a mock `globalThis.fetch` that throws).
  - Relay mode short-circuits — same.
  - Swarm mode + 200 -> `ok`.
  - Swarm mode + 409 with `{ holder: { sessionId, agentId } }` -> `conflict` with the holder.
  - Swarm mode + 409 with malformed body -> `kernel_unavailable`.
  - Network error (mock fetch throws) -> `kernel_unavailable`.
  - Timeout (mock fetch hangs longer than `timeoutMs`) -> `kernel_unavailable`. Use a small `timeoutMs` (e.g. 50 ms) for test speed.
  - Unset / unknown mode -> runs the check (proves the safe default).
- Test: extend `cli/claudecode-plugin/scripts/pre-tool-enforcer_test.ts`:
  - Stand up a real `OvermindHttpServer` from `kernel/http.ts` on a free port (mirrors `kernel/http_test.ts:13-33`'s pattern). Cheap in Deno.
  - Harness on, hash check passes, lock returns 200 -> `{ continue: true }` with no warn.
  - Harness on, hash check passes, kernel pre-loaded with a conflicting lock -> `{ continue: false, stopReason: /File locked by agent .* in session/ }`.
  - Harness on, hash check passes, kernel unreachable (use a closed port) -> `{ continue: true }` with `additionalContext` containing `Lock check skipped`.
  - Harness on, mode `scout` -> `{ continue: true }`, no fetch made (server records zero `/lock` POSTs).
  - Harness on, mode `relay` -> same.
  - Harness off -> existing behavior; no fetch made.
- Test: extend `kernel/integration_test.ts`:
  - New test "swarm two-agent race via HTTP": create the harness, POST `/lock` from two simulated agents with different sessionIds for the same path. First gets 200, second gets 409 with the first's holder. POST `/release-session-locks` for the first sessionId; second agent's retry gets 200.

**Key files:**
- Create: `cli/claudecode-plugin/scripts/lib/lock_client.ts`
- Create: `cli/claudecode-plugin/scripts/lib/lock_client_test.ts`
- Modify: `cli/claudecode-plugin/scripts/pre-tool-enforcer.ts` — `HookData` extension; lock-client invocation after `evaluateHarness` staleness check; `outputAllow` already supports `additionalContext` (`pre-tool-enforcer.ts:51-62`); deny output uses the existing `outputDeny` helper (`pre-tool-enforcer.ts:64-66`).
- Modify: `cli/claudecode-plugin/scripts/pre-tool-enforcer_test.ts` — three new test groups.
- Modify: `kernel/integration_test.ts` — the swarm two-agent race test.

**Acceptance criteria:**
- All existing scout / relay / swarm tests pass with `OVERMIND_EDIT_HARNESS` unset and with `OVERMIND_EDIT_HARNESS=1, OVERMIND_MODE=scout` (lock layer is a no-op for single-writer modes).
- Two-agent race integration test passes: second agent gets 409 with the first agent's holder, and 200 after a `/release-session-locks` call.
- `deno check cli/claudecode-plugin/scripts/{pre-tool-enforcer,lib/lock_client}.ts` clean.
- A new agent that has only ever acquired one lock and whose CC session ends sees its lock cleared by the M3-redesign session-end hook (verified by a test in `pre-tool-enforcer_test.ts` that reuses the harness from M3-redesign's session-end test).

**Risks specific to M4:**
- **Hook latency on the critical path.** Every `Edit`/`Write` waits up to 300 ms for the kernel. Mitigation: localhost network only, hard timeout, fail open. Worst case the agent writes without lock-check, which matches today's no-harness behavior. Same trade-off as the parent plan's M4.
- **`agentId` ambiguity in the lead session.** The lead agent's `agentId` is not always present in the hook payload (subagents have it, lead may not). When missing, we fall back to `"unknown"`. Two unrelated leads on different machines with the same sessionId would re-enter rather than conflict — which is harmless because they would not actually share a sessionId across machines (CC session ids are process-scoped). Documented inline.
- **Mode unknown.** When `OVERMIND_MODE` is unset, the hook runs the lock check. In a single-writer scout/relay run with the harness on, the check is a wasted localhost RTT. Cost is bounded by the 300 ms timeout and only matters under operator misconfiguration. M5 (parent plan) documents the env var.
- **Conflict body parsing.** A malformed conflict body downgrades to `kernel_unavailable` (fail open). This is a known soft-fail mode — better than blocking on a half-broken kernel.

---

## Success Criteria

- Two parallel teammates in a swarm with overlapping file scope: the second `Edit` on a contested path produces a stop reason naming the holder agentId and sessionId, with the harness on. End-to-end exercised by a real integration test that starts the kernel HTTP listener.
- A CC SessionEnd fires `POST /release-session-locks` and the kernel registry drops every entry matching that sessionId. Verified in `kernel/integration_test.ts`.
- All existing scout / relay / swarm / setup tests pass unchanged with the harness off and with the harness on in single-writer modes.
- Kernel restart replays journals; entries reflect last persisted state. (Unchanged from parent plan; the journal format change is the entry shape only.)
- `deno check` passes across all new and modified modules.
- After M3-redesign + M4 land, a grep across `kernel/` and `cli/` for `OVERMIND_RUN_ID` and `OVERMIND_TASK_ID` returns no production hits — only doc/setup mentions, if any.

---

## Risks

- **Eventual auto-release is a real behavior change.** A misbehaving cancel cascade — for example, an orchestrator CC session that hangs without firing SessionEnd — leaks locks until kernel restart. Mitigation: SessionEnd is the most reliable hook in CC's lifecycle (it fires on `/clear`, `/compact`, kernel cancel, user shutdown). The 30-min registry-level TTL described in the parent plan still backs us up. We add an operational note: a manual `POST /release-session-locks` is always available for debugging.
- **`session_id` field absent in some CC builds.** The M1 hash cache already falls back to `"default"` (`post-tool-verifier.ts:222`). With a constant fallback, every agent in such a build shares a single sessionId — and locks become re-entrant for everyone, breaking the cross-agent guarantee. Mitigation: log a one-line warn from the hook when the fallback fires. The hash check still applies; this regresses to "M1 only" for that environment, which is the same as the harness-off baseline today.
- **Forgotten old-shape consumer.** A test or doc still asserts `taskId`/`runId` after the rewrite. Mitigation: explicit grep + final-pass test run before merge; reviewers see the deletion-and-replace diff explicitly because old tests are deleted, not adapted.
- **Run-to-session map memory.** The optional kernel-side fast-release map could in theory grow if it is never cleared. Mitigation: cap at 10k entries (same as the lock map), evict oldest, clear on `releaseAllForSession`. Worst case the map fills and we lose the fast path; the SessionEnd cascade is the correctness path either way.
- **Soak window covers two contract changes.** The parent plan's soak applies to the harness as a whole. M3-redesign + M4 land inside that same window before M6 flips the default. We do not extend the window.

---

## Out of Scope

- **Reviving `runId` in any form.** A future concrete `AgentDispatcher` may inject env vars into spawned CC processes; that is a separate change. Until it exists, we do not pretend it does.
- **Per-edit unlock from the hook.** Same as parent plan — edits release on SessionEnd, not on PostToolUse. Per-edit unlock would thrash the journal and create release-storm windows.
- **Cross-machine sessionId coordination.** Lock state is per-kernel-process. Two kernels on two machines do not share locks. Same scope as the parent plan.
- **Extending the soak window.** The redesign reuses the existing M6 soak gate; no additional bake time. If signal during soak is poor, the kill switch (`OVERMIND_EDIT_HARNESS=0`) is unchanged.
- **Adding new env vars beyond the existing `OVERMIND_*` family.** No new keys. M5 in the parent plan still documents `OVERMIND_EDIT_HARNESS` and `OVERMIND_MODE`. `OVERMIND_TASK_ID`, `OVERMIND_AGENT_ID`, `OVERMIND_RUN_ID` are removed from the documented surface.
- **New agent skills or MCP tools.** The redesign is wire-format and helper-only; no agent prose changes beyond what M5 already specifies (and even there the messages tighten — "agent A in session S1" replaces "task T1 (agent A)").

---

## Related Work

- Parent plan: `src/plannings/edit-harness/plan.md` — full design, threat model, milestones M1-M6.
- Spike: `docs/edit-harness-spike.md` — original threat model. Unchanged by this redesign; lock semantics map onto the same model with a different identity tuple.
- Shipped M3 commits: `3f0fee5` (initial M3) and `ff5da10` (M3 cleanup). This plan corrects M3 in place.
- Adjacent kernel work: `kernel/persistence.ts` — journal pattern reused for lock persistence (unchanged).
- Adjacent kernel work: `kernel/cancellation.ts` — `CancellationRegistry.cancel` no longer triggers immediate lock release; documented in `cancelRun` inline.
- Existing identity pattern: `cli/claudecode-plugin/scripts/lib/read_hash_cache.ts` and `cli/claudecode-plugin/scripts/post-tool-verifier.ts:222` — sessionId fallback pattern this plan mirrors.
- Hook registration: `cli/claudecode-plugin/hooks/hooks.json:159-170` — `SessionEnd` matcher, hook timeout 10 s; the new `/release-session-locks` POST fits inside this budget.
- Brain task: `ovr-396.23` (parent), `ovr-396.23.1` (deferred items). This plan resolves the M3/M4 production-correctness item under `ovr-396.23` and is unrelated to the deferred tier.

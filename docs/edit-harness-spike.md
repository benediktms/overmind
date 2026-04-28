# ovr-396.17 — Edit Harness & Hash-Anchored Change Protocol Spike

**Status:** Complete **Type:** Spike (Research + Design) **Brain Task:**
ovr-396.17 **Blocks:** ovr-396.23 (Implement edit harness and safe write
contract) **Date:** 2026-04-28

---

## Problem

Overmind's autonomous agents (drone, weaver, evolver, scribe, guardian, etc.)
write to files via Claude Code's built-in `Edit` and `Write` tools. There is no
protocol that prevents:

1. **Stale-context overwrite within a session.** An agent reads a file, plans
   for several minutes, then edits it. Another writer (a hook, the user, an
   adjacent subagent) modifies the same file in between. CC's `Edit` requires
   the file to have been `Read` in this session and that `old_string` matches
   uniquely — but it does not check that the file is still in the state the
   agent based its plan on. Result: silent merge or partial clobber.
2. **Cross-agent races in swarm/team modes.** Two parallel agents claim adjacent
   or overlapping files. The skills (`drone`, `weaver`, `team-build`) instruct
   each teammate to do a `git status` pre-claim check; nothing in the kernel
   enforces it.
3. **Lossy `Write` overwrites.** `Write` replaces a file the agent thought was
   still small but has grown since the read.
4. **No reversibility.** Multi-step swarm output cannot be inspected, replayed,
   or rolled back as a unit.

The user-facing goal is "safe writes from autonomous agents": every edit either
lands cleanly on the version the agent saw, or fails loudly with enough context
to re-plan. Today this works only because edits are mostly serialized through
one CC main session.

---

## Current state

### What exists today

| Surface                               | Behavior                                                                                                                       | File                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `pre-tool-enforcer.ts` (PreToolUse)   | Guards `.env` writes and a few dangerous Bash patterns. No hash check.                                                         | `cli/claudecode-plugin/scripts/pre-tool-enforcer.ts`        |
| `post-tool-verifier.ts` (PostToolUse) | Pattern-matches the result for known error strings on `Edit`/`Write`. Reactive only — does not detect silent stale-overwrites. | `cli/claudecode-plugin/scripts/post-tool-verifier.ts`       |
| `kernel/persistence.ts`               | Uses `Deno.writeTextFile` for kernel internal state files. **Not** on the agent edit path.                                     | —                                                           |
| Skill-level discipline                | `weaver` and `drone` instruct teammates to `git status` before claiming. Not enforced by the kernel.                           | `cli/claudecode-plugin/skills/{drone,weaver,team-build}.md` |

There is no equivalent of OMC's "context-safety" / "edit harness" subsystem.

### What CC's `Edit`/`Write` already enforce

- `Edit`: file must be `Read` in the same session before edits succeed.
- `Edit`: `old_string` must be unique in the file (or `replace_all`).
- `Write`: existing files must be `Read` first before overwrite.

CC's contract is **intra-session staleness protection at Read time**.
Cross-session, cross-agent, and elapsed-time staleness are the gaps.

---

## Survey of approaches in the wild

| System                                                    | Mechanism                                                               | Notes                                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Aider**                                                 | Hash-based file fingerprints; rejects edit when hash mismatches         | Operates on the user's local repo; mismatch surfaces; rebuild is manual |
| **GitHub Copilot Workspace**                              | Patch-based (unified diff against base SHA), 3-way merge at apply       | Conflicts surface explicitly                                            |
| **MorphLLM Fast Apply**                                   | Lightweight LLM applies a "diff intent" against a fresh read            | Implicitly fresh-reads at apply time — no race                          |
| **Claude Code `Edit`**                                    | Read-before-edit enforced **in the same session**                       | No inter-session / elapsed-time tracking                                |
| **VS Code LSP `WorkspaceEdit`**                           | Versioned text documents; client must include `version` matching server | Server-side staleness via document version                              |
| **OMC `context-safety.mjs`**                              | PreToolUse hook that warns when context length grows                    | Different concern (context window, not file staleness)                  |
| **Anthropic C-compiler experiment** (16 parallel Claudes) | File-level Git locks; one agent per file; rebase on conflict            | Filesystem-level coarse locks                                           |

The strongest convergence: **read-modify-write should be guarded by a
fingerprint of the read state, and apply must re-fingerprint at apply time,
failing closed when they disagree.**

---

## Threat model for Overmind

1. **Cross-agent file race** in swarm/team modes — two agents claim overlapping
   files.
2. **Stale-context edit** — agent reads at t=0, edits at t=10 min, file mutated
   at t=5 min by another writer in the same session.
3. **Lossy `Write`** — overwrite of a file that grew since the read.
4. **Bad-batch silent commit** — sequence of edits across files that breaks
   invariants taken together; we want to inspect or roll the batch back.

This spike addresses (1), (2), (3). (4) is a transactional change-set concern
deferred to a later ADR.

---

## Design options

### Option A — Hash-anchored Edit MCP tool (replace `Edit`)

Ship `mcp__overmind__overmind_edit`. Required params: `file_path`, `old_string`,
`new_string`, `read_hash` (sha256 of the contents the agent based the edit on).
The kernel:

1. Reads the file, hashes it.
2. If `read_hash` mismatches → fail with a structured error containing the
   current contents (or a diff-friendly excerpt) so the agent can re-plan.
3. If match → apply the edit and emit a `change_event` to the kernel's
   persistent log.
4. Optionally registers the file as locked-for-this-task so a parallel agent's
   edit fails fast.

**Pros:** Strong guarantee. Centralized log of every write. Composable with
cancellation/rollback later.

**Cons:** Every agent (drone, weaver, scribe, evolver, …) must use the kernel
tool instead of CC's built-in `Edit`. Agents will default to `Edit` unless
aggressively prompted, and the MCP path adds an HTTP round-trip. Forcing the
tool means removing `Edit` from each subagent's `tools:` list, which is a wide
cross-cut across `cli/claudecode-plugin/agents/`.

### Option B — PreToolUse hook hash check (wrap `Edit`/`Write`)

Extend `pre-tool-enforcer.ts` to:

1. Maintain a per-session map:
   `path → sha256(contents at last successful
   Read by this session)`,
   persisted to a small JSON file.
2. On `Read` PostToolUse → populate / refresh the entry.
3. On `Edit` or `Write` PreToolUse → fingerprint the file _now_; if it differs
   from the recorded hash, return a non-`continue` decision with
   `additionalContext` explaining the staleness.
4. On `Edit` / `Write` PostToolUse (success) → refresh the recorded hash to the
   new contents.

**Pros:** Transparent to agents — they keep using `Edit`/`Write`. No new MCP
surface. Local to the plugin. Cheap.

**Cons:** Hooks are session-scoped; cross-agent races within a swarm need a
kernel-side store. Bypassed if the agent uses Bash (`sed -i`, `>` redirects).
Hash file must survive `/clear` and `/compact`.

### Option C — Kernel-mediated change set (transactional)

Agents emit _change intents_ (a unified diff vs `read_hash`) to the kernel,
which:

1. Stages them in a change-set keyed by task / objective.
2. Applies them atomically in a worktree (e.g., `git apply --3way`).
3. Failed applies surface back to the agent for re-plan.

**Pros:** True transactional semantics. Whole-batch rollback. Natural fit for
swarm convergence on a final state.

**Cons:** Heavy. Requires diff-generation discipline from agents (LLMs are
unreliable at clean unified diffs vs. anchored string edits). Worktree
management is non-trivial. Out of scope for ovr-396.23 as currently scoped.

### Option D — Filesystem-level coarse lock per task

Borrow the C-compiler-experiment approach: an agent flips
`.overmind/locks/<path>.lock` containing `{taskId, agentId, acquiredAt}` before
reading. Pre-tool hook denies `Edit`/`Write` when the lock is held by a
different task. Released on task completion / cancellation.

**Pros:** Brutally simple. Catches cross-agent races deterministically.

**Cons:** File-granular only. Requires a release path on cancellation / timeout.
Doesn't address stale-context-within-a-session.

---

## Recommendation

Ship **Option B** (PreToolUse hash check) as the v1 contract for ovr-396.23.
Layer **Option D** (per-task file locks) on top for swarm/team modes.

**Why not A.** Removing `Edit` from subagent toolsets to force the MCP route is
feasible but expensive — every builder definition under
`cli/claudecode-plugin/agents/` would need to be retooled, and the MCP path adds
round-trips. The hook approach gets ~90% of the protection for ~10% of the
effort. A is the right v2 if we later want a centralized change log.

**Why not C.** The spike asks for an "edit harness and safe write contract," not
a transaction system. Change-sets are a v2 conversation behind a separate ADR.

**Why both B + D.** B catches _intra-session_ staleness (agent reads at t=0,
edits at t=10 min, file mutated at t=5 min). D catches _cross-agent_ races in
swarm and team. Together they cover the Overmind threat model without a kernel
rewrite.

---

## Protocol for ovr-396.23

The implementation task will deliver:

### 1. Read-fingerprint cache (in `pre-tool-enforcer` + `post-tool-verifier`)

Per-session JSON at
`~/.claude/projects/<project-slug>/overmind/read_hashes.json`, keyed by absolute
path:

```json
{
  "/abs/path/to/file.ts": {
    "sha256": "abcd…",
    "readAt": 1714291200,
    "sessionId": "…"
  }
}
```

Refresh rules:

- `Read` PostToolUse → capture sha256 of file contents at read time.
- `Edit` / `Write` PostToolUse (success) → refresh sha256 to post-write content.
- TTL: entry forgotten after 1 h or on session end.
- File is rotated when it crosses 1 MB (unlikely but bounded).

### 2. Stale-write rejection (in `pre-tool-enforcer`)

On `Edit` or `Write` PreToolUse:

- Compute current sha256 of `file_path`.
- No cache entry → allow (no prior read; CC's own "must Read first" guard still
  runs).
- Cache sha matches current sha → allow.
- Mismatch → return:

  ```json
  {
    "continue": false,
    "stopReason": "Stale read detected. File was modified since you last read it. Re-read before editing."
  }
  ```

  CC surfaces this back to the agent.

### 3. Per-task file locks (kernel-side, swarm/team only)

New kernel HTTP endpoints `POST /lock` and `POST /unlock`:

- `acquire(path, taskId, agentId)` — succeeds if no lock or same `taskId`.
  Persisted via the existing event-log pattern in `kernel/persistence.ts`.
- `release(path, taskId)` — clears the lock.
- On `Edit` / `Write` PreToolUse, the hook also POSTs a non-blocking lock check;
  conflict → reject with a clear message.
- Locks auto-expire on task close / cancel via the existing cancellation event
  handlers in `kernel/cancellation.ts`.

Locks are no-ops in scout / relay (single-writer modes). Active in swarm and
team where parallel writers can collide.

### 4. Bash-mediated edit guard (defense in depth)

Extend `pre-tool-enforcer` Bash matcher to flag `sed -i`, `awk -i`, and `> path`
/ `>> path` redirects when `path` is in the read-hash cache. The hook does not
block the command — Bash's surface is too varied for that — but it surfaces a
`[OVERMIND SAFETY]` note: "Bash write detected on a hash-cached path; the edit
harness will not see it. Prefer `Edit`/`Write` or invalidate the cache first."

### 5. Skill / agent guidance

- Update `drone.md`, `weaver.md`, `evolver.md`: "If `Edit` returns a stale-read
  error, re-read the file and re-plan; do not retry blindly."
- Update `team-build.md`: describe the file-lock semantics, including when to
  expect `acquire` rejection and how to back off.
- Update `setup.md`: add `OVERMIND_EDIT_HARNESS=1` opt-in flag.

### 6. Tests

- **Unit** (`pre-tool-enforcer_test.ts`):
  - Hash cache populates on `Read`.
  - Mismatched hash on `Edit` returns `continue: false`.
  - Successful `Edit` refreshes the hash.
  - TTL expiry returns to "no entry → allow."
- **Unit** (kernel/locks): acquire/release/conflict/auto-release on cancel.
- **Integration** (`integration_test.ts`): simulate two-agent race in swarm;
  verify second writer is rejected with a structured error.
- **Regression**: existing scout / relay / swarm tests must keep passing — the
  hook is opt-in via env var (`OVERMIND_EDIT_HARNESS=1`) for the first ship.
  Default-on follows after a soak period.

---

## Out of scope for ovr-396.23

- Transactional change-sets (Option C) — separate task / ADR.
- Bash-mediated edits beyond the warning above. The hook does not block.
- Cross-session / cross-machine coordination. The hash cache is per-session.
- Diff-based edits. We stick with anchored-string edits; the harness wraps the
  existing `Edit` shape.
- Rollback / undo of applied edits. Belongs to the change-set v2.

---

## Risks

| Risk                                                    | Severity | Mitigation                                                                                         |
| ------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| Hook bypass via Bash                                    | Medium   | Defense-in-depth warning (item 4); document the gap in skills                                      |
| False positive on benign external edit (formatter, IDE) | Medium   | Surface the staleness clearly; agent re-reads. Do not auto-merge                                   |
| Performance                                             | Low      | sha256 of source files is microseconds                                                             |
| Hook ordering                                           | Low      | `pre-tool-enforcer` already runs PreToolUse for `Edit`/`Write`; we extend, not register a new hook |
| Persistence file corruption                             | Low      | Treat as "no cache" on parse failure; fall back to allow-with-warning                              |

### Known TOCTOU window (inherent to Option B)

The PreToolUse hook computes the file's sha256 _before_ CC's actual `Edit`
applies. Between that check and the apply there is a small window (milliseconds)
during which a concurrent writer (parallel agent, IDE formatter, filesystem
watcher) can mutate the file. If that happens, the harness will have given a
"clean" verdict against an instant-stale state, and CC's `Edit` will land on
whatever's now on disk.

This is an inherent limitation of any hook-side approach (the kernel does not
own the `Edit` execution). Option A — a kernel-mediated MCP edit tool that owns
the read-check-write transaction — would close this window entirely, at the cost
of removing `Edit` from every subagent's tool whitelist and routing through an
HTTP round-trip. The trade-off was explicitly evaluated and B was chosen for its
much lower implementation cost. The residual TOCTOU is documented for the
eventual v2 ADR that revisits Option A.

The threat-model implications are narrow: the race requires another writer on
the _exact same file_ within milliseconds. The primary threat the harness
addresses — agent reads at t=0, modifies at t=10 min after a mutation at t=5 min
— is fully covered.

---

## Decision

Implement Options B + D in **ovr-396.23**. Ship behind `OVERMIND_EDIT_HARNESS=1`
for one release cycle, then default-on after the soak period. Defer Option C to
a v2 ADR if/when transactional change-sets are needed.

---

## Sources

- Aider hash-fingerprint approach — github.com/paul-gauthier/aider
- MorphLLM fast-apply — github.com/morph-llm/morph-fast-apply
- Anthropic C-compiler experiment (16 parallel Claudes, file-level Git locks) —
  anthropic.com/engineering/building-c-compiler
- VS Code LSP versioned text documents —
  microsoft.github.io/language-server-protocol
- Existing hook scripts —
  `cli/claudecode-plugin/scripts/{pre-tool-enforcer,post-tool-verifier}.ts`
- Prior overmind spike: `docs/verification-pipeline-spike.md` (verification
  pipeline that ovr-396.23's stale-read errors will integrate with)

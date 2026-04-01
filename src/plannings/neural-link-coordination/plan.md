# Neural Link Coordination Semantics Upgrade

## Summary

Upgrade the kernel's neural_link usage from a lead-only synchronous pattern to the full distributed coordination protocol. Today the three kernel modes (relay, swarm, scout) treat subagents as passive message targets -- the lead sends findings, blocks on `waitFor`, and closes the room. The neural_link server already supports room joining, inbox polling, message acknowledgement, drain-on-leave, escalation handling, and interaction modes. None of these are exercised.

This upgrade makes subagents first-class room participants and is the prerequisite for team mode (ovr-396.10).

**Key Goals:**
- Complete the `NeuralLinkAdapter` API surface (add `roomLeave`, `threadSummarize`; fix types)
- Build reusable coordination helpers (`drainInbox`, `waitAndProcessInbox`, `withParticipation`)
- Upgrade each kernel mode to use richer coordination semantics appropriate to its nature
- Unify per-mode adapter interfaces into a single `NeuralLinkPort`

**Risk:** Low-Medium | **Dependencies:** neural_link server (external, may be offline) | **Ref:** ovr-396.20 spike, ovr-396.21 implementation, ovr-396.10 team mode

---

## Current State vs Desired State

### Current State

```
                        neural_link server
                        (full protocol)
                              |
                     NeuralLinkAdapter
                  (7 methods, 2 missing,
                   untyped returns)
                              |
            +--------+--------+--------+
            |        |        |        |
         relay    swarm    scout    MockNeuralLinkAdapter
            |        |        |        (mocks all 7, only 4 exercised)
            |        |        |
    NeuralLink   NeuralLink  NeuralLink
    RelayAdapter SwarmAdapter ScoutAdapter
    (4 methods)  (4 methods)  (4 methods)

    Each mode uses ONLY:
      roomOpen -> messageSend -> waitFor -> roomClose

    Lead is the only active participant.
    Subagents never join, read inbox, ack, or leave.
```

**Limitations:**
- Subagents are passive message targets -- cannot participate in bidirectional coordination
- No inbox processing -- interleaved blockers/questions during `waitFor` are silently dropped
- No drain semantics -- subagent departure is invisible to the system
- No escalation handling -- if a subagent crashes while another waits on it, the waiter hangs until timeout
- No interaction modes -- no compliance tracking for review or deliberation patterns
- No thread IDs -- multi-step rooms have no message separation
- `waitFor` returns `unknown`, `inboxRead` returns `unknown[]`, `messageAck` accepts `string` instead of `string[]`
- Three nearly-identical per-mode adapter interfaces instead of one shared port

### Desired State

```
                        neural_link server
                        (full protocol)
                              |
                     NeuralLinkAdapter
                  (9 methods, typed returns,
                   implements NeuralLinkPort)
                              |
                       NeuralLinkPort
                    (single interface in
                     kernel/types.ts)
                              |
            +--------+--------+--------+
            |        |                 |
    coordination.ts              MockNeuralLinkAdapter
    - drainInbox()               (implements NeuralLinkPort,
    - waitAndProcessInbox()       all methods exercised)
    - withParticipation()
            |
            +--------+--------+--------+
            |        |        |
         relay    swarm    scout
         (supervisory) (informative/  (informative)
                    deliberative)

    Lead: roomOpen + interactionMode -> messageSend -> waitAndProcessInbox -> roomClose
    Between steps: drainInbox for interleaved messages
    Thread IDs per step/task for traceability
    Escalation handling in lead's inbox loop (swarm)
```

**Benefits:**
- Subagents become first-class participants (prerequisite for team mode)
- Interleaved messages (blockers, questions) are caught and processed instead of dropped
- Escalation handling prevents deadlocks when subagents crash
- Interaction modes enable compliance tracking for review workflows
- Thread IDs make multi-step/multi-task rooms traceable
- Single `NeuralLinkPort` interface simplifies testing and future mode development

---

## Architecture Design

### Unified NeuralLinkPort Interface

Replace the three per-mode interfaces (`NeuralLinkRelayAdapter`, `NeuralLinkSwarmAdapter`, `NeuralLinkScoutAdapter`) with a single `NeuralLinkPort` in `kernel/types.ts`. Each mode currently defines its own 4-method interface -- they are identical in shape. The port expands to cover the full adapter surface.

```typescript
// kernel/types.ts (new)

export interface NeuralLinkPort {
  // Room lifecycle
  roomOpen(params: RoomOpenParams): Promise<string | null>;
  roomJoin(roomId: string, participantId: string, displayName: string, role?: string): Promise<boolean>;
  roomLeave(roomId: string, participantId: string, timeoutMs?: number): Promise<boolean>;
  roomClose(roomId: string, resolution: string): Promise<boolean>;

  // Messaging
  messageSend(params: MessageSendParams): Promise<boolean>;
  inboxRead(roomId: string, participantId: string): Promise<InboxMessage[]>;
  messageAck(roomId: string, participantId: string, messageIds: string[]): Promise<boolean>;
  waitFor(roomId: string, participantId: string, timeoutMs: number,
          kinds?: MessageKind[], from?: string[]): Promise<WaitForMessage | null>;

  // Introspection
  threadSummarize(roomId: string, threadId?: string): Promise<RoomSummary | null>;

  // Connection
  isConnected(): boolean;
}
```

Modes consume `NeuralLinkPort` and use only the methods they need. The adapter implements the full port. Tests inject `MockNeuralLinkAdapter` which also implements the full port.

### Message Type Definitions

Move message types from the adapter module to `kernel/types.ts` so they are available to the coordination layer without importing from `adapters/`:

```typescript
// kernel/types.ts (new types)

export interface WaitForMessage {
  message_id: string;
  from: string;
  kind: MessageKind;
  summary: string;
  body?: string;
  thread_id?: string;
  sequence: number;
}

export interface InboxMessage extends WaitForMessage {
  to?: string;
  created_at: string;
}

export interface RoomSummary {
  decisions: string[];
  open_questions: string[];
  blockers: string[];
  participant_count: number;
  message_count: number;
}
```

### Coordination Helpers Layer

`kernel/coordination.ts` provides three composable helpers that modes call at appropriate points. These are pure functions over `NeuralLinkPort` -- no mode-specific logic.

```
drainInbox(port, roomId, participantId, handler)
  |
  +-- inboxRead -> for each msg: handler(msg) -> messageAck
  |   Returns count of processed messages
  |   If inboxRead returns [] (disconnected or empty), returns 0

waitAndProcessInbox(port, roomId, participantId, expectedKinds, opts)
  |
  +-- waitFor(expectedKinds) in a loop
  |   On match: return the message
  |   On interleaved message: call opts.onInterleaved(msg), ack, continue waiting
  |   On timeout/disconnect: return null
  |   Max iterations guard prevents infinite loops

withParticipation(port, roomId, participant, work)
  |
  +-- roomJoin -> work(ctx) -> messageSend(handoff) -> roomLeave
  |   Wraps the subagent lifecycle with drain semantics
  |   On error in work(): still sends handoff (with error summary) and leaves
```

### Per-Mode Upgrade Strategy

**Relay** (sequential, supervisory):
- `roomOpen` gains `interactionMode: "supervisory"`
- Each relay step gets `threadId: step-${stepIndex}`
- After each `waitFor(Handoff)`, call `drainInbox` to catch interleaved messages
- No structural change to the sequential step loop

**Swarm** (parallel, informative/deliberative):
- `roomOpen` gains `interactionMode: "informative"` (default) or `"deliberative"` (cross-deps)
- Each swarm task gets `threadId: task.agentRole`
- Replace raw `collectHandoffs` loop with `waitAndProcessInbox` to handle blockers/escalations during collection
- Lead processes escalations: if a subagent departs while another waits, the lead responds on behalf of the departed agent
- Fix dispatch messages gain thread IDs for traceability

**Scout** (parallel, informative):
- `roomOpen` gains `interactionMode: "informative"`
- After handoff collection, call `drainInbox` to catch late findings
- Lightest touch -- scout is read-only exploration

---

## Implementation Milestones

### Milestone 1: Adapter Completeness and Type Safety

**Deliverable:** `NeuralLinkAdapter` exposes the full protocol surface with typed returns. All existing tests pass unchanged.

**What we'll build:**
- Add `roomLeave(roomId, participantId, timeoutMs?)` method to `NeuralLinkAdapter`
- Add `threadSummarize(roomId, threadId?)` method to `NeuralLinkAdapter`
- Define `WaitForMessage`, `InboxMessage`, `RoomSummary` types in `kernel/types.ts`
- Change `waitFor` return type from `unknown` to `WaitForMessage | null`
- Change `inboxRead` return type from `unknown[]` to `InboxMessage[]`
- Change `messageAck` parameter `messageIds` from `string` to `string[]`
- Update `MockNeuralLinkAdapter` to match new signatures (add `roomLeave`, `threadSummarize`, fix `messageAck` parameter type)

**Key files:**
- Modify: `adapters/neural_link/adapter.ts` -- add `roomLeave`, `threadSummarize`; change return types for `waitFor`, `inboxRead`; change `messageAck` param from `string` to `string[]`
- Modify: `kernel/types.ts` -- add `WaitForMessage`, `InboxMessage`, `RoomSummary` interfaces; add `NeuralLinkPort` interface; re-export `MessageKind`, `RoomOpenParams`, `MessageSendParams` from adapter
- Modify: `kernel/test_helpers/mock_neural_link.ts` -- add `roomLeave`, `threadSummarize` mocks; update `messageAck` signature; update `waitForResult` type; update `inboxReadResult` type

**Backward compatibility:** The `waitFor` and `inboxRead` methods already return the right shapes at runtime (the server sends typed JSON). Changing from `unknown` to a concrete type is a narrowing -- callers that pattern-match on the result (like `parseVerifyResult` in relay.ts and swarm.ts) continue to work because they check `isObject(value)` before accessing fields. The `messageAck` change from `string` to `string[]` matches the server's API (`message_ids` is an array). The current adapter sends whatever it receives, so the server already handles both, but the mock and per-mode interfaces must be updated.

**Testing:**
- New unit tests for `roomLeave` and `threadSummarize` in a new `adapters/neural_link/adapter_test.ts` (HTTP-level tests against mock server or response assertions)
- Verify all existing mode tests pass with updated mock signatures (zero behavioral change expected)

---

### Milestone 2: Coordination Helpers

**Deliverable:** `kernel/coordination.ts` with three tested helpers. No mode changes yet -- helpers are exercised only by their own unit tests.

**What we'll build:**
- `drainInbox(port, roomId, participantId, handler)` -- read pending messages, invoke handler for each, ack all processed IDs in a single batch call
- `waitAndProcessInbox(port, roomId, participantId, expectedKinds, opts)` -- wait for a specific message kind while handling interleaved messages via `opts.onInterleaved`; includes max-iterations guard and timeout propagation
- `withParticipation(port, roomId, participant, work)` -- join/work/handoff/leave lifecycle wrapper with error handling (always leaves, even on error)
- `ParticipationContext` type exposing `port`, `roomId`, `participantId` for use inside the `work` callback

**Key files:**
- Create: `kernel/coordination.ts` -- the three helpers plus `ParticipationContext` type
- Create: `kernel/coordination_test.ts` -- unit tests using `MockNeuralLinkAdapter`

**Design decisions:**
- `drainInbox` acks in a single batch after all messages are processed (not one-by-one). This matches the server's `message_ack` API which accepts `message_ids: string[]`.
- `waitAndProcessInbox` uses the existing `waitFor` long-poll under the hood. If an interleaved message arrives (wrong kind), it processes it, acks it, then re-issues `waitFor` with an updated `since_sequence`. A `maxIterations` parameter (default: 20) prevents infinite loops from chatty rooms.
- `withParticipation` catches errors in the `work` callback and sends a `handoff` message with `body: "Error: <message>"` before calling `roomLeave`. This ensures the lead always receives a handoff even if the subagent fails.
- All helpers return gracefully when `port.isConnected()` returns false or when server calls return null/false/empty. The coordination layer does not throw on disconnection -- it degrades to no-op behavior matching the existing adapter pattern.

**Testing:**
- `drainInbox`: empty inbox returns 0; inbox with 3 messages calls handler 3 times and acks all IDs; handler error does not prevent ack of already-processed messages
- `waitAndProcessInbox`: direct match returns immediately; interleaved message calls `onInterleaved` and continues; timeout returns null; max-iterations guard returns null
- `withParticipation`: happy path joins/works/handoffs/leaves; error in work still sends handoff and leaves; join failure short-circuits

---

### Milestone 3: Per-Mode Upgrades

**Deliverable:** All three modes use richer coordination semantics. Existing test assertions continue to pass. New tests cover the added coordination behavior.

#### Relay Upgrade

**What changes:**
- `roomOpen` call gains `interactionMode: "supervisory"`
- `messageSend` calls for step execution gain `threadId: \`step-${stepIndex}\``
- After each `waitFor(Handoff)` succeeds, call `drainInbox` to process any interleaved messages (blockers, questions) that arrived during the wait. The drain handler logs/records unexpected messages but does not change the step flow.
- `messageSend` calls for `ReviewRequest` also gain the step's `threadId`

**Key files:**
- Modify: `kernel/modes/relay.ts` -- remove `NeuralLinkRelayAdapter` interface, import `NeuralLinkPort` from types; add `interactionMode` to `roomOpen`; add `threadId` to `messageSend` calls; add `drainInbox` call after each handoff `waitFor`
- Modify: `kernel/modes/relay_test.ts` -- update mock type; add test for interaction mode in `roomOpen` params; add test for thread IDs on messages; add test that `drainInbox` is called (via mock call log)

**Backward compatibility:** The `interactionMode` parameter is already accepted by `RoomOpenParams` and the mock's `roomOpen`. Thread IDs are optional fields already present in `MessageSendParams`. Adding `drainInbox` between steps is additive -- it reads inbox (returns `[]` in tests by default) and proceeds.

#### Swarm Upgrade

**What changes:**
- `roomOpen` call gains `interactionMode: "informative"`
- `dispatchTasks` and `dispatchFixTasks` gain `threadId: task.agentRole` on each `messageSend`
- Replace `collectHandoffs` with a new `collectHandoffsWithInbox` that uses `waitAndProcessInbox` instead of raw `waitFor`. The `onInterleaved` handler processes `Blocker` messages (records to brain), `Escalation` messages (lead responds on behalf of departed agent), and `Question` messages (logged for now).
- After the collection phase and before verification, call `drainInbox` once to catch any remaining messages

**Key files:**
- Modify: `kernel/modes/swarm.ts` -- remove `NeuralLinkSwarmAdapter` interface, import `NeuralLinkPort`; add `interactionMode` to `roomOpen`; add `threadId` to dispatch messages; replace `collectHandoffs` with `collectHandoffsWithInbox` using `waitAndProcessInbox`; add escalation response logic; add `drainInbox` before verify
- Modify: `kernel/modes/swarm_test.ts` -- update mock type; add tests for interaction mode, thread IDs, escalation handling, interleaved blocker processing

**Escalation handling detail:** When the `onInterleaved` handler receives a message with `kind: "escalation"`, the lead sends an `Answer` message targeted at the waiting agent (extracted from the escalation body) with a summary like "Lead standing in for departed <agent>". This satisfies the waiting agent's `waitFor` filter per the neural_link protocol (AGENTS.md line 286).

#### Scout Upgrade

**What changes:**
- `roomOpen` call gains `interactionMode: "informative"`
- `messageSend` calls for probe dispatch gain `threadId: \`probe-${index}\``
- After handoff collection loop, call `drainInbox` to catch late findings

**Key files:**
- Modify: `kernel/modes/scout.ts` -- remove `NeuralLinkScoutAdapter` interface, import `NeuralLinkPort`; add `interactionMode` to `roomOpen`; add `threadId` to dispatch messages; add `drainInbox` after collection
- Modify: `kernel/modes/scout_test.ts` -- update mock type; add test for interaction mode and thread IDs

---

### Milestone 4: Interface Unification and Mock Cleanup

**Deliverable:** Per-mode adapter interfaces are fully removed. `MockNeuralLinkAdapter` implements `NeuralLinkPort`. All tests use the unified interface.

**What we'll build:**
- Verify and remove any remaining references to `NeuralLinkRelayAdapter`, `NeuralLinkSwarmAdapter`, `NeuralLinkScoutAdapter` (should already be removed in milestone 3)
- Add `implements NeuralLinkPort` to `NeuralLinkAdapter` class declaration
- Add `implements NeuralLinkPort` to `MockNeuralLinkAdapter` class declaration
- Ensure `NeuralLinkAdapter` method signatures exactly match `NeuralLinkPort` (parameter names, return types)
- Verify `MessageKind` is re-exported from `kernel/types.ts` so modes do not need to import from `adapters/neural_link/adapter.ts`

**Key files:**
- Modify: `adapters/neural_link/adapter.ts` -- add `implements NeuralLinkPort` import and declaration
- Modify: `kernel/test_helpers/mock_neural_link.ts` -- add `implements NeuralLinkPort` import and declaration
- Modify: `kernel/types.ts` -- re-export `MessageKind`, `RoomOpenParams`, `MessageSendParams` from adapter if not done in milestone 1

**Testing:**
- TypeScript compiler is the primary verification -- if the adapter and mock compile with `implements NeuralLinkPort`, the interface contract is satisfied
- Run full test suite to confirm no regressions

---

## Success Criteria

- All nine `NeuralLinkAdapter` methods have concrete return types (no `unknown`)
- `messageAck` accepts `string[]` matching the server API
- `drainInbox`, `waitAndProcessInbox`, `withParticipation` have unit tests with full branch coverage
- Each mode passes `interactionMode` to `roomOpen`
- Each mode tags messages with `threadId`
- Swarm mode handles `Escalation` messages during handoff collection
- Per-mode adapter interfaces (`NeuralLinkRelayAdapter`, `NeuralLinkSwarmAdapter`, `NeuralLinkScoutAdapter`) are deleted
- `NeuralLinkAdapter` and `MockNeuralLinkAdapter` both `implements NeuralLinkPort`
- All existing tests pass at each milestone with zero behavioral regression
- `deno check` passes with no type errors across the affected modules

---

## Risks

- **Neural link server offline during adapter method testing.** The adapter already handles disconnection gracefully (returns `null`/`false`/`[]`). New methods (`roomLeave`, `threadSummarize`) follow the same pattern. Unit tests use `MockNeuralLinkAdapter` and do not require the server. Integration tests (if any) should be tagged and skippable.

- **Interleaved inbox processing introduces latency on the critical path.** `drainInbox` is called at natural pause points (after `waitFor` returns, between steps). It does not poll in a loop. If the inbox is empty (the common case when the server is offline or no interleaved messages exist), it returns immediately. The cost is one HTTP GET per pause point.

- **`waitAndProcessInbox` loop may not terminate in pathological cases.** The `maxIterations` guard (default: 20) prevents infinite loops from chatty rooms. If the expected message never arrives and interleaved messages keep coming, the function returns `null` after 20 iterations. The caller (swarm's collection phase) already handles `null` from `waitFor`.

- **Changing `messageAck` from `string` to `string[]` may break if any caller passes a single string.** No current mode calls `messageAck` directly (it is unused in all three modes today). The mock accepts `string` but the server API expects an array. The change aligns the adapter with the server. The mock update in milestone 1 ensures tests pass.

- **Type narrowing of `waitFor` return may surface hidden type errors.** Current callers use `isObject(value)` guards before accessing fields, so they handle the `unknown` -> `WaitForMessage | null` change safely. The `parseVerifyResult` functions in relay.ts and swarm.ts accept `unknown` and will continue to work. Any new code using `WaitForMessage` directly benefits from type safety.

---

## Out of Scope

- **Team mode implementation (ovr-396.10).** This plan builds the coordination foundation that team mode requires. Team mode itself -- with its distinct dispatch model, team task decomposition, and cross-agent dependency resolution -- is a separate plan.

- **Subagent-side `withParticipation` integration.** The `withParticipation` helper is built and tested in this plan, but actually wiring it into subagent dispatch (so subagents call `roomJoin`/`roomLeave` in production) requires changes to the agent dispatch system, which is outside the kernel modes. Team mode will integrate this.

- **Adversarial and deliberative interaction mode usage.** This plan adds `"supervisory"` and `"informative"` modes. The `"adversarial"` and `"deliberative"` modes are more complex (requiring challenge/proposal message flows) and are deferred to team mode or a dedicated review-mode plan.

- **`waitFor` with `since_sequence` parameter.** The current adapter's `waitFor` does not expose `since_sequence`. The `waitAndProcessInbox` helper works around this by re-issuing `waitFor` after processing interleaved messages. Adding `since_sequence` support to the adapter would be an optimization but is not required for correctness.

- **Hook system changes.** The PostToolUse/SubagentStart hook system for inbox nudges is unaffected by this plan. Hooks inject nudges into subagent context; this plan makes the kernel modes (lead-side) process those nudges via inbox reading.

---

## Related Work

- Spike: `docs/neural-link-coordination-spike.md` (ovr-396.20) -- gap analysis and design that this plan is based on
- Team mode: ovr-396.10 -- the downstream consumer of this coordination upgrade
- neural_link protocol: `AGENTS.md` lines 194-360 -- the full server protocol specification
- Verification pipeline: `kernel/verification/pipeline.ts` -- uses `NeuralLinkSwarmAdapter`-shaped interface for verify-with-agent; will need updating to use `NeuralLinkPort` in milestone 4

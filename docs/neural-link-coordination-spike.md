# Spike: Neural Link Coordination Semantics

**Task:** ovr-396.20
**Status:** Complete
**Date:** 2026-04-01

## Problem

The kernel modes (relay, swarm, scout) use a simplified lead-only synchronous
pattern for neural_link coordination:

```
Lead → messageSend(Finding) → waitFor(Handoff) → messageSend(ReviewRequest) → waitFor(ReviewResult) → roomClose
```

The neural_link server supports a much richer distributed protocol (documented in
AGENTS.md) with inbox polling, acknowledgements, drain semantics, escalation
handling, and interaction modes. None of these are exercised by the kernel today.

This spike researches what richer coordination semantics would look like in the
kernel modes, as a prerequisite for team mode (ovr-396.10).

## Current State

### What the adapter exposes

| Method | Implemented | Used by modes |
|--------|-------------|---------------|
| `roomOpen` | Yes | Yes — all modes |
| `roomJoin` | Yes | No |
| `roomClose` | Yes | Yes — all modes |
| `messageSend` | Yes | Yes — lead only |
| `waitFor` | Yes | Yes — lead blocks |
| `inboxRead` | Yes | No |
| `messageAck` | Yes | No |
| `roomLeave` | No | No |
| `threadSummarize` | No | No |

### What modes do today

All three modes follow the same pattern:
1. Lead opens room (auto-joins as lead)
2. Lead sends Finding messages targeted at agent roles
3. Lead blocks on `waitFor(Handoff)` for each agent
4. Lead sends `ReviewRequest` to verifier, blocks on `waitFor(ReviewResult)`
5. On failure: fix loop (send fix Finding, re-verify)
6. Lead closes room

Subagents are **passive message targets** — they never join the room, read
inbox, ack messages, or leave. The lead is the only active participant.

### What the neural_link server supports

The server implements the full protocol:
- **room_join** with role-based membership and agent_id mapping
- **inbox_read** for pulling pending messages
- **message_ack** for confirming message processing
- **room_leave** with drain semantics (blocks until outbound messages are acked)
- **Escalation** messages auto-sent when a participant leaves while others wait on them
- **Interaction modes** (adversarial, deliberative, informative, supervisory) with compliance tracking
- **Thread IDs** for multi-topic rooms

## Gap Analysis

### Missing adapter methods

1. **`roomLeave(roomId, participantId, timeoutMs?)`** — needed for drain semantics
2. **`threadSummarize(roomId, threadId?)`** — useful for multi-topic rooms

### Missing coordination patterns in modes

| Pattern | Description | Needed for |
|---------|-------------|------------|
| Subagent join | Agents call `roomJoin` on activation | Team mode |
| Inbox polling | Agents call `inboxRead` after work units | Bidirectional communication |
| Message ack | Agents call `messageAck` after processing | Flow control, drain |
| Drain on leave | Agents call `roomLeave` which blocks until acks clear | Clean handoff |
| Escalation handling | Lead responds to escalation messages | Fault tolerance |
| Interaction modes | Lead sets mode on `roomOpen`, agents discover on join | Review/deliberation |
| Thread separation | Multi-topic coordination uses `threadId` | Complex tasks |

## Design: Coordination Upgrade Path

### Principle: Incremental adoption

The modes should adopt richer semantics incrementally. Not every mode needs
every feature. The design introduces a **coordination layer** abstraction that
modes can opt into.

### Layer 1: Adapter completeness

Add missing methods to `NeuralLinkAdapter`:

```typescript
// adapters/neural_link/adapter.ts

async roomLeave(
  roomId: string,
  participantId: string,
  timeoutMs?: number,
): Promise<boolean>

async threadSummarize(
  roomId: string,
  threadId?: string,
): Promise<RoomSummary | null>
```

Type the `waitFor` return properly:

```typescript
interface WaitForMessage {
  message_id: string;
  from: string;
  kind: MessageKind;
  summary: string;
  body?: string;
  thread_id?: string;
  sequence: number;
}
```

Type the `inboxRead` return properly:

```typescript
interface InboxMessage extends WaitForMessage {
  to?: string;
  created_at: string;
}
```

### Layer 2: Coordination helpers

Create `kernel/coordination.ts` with reusable patterns that modes can compose:

```typescript
/**
 * Process pending inbox messages: read, handle each, ack.
 * Returns processed message count.
 */
async function drainInbox(
  nl: NeuralLinkAdapter,
  roomId: string,
  participantId: string,
  handler: (msg: InboxMessage) => Promise<void>,
): Promise<number>

/**
 * Wait for a specific message kind, processing inbox in between.
 * Unlike raw waitFor, this handles interleaved messages (blockers,
 * questions) that arrive while waiting.
 */
async function waitAndProcessInbox(
  nl: NeuralLinkAdapter,
  roomId: string,
  participantId: string,
  expectedKinds: MessageKind[],
  opts: {
    timeoutMs?: number;
    from?: string[];
    onInterleaved?: (msg: InboxMessage) => Promise<void>;
  },
): Promise<WaitForMessage | null>

/**
 * Standard participant lifecycle: join → work → handoff → leave.
 * Wraps the join/leave protocol with drain semantics.
 */
async function withParticipation<T>(
  nl: NeuralLinkAdapter,
  roomId: string,
  participant: { id: string; displayName: string; role?: string },
  work: (ctx: ParticipationContext) => Promise<T>,
): Promise<T>
```

### Layer 3: Mode-specific upgrades

#### Relay mode

Relay is inherently sequential — the lead drives each step. Minimal changes:
- **Add interaction mode:** Open room with `interactionMode: "supervisory"` since
  the lead monitors step-by-step execution
- **Add inbox processing between steps:** After each `waitFor(Handoff)`, call
  `drainInbox` to catch any interleaved blocker/question messages
- **Add thread IDs:** Each relay step gets its own `threadId` for traceability

#### Swarm mode

Swarm benefits most from richer coordination — it dispatches parallel tasks:
- **Add interaction mode:** Open room with `interactionMode: "informative"` for
  parallel execution, or `"deliberative"` when tasks have cross-dependencies
- **Replace raw waitFor loop with `waitAndProcessInbox`:** Handle blockers
  from parallel agents during the collection phase
- **Add escalation handling:** When collecting handoffs, if an agent fails and
  the lead receives an escalation (because another agent was waiting on it),
  the lead can re-dispatch or answer on behalf of the departed agent
- **Thread IDs per task:** Each swarm task gets `threadId: task.agentRole`

#### Scout mode

Scout is read-only exploration — lightest touch:
- **Add interaction mode:** `interactionMode: "informative"` (one-directional findings)
- **Process inbox after handoff collection:** Catch any late findings

### Layer 4: Team mode foundation (ovr-396.21)

With layers 1-3 in place, team mode (ovr-396.10) can build on top:
- Team members use `withParticipation` for lifecycle management
- Lead uses `waitAndProcessInbox` for monitoring
- Escalation handling is already in the lead's inbox loop
- Interaction mode is set based on team task type

## Adapter Interface Changes

### Current `NeuralLinkRelayAdapter` (per-mode interface)

Each mode defines its own adapter interface (e.g., `NeuralLinkRelayAdapter` in
relay.ts). These are minimal and only include the methods each mode uses.

### Proposed: Unified `NeuralLinkPort` interface

Replace per-mode interfaces with a shared port interface in `kernel/types.ts`:

```typescript
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
  waitFor(roomId: string, participantId: string, timeoutMs: number, kinds?: MessageKind[], from?: string[]): Promise<WaitForMessage | null>;

  // Introspection
  threadSummarize(roomId: string, threadId?: string): Promise<RoomSummary | null>;

  // Connection
  isConnected(): boolean;
}
```

Benefits:
- Single interface for all modes and coordination helpers
- Mock in tests via a single `MockNeuralLinkPort`
- Adapter implements the full port; modes use what they need

## Implementation Sequence (for ovr-396.21)

1. **Add `roomLeave` and `threadSummarize` to adapter** — adapter completeness
2. **Type `waitFor` and `inboxRead` return values** — remove `unknown` types
3. **Define `NeuralLinkPort` interface** — unify per-mode adapter interfaces
4. **Update `MockNeuralLinkAdapter`** to implement full port
5. **Create `kernel/coordination.ts`** — `drainInbox`, `waitAndProcessInbox`, `withParticipation`
6. **Upgrade relay mode** — interaction mode, inbox between steps, thread IDs
7. **Upgrade swarm mode** — inbox during collection, escalation handling, thread IDs
8. **Upgrade scout mode** — interaction mode, inbox after collection
9. **Update tests** for each mode with new coordination patterns

## Risks

| Risk | Mitigation |
|------|------------|
| neural_link server may not be running during kernel execution | Adapter already handles disconnection gracefully (returns null/false). Coordination helpers must propagate this — if inbox returns empty, assume no messages. |
| Inbox processing could slow down the critical path | `drainInbox` is called at natural pause points (between steps, after waitFor). No polling loops. |
| Escalation handling adds complexity to the lead loop | Start with logging escalations, then add re-dispatch in a follow-up. |
| Typed return values may break if neural_link server schema changes | Parse defensively; the types are internal to the adapter. |

## Decision Log

1. **Unified port interface vs per-mode interfaces:** Unified. The per-mode interfaces
   are already near-identical and will converge further with coordination upgrades.

2. **Coordination helpers in a separate module vs inline in modes:** Separate module
   (`kernel/coordination.ts`). The patterns (drain inbox, wait-and-process) are
   identical across modes — duplication would be a maintenance burden.

3. **Incremental adoption vs big-bang:** Incremental. Each mode can adopt richer
   semantics independently. Scout stays minimal, swarm gets the most benefit.

4. **`withParticipation` helper vs manual join/leave:** Helper. The join-work-leave
   lifecycle with drain semantics is error-prone to get right manually, especially
   the drain timeout handling.

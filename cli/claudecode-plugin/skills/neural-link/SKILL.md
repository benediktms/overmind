---
name: neural-link
description: Real-time agent-to-agent coordination via neural_link rooms. Use when multiple agents must coordinate, share findings, report blockers, or hand off work. Covers room lifecycle, message kinds, and inbox patterns. Full coordination semantics are documented in AGENTS.md — this skill provides the operational quick-reference.
triggers:
  - agent coordination
  - neural link
  - coordination room
  - multi-agent communication
  - agent messaging
---

## Room lifecycle

```
mcp__neural_link__room_open(title, participantId, displayName, purpose, interactionMode)
mcp__neural_link__room_join(roomId, participantId, displayName)
mcp__neural_link__message_send(roomId, from, kind, summary, to?, body?, threadId?)
mcp__neural_link__inbox_read(roomId, participantId)
mcp__neural_link__message_ack(roomId, participantId, messageIds[])
mcp__neural_link__wait_for(roomId, participantId, timeoutMs, kinds?)
mcp__neural_link__room_leave(roomId, participantId)
mcp__neural_link__room_close(roomId, resolution)  // resolution ∈ completed|cancelled|superseded|failed
```

Lead opens the room, workers join, all communicate via typed messages, workers
leave after sending a `handoff`, lead closes when done.

## Message kinds

| Kind             | Use                                           |
| ---------------- | --------------------------------------------- |
| `finding`        | Share a useful observation or discovery.      |
| `handoff`        | Summarize completed work before leaving.      |
| `blocker`        | Report something that prevents progress.      |
| `decision`       | Record a choice that others must follow.      |
| `question`       | Ask for clarification or direction.           |
| `answer`         | Respond directly to a question.               |
| `review_request` | Ask another agent to check the work.          |
| `review_result`  | Return feedback on reviewed work.             |
| `artifact_ref`   | Point to a file, task, or output.             |
| `summary`        | Give a short status update.                   |
| `challenge`      | Disagree with or test a proposal.             |
| `proposal`       | Suggest an approach for the room to consider. |
| `escalation`     | Surface an unresolved dependency to the lead. |

Use the narrowest kind that matches the intent.

## Interaction modes

Set on `room_open` via `interactionMode`. Compliance is tracked at room close.

- `informative` — agents report findings freely; lead synthesizes (scout,
  swarm).
- `supervisory` — lead directs each step; workers respond one at a time (relay).
- `adversarial` — every substantive claim is challenged before a decision
  (review, diagnosis).
- `deliberative` — multiple proposals weighed before consensus (architecture,
  trade-off analysis).

## Coordination rules

- One room per coordination concern.
- Keep related messages in the same thread via `threadId`.
- Read the inbox after meaningful work; acknowledge promptly so other agents do
  not stall.
- Always send `handoff` before `room_leave`.
- Close rooms as soon as the coordination goal is complete.
- State blockers early; do not duplicate work already owned by another agent.

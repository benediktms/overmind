---
name: neural-link
description: Neural Link coordination skill for Overmind. Use for agent-to-agent communication, room lifecycle management, inbox patterns, and multi-agent handoffs.
triggers:
  - agent coordination
  - neural link
  - coordination room
  - multi-agent communication
  - agent messaging
---

# Neural Link

## When to use neural_link

Use Neural Link when the work depends on multiple agents coordinating in real time.
It is the right skill for shared rooms, delegated subagents, inbox-driven updates, and explicit handoffs between participants.

Use it when you need one lead agent to coordinate several workers, a shared room for focused discussion, questions or blockers sent between agents, or a clean shutdown path after the work is complete.

Do not use it for single-agent work or as a general logging channel.

## Room lifecycle

The standard lifecycle is:

1. **open** a room for the coordination concern.
2. **join** as the required participant.
3. **communicate** through typed messages and inbox checks.
4. **leave** only after the agent has handed off its work.
5. **close** the room once everyone is finished.

The lead opens the room and tracks progress.
Subagents join, do the work, report results, and leave cleanly.
Every room should end with a clear resolution so no one is left waiting.

## Message kinds table

| Kind | Use |
| --- | --- |
| `finding` | Share a useful observation or discovery. |
| `handoff` | Summarize completed work before leaving. |
| `blocker` | Report something that prevents progress. |
| `decision` | Record a choice that others must follow. |
| `question` | Ask for clarification or direction. |
| `answer` | Respond directly to a question. |
| `review_request` | Ask another agent to check the work. |
| `review_result` | Return feedback on reviewed work. |
| `artifact_ref` | Point to a file, task, or output. |
| `summary` | Give a short status update. |
| `challenge` | Disagree with or test a proposal. |
| `proposal` | Suggest an approach for the room to consider. |
| `escalation` | Surface an unresolved dependency to the lead. |

Prefer the narrowest message kind that matches the intent.
Clear typing makes room threads easier to scan and reduces coordination noise.

## Coordination patterns

- Use a single room per coordination concern.
- Keep related messages in the same thread when possible.
- Read the inbox after meaningful work, and acknowledge messages promptly so other agents do not stall.
- Use `handoff` before `room_leave` to preserve context for the lead.

When a subagent depends on another participant, wait for the needed answer instead of guessing.
When the lead needs progress from several workers, collect concise findings and then make a decision.

## Best practices

- Be brief, specific, and action-oriented.
- State blockers early so the lead can unblock them.
- Do not duplicate work already owned by another agent.
- Close rooms as soon as the coordination goal is complete.
- Treat the room as shared operational space, not a note dump.

If a room becomes noisy, summarize the current state and reset the thread structure.
If a participant leaves early, make sure the remaining agents still have a clear path to completion.

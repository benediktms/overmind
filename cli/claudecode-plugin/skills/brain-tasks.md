---
name: brain-tasks
description: Creates and manages brain tasks for tracking multi-step work, bugs, and research spikes that outlive a single session. Use when work needs explicit lifecycle tracking across sessions or when coordinating dependent subtasks. The kernel auto-manages task state for active Overmind runs; invoke manually for standalone tracking needs.
triggers:
  - task_created
  - task_updated
  - task_completed
  - create_ticket
  - track_work
---

## Creating and closing tasks

```
mcp__brain__tasks_create(title: string, description?: string, priority?: 0-4)
mcp__brain__tasks_close(task_ids: string[])
mcp__brain__tasks_apply_event(task_id: string, event_type: string, payload: object)
```

## Priority scale

| Priority | Level    | Use case                          |
| -------- | -------- | --------------------------------- |
| 0        | Critical | P0 outage, security vulnerability |
| 1        | High     | Must-have for milestone           |
| 2        | Medium   | Should-have, nice improvements    |
| 3        | Low      | Could-have, minor polish          |
| 4        | Backlog  | Future consideration              |

## Task naming

Good: "Add circuit breaker for payments API", "Investigate memory leak in worker
process". Bad: "fix bug", "work on payments".

## Dependencies

Chain tasks with `mcp__brain__tasks_deps_batch`:

```
mcp__brain__tasks_deps_batch(action: "chain", task_ids: ["BRN-01", "BRN-02", "BRN-03"])
```

## Kernel auto-lifecycle

For active Overmind runs, the kernel manages task state automatically:

| Event                   | Action                                             |
| ----------------------- | -------------------------------------------------- |
| `objective_received`    | `tasks_create` — task created with objective title |
| `agent_started_working` | `tasks_apply_event` — status → in_progress         |
| `agent_finished`        | `tasks_close` — status → done                      |
| `agent_error`           | `tasks_apply_event` — status → blocked with reason |

Manual invocation is for work tracked outside a kernel-managed run.

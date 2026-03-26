---
name: brain-tasks
description: Guidelines for task creation and updates via brain. Use when creating tickets for multi-step features, bugs that can't be fixed immediately, or work that needs tracking.
triggers:
  - task_created
  - task_updated
  - task_completed
  - create_ticket
  - track_work
---

# Brain Task Management

Use brain tasks to track multi-step work, bugs, and researchspikes that outlive a single session.

## Auto-Lifecycle

Overmind kernel automatically handles task state transitions:

| Event | Action |
|-------|--------|
| `objective_received` | `tasks_create` — task created with objective title |
| `agent_started_working` | `tasks_update` — status → in_progress |
| `agent_finished` | `tasks_close` — status → done |
| `agent_error` | `tasks_update` — status → blocked with error reason |

## Manual Task Operations

Use `mcp__brain__tasks_*` tools:

```
mcp__brain__tasks_create --title "..." --description "..." --priority 2
mcp__brain__tasks_apply_event --task_id "..." --event_type "status_changed" --payload '{"new_status":"done"}'
mcp__brain__tasks_close --task_ids "BRN-01,BRN-02"
```

Or via brain CLI:

```bash
brain tasks create --title "..."
brain tasks close <id>
```

## Priority Scale

| Priority | Level | Use Case |
|----------|-------|----------|
| 0 | Critical | P0 outage, security vulnerability |
| 1 | High | Must-have for milestone |
| 2 | Medium | Should-have, nice improvements |
| 3 | Low | Could-have, minor polish |
| 4 | Backlog | Future consideration |

## Task Naming

- ✅ "Add circuit breaker for payments API"
- ✅ "Investigate memory leak in worker process"  
- ❌ "fix bug" or "work on payments"

## Dependencies

Use `mcp__brain__tasks_deps_batch` to set up dependencies:

```
mcp__brain__tasks_deps_batch --action chain --task_ids '["BRN-01", "BRN-02", "BRN-03"]'
```

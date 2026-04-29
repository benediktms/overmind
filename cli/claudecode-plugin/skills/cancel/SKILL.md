---
name: cancel
description: Stops an active Overmind run cleanly via the kernel cancel API. Use when the current objective is no longer wanted, the run is producing the wrong result, or the user asks to stop. Applies to scout, relay, and swarm modes.
triggers:
  - cancel overmind
  - stop mode
  - abort execution
  - exit overmind
  - cancel swarm
---

To cancel an active Overmind run, call:

```
mcp__overmind__overmind_cancel(objective_id)
```

`objective_id` is required. Get it from `mcp__overmind__overmind_status` if the
user has not provided it.

The kernel handles the rest: it signals the active mode to abort, closes the
neural_link room, marks the brain task `cancelled`, and clears run state. No
manual cleanup is required.

After the call succeeds, confirm the outcome to the user: which mode was
stopped, and whether any partial results were preserved.

If `mcp__overmind__overmind_cancel` is unavailable, instruct the user to
interrupt the process directly (Ctrl+C or equivalent) and manually close any
open neural_link rooms via `mcp__neural_link__room_close`.

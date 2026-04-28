---
name: setup
description: Validates that an Overmind workspace is wired up correctly before delegating work. There is no first-run bootstrap — configuration lives in environment variables read by the bridge. Use to surface missing env vars, confirm brain reachability, and confirm the neural_link MCP is responsive.
triggers:
  - setup overmind
  - configure overmind
  - initialize overmind
  - verify overmind
  - overmind setup
---

## Required environment variables

The bridge reads these from the environment. None has a default; missing values
fail at the first MCP call.

- `OVERMIND_NEURAL_LINK_URL` — neural_link MCP URL.
- `OVERMIND_KERNEL_HTTP_URL` — kernel HTTP endpoint.
- `OVERMIND_PARTICIPANT_ID` — identity used when joining rooms.
- `OVERMIND_ROOM_ID` — preconfigured room identifier (optional, only when
  reusing an existing room).

## Validation sequence

1. Confirm each required env var is set in the current shell.
2. Probe brain via `mcp__brain__status`. A non-error response means the brain
   MCP is reachable.
3. Probe neural_link by opening then immediately closing a throwaway room:
   `mcp__neural_link__room_open` followed by `mcp__neural_link__room_close` with
   `resolution: "completed"`.
4. Report any failure with the specific env var, MCP tool, and observed error.

## Out of scope

There is no `.overmind/` directory or first-run bootstrap. The plugin reads env
vars and writes only what the active mode requires (e.g., brain task IDs,
neural_link room IDs). Do not invent setup steps not listed above.

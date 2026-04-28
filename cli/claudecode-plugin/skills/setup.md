---
name: setup
description: First-run configuration and connection validation for an Overmind workspace. Use when initializing Overmind in a fresh repository, reconfiguring an existing one, or verifying that the environment is ready before delegating work.
triggers:
  - setup overmind
  - configure overmind
  - initialize overmind
  - first run
  - overmind setup
---

## Setup sequence

1. Check whether `.overmind/` exists; create the directory structure if missing.
2. Write or refresh local configuration values (brain endpoint, neural_link URL,
   workspace identifiers, environment variables).
3. Validate brain services are reachable via `mcp__brain__status`.
4. Validate neural_link can accept room and message traffic via
   `mcp__neural_link__room_open` + immediate `mcp__neural_link__room_close`.
5. Confirm the workspace is ready for the selected execution mode.

When project-level and user-level config values conflict, prefer the
project-specific settings in `.overmind/`. If a required value is missing, stop
with a clear explanation of what must be provided before proceeding.

## Required configuration

- Brain endpoint or project binding.
- `OVERMIND_NEURAL_LINK_URL` — neural_link MCP URL.
- `OVERMIND_KERNEL_HTTP_URL` — kernel HTTP endpoint (if using HTTP transport).
- Workspace identifiers used by the active mode.

## Troubleshooting

| Symptom                            | Check                                           |
| ---------------------------------- | ----------------------------------------------- |
| `.overmind/` missing or unwritable | File permissions or wrong working directory     |
| Brain unreachable                  | Authentication, endpoint URL, network access    |
| neural_link offline                | `OVERMIND_NEURAL_LINK_URL` value, MCP server    |
| Config mismatch                    | Project vs. user layer conflict; prefer project |
| Partial state from previous run    | Inspect existing files before overwriting       |

If any check fails, fix the configuration and re-run setup from the beginning.

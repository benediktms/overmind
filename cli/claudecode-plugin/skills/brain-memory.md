---
name: brain-memory
description: Records important context to brain memory for cross-session continuity. Use when discovering external API quirks, architectural decisions, business logic constraints, or workarounds that should survive beyond the current session. The kernel auto-records `external_discovery` and `decision_made` events; invoke manually for anything else worth preserving.
triggers:
  - external_discovery
  - decision_made
  - architecture_decision
  - api_behavior
  - important_context
---

Record discoveries and decisions with `mcp__brain__memory_write_episode`:

```
mcp__brain__memory_write_episode(
  goal: string,    // What you were trying to understand or accomplish
  actions: string, // Key facts discovered, decisions made, or actions taken
  outcome: string  // How this should influence future work
)
```

## What to record

- **External API behavior**: quirks, undocumented behavior, rate limits, expiry
  windows.
- **Architecture decisions**: why a particular approach was chosen over
  alternatives.
- **Business constraints**: domain rules, historical decisions, compliance
  requirements.
- **Gotchas and workarounds**: non-obvious behaviors discovered during
  investigation.

## Example

```
goal: Understand how the payments API handles idempotency
actions: |
  API requires Idempotency-Key header for POST requests.
  Keys expire after 24 hours.
  Duplicate requests within expiry window return 409 Conflict.
  Response includes X-Idempotency-Replayed: true header.
outcome: Always include Idempotency-Key for payment mutations; store keys in DB with order_id for retry safety.
```

## Auto-recording

The Overmind kernel automatically records `external_discovery` and
`decision_made` events to brain memory. Manual invocation is for discoveries
that do not surface through kernel event flow.

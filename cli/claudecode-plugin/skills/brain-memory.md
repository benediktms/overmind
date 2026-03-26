---
name: brain-memory
description: Guidelines for recording important context to brain memory. Use when you discover important architecture decisions, external API behavior, or business logic that should be preserved.
triggers: external_discovery, decision_made, architecture_decision, api_behavior, important_context
---

# Brain Memory Recording

Record important discoveries and decisions to brain for future reference and cross-session continuity.

## When to Record

- **External discoveries**: API quirks, undocumented behavior, rate limits
- **Architecture decisions**: Why a particular approach was chosen over alternatives
- **Business context**: Domain rules, constraints, historical decisions
- **Gotchas**: Workarounds discovered during investigation

## How to Record

Use the `mcp__brain__memory_write_episode` tool:

```
mcp__brain__memory_write_episode --goal "..." --actions "..." --outcome "..."
```

Or via the brain CLI:

```bash
brain memory write-episode --goal "..." --actions "..." --outcome "..."
```

## Episode Format

- **goal**: What you were trying to understand or accomplish
- **actions**: Key facts discovered, decisions made, actions taken
- **outcome**: How this should influence future work

## Auto-Recording

Overmind kernel automatically records these event types to brain:
- `external_discovery` → finding recorded to brain memory
- `decision_made` → decision recorded to brain memory

## Example

```
goal: Understand how the payments API handles idempotency
actions: 
  - API requires Idempotency-Key header for POST requests
  - Keys expire after 24 hours
  - Duplicate requests within expiry window return 409 Conflict
  - Response includes X-Idempotency-Replayed: true header
outcome: Always include Idempotency-Key header for payment mutations; store keys in DB with order_id for retry safety
```

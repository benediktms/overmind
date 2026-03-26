---
name: overmind-reference
description: Reference skill for Overmind capabilities, modes, agents, tools, and configuration. Use when asked what Overmind can do or how its help surface is organized.
triggers:
  - overmind help
  - what can overmind do
  - available modes
  - overmind capabilities
  - how to use overmind
---

# Overmind Reference

## Overview

Overmind is a multi-agent orchestration layer for Claude Code and OpenCode.
It combines execution modes, specialist agents, brain-backed memory and tasks, and neural_link coordination.

Use this skill as the canonical “help page” when you need a quick map of what Overmind offers and where each capability belongs.

## Modes

| Mode | Shape | Best for |
| --- | --- | --- |
| scout | Parallel context gathering | Early discovery, repository mapping, unknown scope |
| relay | Sequential plan/execute/verify flow | Clear work with ordered gates and stepwise checks |
| swarm | Parallel execution with verify/fix loops | Larger work that can split into independent lanes |

## Agents

| Agent | Role |
| --- | --- |
| cortex | Senior architecture and debugging brain for hard problems |
| archivist | Documentation, repository exploration, and knowledge preservation |
| probe | Fast search, file mapping, and usage tracing |
| liaison | UI/UX, presentation, and external-facing communication |

## Available tools

### Overmind MCP endpoints

| Endpoint | Purpose |
| --- | --- |
| mcp__overmind__overmind_delegate | Start coordinated work in scout, relay, or swarm mode |
| mcp__overmind__overmind_status | Inspect current orchestration state |
| mcp__overmind__overmind_cancel | Stop an active objective |
| mcp__overmind__overmind_room_join | Join a neural_link room from the Overmind side |

### Brain MCP endpoints

| Endpoint | Purpose |
| --- | --- |
| mcp__brain__tasks_create | Create tracked work items |
| mcp__brain__tasks_apply_event | Update task state or attach notes |
| mcp__brain__tasks_close | Mark tracked work complete |
| mcp__brain__memory_write_episode | Record durable context or decisions |

## Configuration reference

Overmind reads configuration from the user and project layers.
The common environment variables wire the kernel, room, and participant identity:

| Setting | Meaning |
| --- | --- |
| OVERMIND_NEURAL_LINK_URL | MCP URL for neural_link coordination |
| OVERMIND_ROOM_ID | Preconfigured room identifier |
| OVERMIND_KERNEL_HTTP_URL | Direct kernel HTTP endpoint |
| OVERMIND_PARTICIPANT_ID | Swarm participant identity |

Use the config layer to point Overmind at the right room, transport, and identity before delegating work.

## Quick start

1. Ask whether the work is best handled by scout, relay, or swarm.
2. Pick the agent that matches the problem: cortex, archivist, probe, or liaison.
3. Delegate with the appropriate Overmind MCP endpoint.
4. Use brain tasks for work that needs tracking or memory for durable findings.
5. Configure neural_link settings when coordination across agents is required.

That is the shortest path from “what can Overmind do?” to “how do I use it?”

# Overmind

Agent orchestration framework for Claude Code and OpenCode.

## Overview

Overmind is a multi-agent orchestration framework that coordinates specialized agents to accomplish complex software engineering tasks. It provides:

- **Execution modes**: scout (parallel context gathering), relay (sequential pipeline), swarm (parallel with verify/fix loops)
- **Brain integration**: Persistent task and memory management
- **neural_link integration**: Agent-to-agent communication and coordination
- **Skills system**: Auto-injected context-aware capabilities

## Architecture

```
overmind/
├── kernel/           # Core orchestration engine
├── adapters/        # Platform adapters (Claude Code, OpenCode)
├── skills/          # Skill definitions
├── config/          # Configuration
└── cli/             # CLI tools
```

## Installation

```bash
just install
```

## Configuration

Config is read from:
- `~/.config/overmind/overmind.toml` (user level)
- `.overmind/` (project level)

## Usage

```bash
just dev    # Run in development mode
just test   # Run tests
```

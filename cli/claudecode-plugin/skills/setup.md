---
name: setup
description: Setup skill for Overmind. Use for first-run configuration, project initialization, and connection checks before active work begins.
triggers:
  - setup overmind
  - configure overmind
  - initialize overmind
  - first run
  - overmind setup
---

# Overmind Setup

## What it does

Setup is the first-run skill for preparing an Overmind workspace.
It covers project-level configuration, local state, and connection validation before any mode starts.

The goal is to leave the repository ready for normal Overmind execution.
That includes creating the `.overmind/` directory structure and confirming brain and neural_link access.
## Usage

Use this skill when you are setting up Overmind in a fresh repository or reconfiguring an existing one.
It is the right entry point when the user asks to initialize, configure, or bootstrap Overmind.
Typical situations include:

- first time running Overmind in a project
- moving Overmind into a new workspace
- repairing a broken local configuration
- verifying that the environment is ready before delegate work starts
## First-run steps

The expected setup sequence is:

1. Detect whether `.overmind/` already exists.
2. Create the project directory structure if it is missing.
3. Write or refresh the local configuration values.
4. Validate that brain services are reachable.
5. Validate that neural_link can accept room and message traffic.
6. Confirm the workspace is ready for the selected execution mode.

This skill is descriptive only.
Actual setup actions are implemented elsewhere and should follow this order.
## Configuration

Overmind setup usually combines project-local and user-level configuration.
The project layer belongs in `.overmind/`, while shared defaults live in the user's Overmind config.

Common settings to confirm:

- brain endpoint or project binding
- neural_link URL or room settings
- workspace identifiers used by the active mode
- any required environment variables for CLI integration

When values conflict, prefer the project-specific settings for this repository.
If a required value is missing, stop with a clear explanation of what needs to be provided.

## Troubleshooting

If setup fails, check the basics first:

- `.overmind/` was not created or is not writable
- brain is unavailable or not authenticated
- neural_link is offline or pointing at the wrong URL
- config values do not match the current workspace
- a previous setup left partial state behind

The best recovery path is usually to fix the configuration, then rerun setup from the beginning.
If partial files already exist, inspect them before overwriting anything important.

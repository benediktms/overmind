---
name: cancel
description: Cancel Mode skill for Overmind. Use when you need to stop the active execution mode cleanly and return the system to a safe idle state.
triggers:
  - cancel overmind
  - stop mode
  - abort execution
  - exit overmind
  - cancel swarm
---

# Cancel Mode

## What it does

Cancel Mode is the utility skill for stopping an active Overmind run without leaving dangling coordination state behind.
It is intended to shut down the current mode safely, preserve useful outcomes, and leave the workspace ready for the next task.

This skill covers the user-facing intent and the expected cleanup sequence.
The actual cancel orchestration is implemented elsewhere.

## Usage

Use this skill when you want to end the current Overmind session, stop ongoing agent work, or exit from a running mode.
It applies whether the active mode is scout, relay, or swarm.

Typical signals include:

- the current objective is no longer wanted
- the run is producing the wrong result
- the user explicitly asks to stop the mode
- a safer reset is preferred over continuing the current flow

## How it works (auto-detection of active mode)

Cancel Mode is designed to inspect `.overmind/state/` and determine which mode is active before taking action.
It should detect whether the current run belongs to scout, relay, or swarm, then follow the matching shutdown path.

The expected detection flow is:

1. Read `.overmind/state/` for active mode markers and room references.
2. Identify any live neural_link room attached to the run.
3. Determine whether there are pending brain tasks or delegated work items.
4. Choose the cleanest shutdown path for the detected mode.

The skill is intentionally mode-aware so the same cancel intent works across all Overmind execution styles.

## State cleanup

Cleanup is aspirational and should happen in order:

1. Read `.overmind/state/` to detect the active mode.
2. Close the neural_link room if one is open.
3. Update brain tasks to `cancelled` or `done` as appropriate.
4. Clear mode state files so the next run starts cleanly.
5. Report a concise summary of what was stopped and what was preserved.

Cleanup should prefer safety over aggression.
If part of the run already completed, preserve that outcome instead of discarding it.

## Messages

Cancel Mode should communicate clearly and briefly.
Good cancellation messages include the detected mode, the cleanup actions taken, and any remaining manual follow-up.

Example message shape:

- `Detected active mode: swarm`
- `Closed neural_link room`
- `Marked 3 tasks cancelled`
- `Cleared mode state files`
- `Run cancelled cleanly`

If cleanup cannot finish automatically, the message should say exactly what remains so a human can finish it safely.

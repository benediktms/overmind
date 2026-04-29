#!/usr/bin/env -S deno run --allow-all
//
// Unified `overmind` binary entrypoint. Dispatches by argv[0]:
//   overmind mcp           → stdio MCP server (replaces the old Node bridge)
//   overmind daemon ...    → daemon lifecycle (start/stop/status)
//   overmind <anything>    → existing CLI (delegate, status, doctor, ...)
//
// This is the file consumed by `deno compile`. The compiled artifact is what
// `~/.local/bin/overmind` symlinks to, and what Claude Code launches when
// invoking the MCP server.

import { runCli } from "./main.ts";
import { daemonStatus, restartDaemon, runDaemon, stopDaemon } from "../kernel/daemon.ts";
import { runMcp } from "./mcp_server.ts";

function resolveBinaryPath(): string {
  // When running compiled, Deno.execPath() is the path to the compiled
  // overmind binary itself — exactly what we want to re-spawn for restart.
  // When running via `deno run cli/overmind.ts`, this would be the deno
  // binary; users in dev should prefer `just daemon-restart` in that case.
  return Deno.execPath();
}

async function runDaemonCommand(args: string[]): Promise<number> {
  const sub = args[0] ?? "start";
  const baseDir = Deno.env.get("OVERMIND_BASE_DIR") ?? undefined;

  switch (sub) {
    case "start":
      // Returns never; the daemon process blocks here forever.
      await runDaemon();
      return 0;

    case "stop": {
      const msg = await stopDaemon(baseDir);
      console.log(msg);
      return 0;
    }

    case "status": {
      const status = await daemonStatus(baseDir);
      if (status.running) {
        console.log(`Daemon is running (PID ${status.pid})`);
      } else if (status.stale && status.pid !== null) {
        console.log(`Daemon is not running (stale PID file for ${status.pid})`);
      } else {
        console.log("Daemon is not running");
      }
      return status.running ? 0 : 1;
    }

    case "restart": {
      const msg = await restartDaemon(resolveBinaryPath(), baseDir);
      console.log(msg);
      return 0;
    }

    default:
      console.error(`Unknown daemon subcommand: ${sub}`);
      console.error(`Usage: overmind daemon <start|stop|status|restart>`);
      return 1;
  }
}

async function main(): Promise<number> {
  const [first, ...rest] = Deno.args;

  switch (first) {
    case "mcp":
      await runMcp();
      return 0;

    case "daemon":
      return await runDaemonCommand(rest);

    default:
      // Fall through to the legacy CLI dispatcher with the original argv.
      return await runCli(Deno.args);
  }
}

if (import.meta.main) {
  Deno.exit(await main());
}

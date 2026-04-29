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
import { runDaemon } from "../kernel/daemon.ts";
import { runMcp } from "./mcp_server.ts";

async function runDaemonCommand(args: string[]): Promise<number> {
  const sub = args[0] ?? "start";

  switch (sub) {
    case "start":
      // Returns never; the daemon process blocks here forever.
      await runDaemon();
      return 0;

    case "stop":
    case "status":
    case "restart":
      console.error(`overmind daemon ${sub}: not yet implemented as a subcommand`);
      console.error(`Use the justfile recipes (\`just daemon-stop\`, \`just daemon-restart\`) for now.`);
      return 1;

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

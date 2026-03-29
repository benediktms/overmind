#!/usr/bin/env -S deno run --allow-all

import { parseArgs } from "@std/cli/parse-args";
import { ensureDaemonRunning, sendToSocket } from "../kernel/daemon.ts";
import { Kernel } from "../kernel/kernel.ts";
import { Mode } from "../kernel/types.ts";
import { readActiveModeState, readCapabilities } from "../kernel/persistence.ts";
import { join } from "@std/path";
import { exists } from "@std/fs";

const OVERMIND_VERSION = "0.2.0";
const DEFAULT_BASE_DIR = `${Deno.env.get("HOME") ?? "."}/.overmind`;

interface CliContext {
  baseDir: string;
  verbose: boolean;
}

function printHelp(): void {
  console.log(`
overmind v${OVERMIND_VERSION} - Multi-agent orchestration CLI

USAGE:
  overmind <command> [options]

COMMANDS:
  delegate <objective>    Delegate work to Overmind
    --mode, -m <mode>     Execution mode: scout, relay, swarm (default: scout)
    --priority, -p <n>    Priority 0-4 (default: 2)

  status                  Check kernel and active runs status
  cancel <run-id>         Cancel a running objective
  doctor                  Diagnose installation and configuration issues
  setup                   Run setup wizard
  room join <room-id>     Join a coordination room
  skill <subcommand>      Manage skills (list, add, remove)
  version                 Show version
  help                    Show this help

ENVIRONMENT:
  OVERMIND_BASE_DIR       Base directory for state (default: ~/.overmind)
  OVERMIND_KERNEL_HTTP_URL Kernel HTTP endpoint

EXAMPLES:
  overmind delegate "Refactor auth module" --mode relay
  overmind status
  overmind doctor
  overmind setup
`);
}

async function cmdDelegate(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parseArgs(args, {
    string: ["mode", "priority"],
    alias: { m: "mode", p: "priority" },
    default: { mode: "scout", priority: "2" },
  });

  const objective = parsed._.join(" ").trim();
  if (!objective) {
    console.error("Error: Objective required. Usage: overmind delegate <objective> --mode <mode>");
    return 1;
  }

  const mode = parsed.mode as Mode;
  if (![Mode.Scout, Mode.Relay, Mode.Swarm].includes(mode)) {
    console.error(`Error: Invalid mode '${mode}'. Use: scout, relay, swarm`);
    return 1;
  }

  const priority = parseInt(parsed.priority, 10);
  if (isNaN(priority) || priority < 0 || priority > 4) {
    console.error("Error: Priority must be 0-4");
    return 1;
  }

  console.log(`Delegating to Overmind (${mode} mode)...`);
  console.log(`Objective: ${objective}`);

  try {
    await ensureDaemonRunning(ctx.baseDir);

    const runId = `run-${crypto.randomUUID()}`;
    const response = await sendToSocket(
      {
        type: "mode_request",
        run_id: runId,
        mode,
        objective,
        workspace: Deno.cwd(),
        config_override: { max_fix_cycles: mode === Mode.Scout ? 0 : 3 },
      },
      `${ctx.baseDir}/daemon.sock`,
    );

    if (response.status === "accepted") {
      console.log(`✓ Accepted (run_id: ${response.run_id})`);
      console.log(`  Mode: ${mode}`);
      console.log(`  Check status with: overmind status`);
      return 0;
    } else {
      console.error(`✗ Failed: ${response.error ?? "Unknown error"}`);
      return 1;
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function cmdStatus(_args: string[], ctx: CliContext): Promise<number> {
  console.log("Overmind Status");
  console.log("===============");

  const socketPath = `${ctx.baseDir}/daemon.sock`;
  const pidPath = `${ctx.baseDir}/daemon.pid`;

  let daemonRunning = false;
  try {
    const pid = await Deno.readTextFile(pidPath);
    const processExists = await checkProcessExists(parseInt(pid.trim(), 10));
    if (processExists) {
      await Deno.stat(socketPath);
      daemonRunning = true;
    }
  } catch {
  }

  console.log(`\nDaemon: ${daemonRunning ? "✓ Running" : "✗ Not running"}`);
  if (daemonRunning) {
    try {
      const pid = await Deno.readTextFile(pidPath);
      console.log(`  PID: ${pid.trim()}`);
  } catch {
  }
  }

  const capabilities = await readCapabilities(Deno.cwd());
  if (capabilities) {
    console.log(`\nPersistence:`);
    console.log(`  Brain: ${capabilities.brain.available ? "✓ Available" : "✗ Unavailable"}`);
    console.log(`  Status: ${capabilities.brain.status}`);
    console.log(`  Brain Name: ${capabilities.brain.brainName}`);
  }

  const activeState = await readActiveModeState(Deno.cwd());
  if (activeState?.active) {
    console.log(`\nActive Run:`);
    console.log(`  Run ID: ${activeState.run_id}`);
    console.log(`  Mode: ${activeState.mode}`);
    console.log(`  State: ${activeState.state}`);
    console.log(`  Started: ${activeState.started_at}`);
    if (activeState.checkpoint_summary) {
      console.log(`  Progress: ${activeState.checkpoint_summary}`);
    }
  } else {
    console.log("\nActive Run: None");
  }

  const stateDir = join(Deno.cwd(), ".overmind", "state");
  const stateExists = await exists(stateDir);
  console.log(`\nState Directory: ${stateExists ? stateDir : "Not initialized"}`);

  return 0;
}

async function cmdCancel(args: string[], _ctx: CliContext): Promise<number> {
  const runId = args[0];
  if (!runId) {
    console.error("Error: Run ID required. Usage: overmind cancel <run-id>");
    return 1;
  }

  console.log(`Cancelling run: ${runId}`);
  console.log("Note: Cancellation is cooperative. Run will stop at next checkpoint.");
  console.log("(Cancellation mechanism not yet implemented in kernel)");

  return 0;
}

async function cmdDoctor(_args: string[], ctx: CliContext): Promise<number> {
  console.log("Overmind Doctor");
  console.log("===============\n");

  let issues = 0;
  let checks = 0;

  checks++;
  const baseExists = await exists(ctx.baseDir);
  if (baseExists) {
    console.log(`✓ Base directory exists: ${ctx.baseDir}`);
  } else {
    console.log(`✗ Base directory missing: ${ctx.baseDir}`);
    console.log(`  Fix: Run 'overmind setup' to initialize`);
    issues++;
  }

  checks++;
  const socketPath = `${ctx.baseDir}/daemon.sock`;
  const socketExists = await exists(socketPath);
  if (socketExists) {
    console.log(`✓ Daemon socket exists: ${socketPath}`);
  } else {
    console.log(`⚠ Daemon socket not found: ${socketPath}`);
    console.log(`  Note: Daemon will start automatically on first delegate command`);
  }

  checks++;
  const capabilities = await readCapabilities(Deno.cwd());
  if (capabilities?.brain.available) {
    console.log(`✓ Brain persistence available (${capabilities.brain.brainName})`);
  } else if (capabilities?.brain.enabled) {
    console.log(`⚠ Brain enabled but unavailable (${capabilities.brain.status})`);
    console.log(`  Check: Ensure 'brain' CLI is installed and 'brain mcp' works`);
  } else {
    console.log(`⚠ Brain persistence disabled`);
    console.log(`  Note: Running in local-only mode. State will not persist to Brain.`);
  }

  checks++;
  const pluginDir = `${Deno.env.get("HOME") ?? ""}/.claude/plugins/overmind`;
  const pluginExists = await exists(pluginDir);
  if (pluginExists) {
    console.log(`✓ Claude Code plugin installed: ${pluginDir}`);
  } else {
    console.log(`⚠ Claude Code plugin not installed`);
    console.log(`  Run: ./cli/claudecode-plugin/scripts/install.ts`);
  }

  checks++;
  const projectStateDir = join(Deno.cwd(), ".overmind", "state");
  const projectStateExists = await exists(projectStateDir);
  if (projectStateExists) {
    console.log(`✓ Project state directory exists: ${projectStateDir}`);
  } else {
    console.log(`⚠ Project state directory missing`);
    console.log(`  Will be created on first run`);
  }

  console.log(`\n${checks} checks, ${issues} issues`);

  if (issues === 0) {
    console.log("\n✓ All critical checks passed");
  } else {
    console.log(`\n✗ ${issues} issue(s) need attention`);
  }

  return issues > 0 ? 1 : 0;
}

async function cmdSetup(_args: string[], ctx: CliContext): Promise<number> {
  console.log("Overmind Setup Wizard");
  console.log("=====================\n");

  console.log(`Creating base directory: ${ctx.baseDir}`);
  await Deno.mkdir(ctx.baseDir, { recursive: true });
  console.log("✓ Base directory ready\n");

  console.log("Checking Brain availability...");
  try {
    const brainCheck = new Deno.Command("brain", { args: ["--version"] });
    const result = await brainCheck.output();
    if (result.success) {
      const version = new TextDecoder().decode(result.stdout).trim();
      console.log(`✓ Brain found: ${version}`);
      console.log("  Persistence will use Brain for durable checkpoints\n");
    } else {
      console.log("⚠ Brain not found in PATH");
      console.log("  Install from: https://github.com/ben-xD/brain");
      console.log("  Overmind will work in local-only mode\n");
    }
  } catch {
    console.log("⚠ Brain not found in PATH");
    console.log("  Install from: https://github.com/ben-xD/brain");
    console.log("  Overmind will work in local-only mode\n");
  }

  const projectStateDir = join(Deno.cwd(), ".overmind", "state");
  console.log(`Creating project state directory: ${projectStateDir}`);
  await Deno.mkdir(projectStateDir, { recursive: true });
  console.log("✓ Project state directory ready\n");

  console.log("Claude Code Plugin:");
  console.log("  To install the Claude Code plugin, run:");
  console.log(`  deno run --allow-all cli/claudecode-plugin/scripts/install.ts\n`);

  console.log("Setup complete!");
  console.log("Try: overmind delegate \"Your objective here\" --mode scout");

  return 0;
}

async function cmdRoom(args: string[], _ctx: CliContext): Promise<number> {
  if (args[0] !== "join") {
    console.error("Error: Unknown room command. Usage: overmind room join <room-id>");
    return 1;
  }

  const roomId = args[1];
  if (!roomId) {
    console.error("Error: Room ID required. Usage: overmind room join <room-id>");
    return 1;
  }

  console.log(`Joining room: ${roomId}`);
  console.log("Note: Room joining is handled via MCP tool overmind_room_join");
  console.log("Use this from Claude Code with: @overmind room join");

  return 0;
}

async function cmdSkill(args: string[], _ctx: CliContext): Promise<number> {
  const subcommand = args[0];

  switch (subcommand) {
    case "list":
      console.log("Skills:");
      console.log("  (Skill management not yet implemented)");
      return 0;

    case "add":
      console.log("Add skill: (not yet implemented)");
      return 0;

    case "remove":
      console.log("Remove skill: (not yet implemented)");
      return 0;

    default:
      console.error("Error: Unknown skill command. Usage: overmind skill {list|add|remove}");
      return 1;
  }
}

async function cmdVersion(): Promise<number> {
  console.log(`overmind v${OVERMIND_VERSION}`);
  return 0;
}

async function checkProcessExists(pid: number): Promise<boolean> {
  try {
    const cmd = new Deno.Command("kill", { args: ["-0", pid.toString()] });
    const result = await cmd.output();
    return result.success;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const args = Deno.args;
  const command = args[0];

  const baseDir = Deno.env.get("OVERMIND_BASE_DIR") ?? DEFAULT_BASE_DIR;
  const verbose = args.includes("--verbose") || args.includes("-v");

  const ctx: CliContext = { baseDir, verbose };

  switch (command) {
    case "delegate":
      return await cmdDelegate(args.slice(1), ctx);

    case "status":
      return await cmdStatus(args.slice(1), ctx);

    case "cancel":
      return await cmdCancel(args.slice(1), ctx);

    case "doctor":
      return await cmdDoctor(args.slice(1), ctx);

    case "setup":
      return await cmdSetup(args.slice(1), ctx);

    case "room":
      return await cmdRoom(args.slice(1), ctx);

    case "skill":
      return await cmdSkill(args.slice(1), ctx);

    case "version":
    case "--version":
    case "-v":
      return await cmdVersion();

    case "help":
    case "--help":
    case "-h":
    default:
      printHelp();
      return command === undefined || command === "help" || command === "--help" || command === "-h" ? 0 : 1;
  }
}

if (import.meta.main) {
  Deno.exit(await main());
}

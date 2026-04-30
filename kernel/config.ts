import { parse } from "@std/toml";
import { join, resolve } from "@std/path";
import { exists } from "@std/fs";
import type {
  KernelConfig,
  ModesConfig,
  OvermindConfig,
  SkillsConfig,
} from "./types.ts";
import { Mode } from "./types.ts";

const USER_CONFIG_PATH = resolve(
  Deno.env.get("HOME") ?? "~",
  ".config",
  "overmind",
  "overmind.toml",
);
const PROJECT_CONFIG_PATHS = [
  ".overmind/config.toml",
  ".overmind/overmind.toml",
];

/**
 * Recursively convert snake_case keys to camelCase. Only walks plain
 * objects — arrays, dates, primitives are returned as-is. Used at the
 * TOML→TS boundary because the TS config types are camelCase but TOML
 * idiomatically uses snake_case (`http_url`, `room_ttl_seconds`).
 *
 * Idempotent: keys already in camelCase pass through unchanged.
 */
function camelizeKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(camelizeKeys);
  // Skip Date and other non-plain objects. parse() from @std/toml only
  // returns plain objects, arrays, primitives, and Dates.
  if (Object.prototype.toString.call(value) !== "[object Object]") return value;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[snakeToCamel(key)] = camelizeKeys(val);
  }
  return out;
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
}

export class ConfigLoader {
  private loaded = false;
  private cfg: OvermindConfig | null = null;

  async load(): Promise<OvermindConfig> {
    if (this.loaded && this.cfg) return this.cfg;

    const userConfig = await this.tryLoad(USER_CONFIG_PATH);
    const projectConfig = await this.findProjectConfig();
    const merged = this.merge(userConfig, projectConfig);
    this.cfg = this.validate(merged);
    this.loaded = true;
    return this.cfg;
  }

  private async tryLoad(path: string): Promise<Partial<OvermindConfig> | null> {
    try {
      if (!await exists(path)) return null;
      const content = await Deno.readTextFile(path);
      const parsed = parse(content);
      // TOML idiomatically uses snake_case keys; the TS types declare
      // camelCase. Convert at the load boundary so the rest of the loader
      // (defaults, merge, validate) speaks one dialect. Without this the
      // user's `http_url` lands alongside the default's `httpUrl` rather
      // than overriding it, and `httpUrl` is then absent after a wholesale
      // section override — the adapter sees undefined and crashes.
      return camelizeKeys(parsed) as Partial<OvermindConfig>;
    } catch {
      return null;
    }
  }

  private async findProjectConfig(): Promise<Partial<OvermindConfig> | null> {
    const cwd = Deno.cwd();
    for (const relPath of PROJECT_CONFIG_PATHS) {
      const path = join(cwd, relPath);
      const result = await this.tryLoad(path);
      if (result) return result;
    }
    return null;
  }

  private merge(
    base: Partial<OvermindConfig> | null,
    override: Partial<OvermindConfig> | null,
  ): OvermindConfig {
    const defaults = {
      name: "overmind",
      version: "0.1.0",
      modes: {
        default: Mode.Scout,
        scout: { maxFixCycles: 0 },
        relay: { maxFixCycles: 3 },
        swarm: { maxFixCycles: 3 },
      },
      agents: {},
      brain: { enabled: true, brainName: "overmind", taskPrefix: "OVR" },
      neuralLink: {
        enabled: true,
        // Base URL only — the adapter appends `/health` and `/mcp` itself.
        // Existing configs that bake `/mcp` in still work via the
        // adapter's `normalizeNeuralLinkBase` defensive strip.
        httpUrl: "http://localhost:9961",
        roomTtlSeconds: 3600,
      },
      skills: { autoInject: true, projectOverrides: true },
      // Default to subprocess so any caller (CLI, CI, OpenCode) Just Works.
      // Setting to "client_side" requires the caller to drain dispatches
      // via overmind_pending_dispatches and spawn teammates itself; that's
      // safe for Claude Code with experimental teams enabled but silently
      // fails for headless callers, so it's never the default.
      dispatcher: { mode: "subprocess" },
    } as OvermindConfig;

    if (!base && !override) return defaults;
    if (!base) return { ...defaults, ...override } as OvermindConfig;
    if (!override) return { ...defaults, ...base } as OvermindConfig;
    return { ...defaults, ...base, ...override } as OvermindConfig;
  }

  private validate(cfg: Partial<OvermindConfig>): OvermindConfig {
    const required: Array<keyof OvermindConfig> = [
      "name",
      "version",
      "modes",
      "agents",
      "brain",
      "neuralLink",
      "skills",
      "dispatcher",
    ];
    for (const key of required) {
      if (!(key in cfg)) {
        throw new Error(`Missing required config key: ${key}`);
      }
    }
    return cfg as OvermindConfig;
  }

  toKernelConfig(overmindCfg: OvermindConfig): KernelConfig {
    return {
      mode: overmindCfg.modes.default,
      agents: overmindCfg.agents,
      brain: overmindCfg.brain,
      neuralLink: overmindCfg.neuralLink,
      skills: overmindCfg.skills,
      modes: overmindCfg.modes,
      dispatcher: overmindCfg.dispatcher,
    };
  }
}

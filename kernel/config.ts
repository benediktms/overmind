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
      return parse(content) as Partial<OvermindConfig>;
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
      neural_link: {
        enabled: true,
        // Base URL only — the adapter appends `/health` and `/mcp` itself.
        // Existing configs that bake `/mcp` in still work via the
        // adapter's `normalizeNeuralLinkBase` defensive strip.
        httpUrl: "http://localhost:9961",
        roomTtlSeconds: 3600,
      },
      skills: { autoInject: true, projectOverrides: true },
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
      "neural_link",
      "skills",
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
      neuralLink: overmindCfg.neural_link,
      skills: overmindCfg.skills,
      modes: overmindCfg.modes,
    };
  }
}

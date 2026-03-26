import { parse } from "@std/toml";
import { join } from "@std/path";
import { exists } from "@std/fs";

export interface SkillMetadata {
  name: string;
  description: string;
  triggers?: string[];
  source?: string;
}

export interface Skill {
  metadata: SkillMetadata;
  content: string;
}

export class SkillLoader {
  private skills: Map<string, Skill> = new Map();
  private skillsDir: string;

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
  }

  async loadAll(): Promise<void> {
    try {
      if (!await exists(this.skillsDir)) return;
      for await (const entry of Deno.readDir(this.skillsDir)) {
        if (entry.isFile && entry.name.endsWith(".md")) {
          await this.loadSkill(join(this.skillsDir, entry.name));
        }
      }
    } catch (err) {
      console.warn(`Failed to load skills from ${this.skillsDir}:`, err);
    }
  }

  private async loadSkill(path: string): Promise<void> {
    try {
      const content = await Deno.readTextFile(path);
      const frontmatterEnd = content.indexOf("---", 4);
      if (frontmatterEnd === -1) return;

      const frontmatterRaw = content.slice(0, frontmatterEnd).trim();
      const frontmatterLines = frontmatterRaw.split("\n");
      const metadata: Record<string, string> = {};

      for (const line of frontmatterLines) {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        metadata[key] = value;
      }

      const skill: Skill = {
        metadata: {
          name: metadata["name"] ?? "unnamed",
          description: metadata["description"] ?? "",
          triggers: metadata["triggers"]
            ? metadata["triggers"].split(",").map((t) => t.trim())
            : undefined,
          source: metadata["source"],
        },
        content: content.slice(frontmatterEnd + 3).trim(),
      };

      this.skills.set(skill.metadata.name, skill);
    } catch (err) {
      console.warn(`Failed to load skill ${path}:`, err);
    }
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  getAll(): Skill[] {
    return Array.from(this.skills.values());
  }

  match(context: string): Skill[] {
    const lower = context.toLowerCase();
    const matched: Skill[] = [];

    for (const skill of this.skills.values()) {
      if (skill.metadata.triggers) {
        for (const trigger of skill.metadata.triggers) {
          if (lower.includes(trigger.toLowerCase())) {
            matched.push(skill);
            break;
          }
        }
      }
    }

    return matched;
  }
}

export const BRAIN_MEMORY_SKILL: Skill = {
  metadata: {
    name: "brain-memory",
    description: "Guidelines for recording important context to brain memory",
    triggers: ["external_discovery", "decision_made", "important_context"],
  },
  content: `# Brain Memory Recording

Use \`memory_write_episode\` when you discover important information that should be preserved:

- **External discoveries**: Undocumented API behavior, external service quirks
- **Architecture decisions**: Why a particular approach was chosen
- **Business context**: Domain rules, constraints, or historical decisions

## When to Record

Record an episode when the user shares information not derivable from the codebase:
- External API behavior and quirks
- Architecture decisions and their rationale
- Business logic and domain rules
- Gotchas and workarounds discovered during investigation

## How to Record

\`\`\`
brain memory write-episode \\
  --goal "What was the goal" \\
  --actions "Key facts discovered" \\
  --outcome "How this should influence future work"
\`\`\`

## Auto-Recording

The kernel automatically records these event types:
- \`external_discovery\` → finding recorded to brain
- \`decision_made\` → decision recorded to brain
`,
};

export const BRAIN_TASK_SKILL: Skill = {
  metadata: {
    name: "brain-tasks",
    description: "Guidelines for task creation and updates via brain",
    triggers: ["task_created", "task_updated", "task_completed"],
  },
  content: `# Brain Task Management

Use \`tasks_create\`, \`tasks_apply_event\`, and \`tasks_close\` to manage tasks.

## Auto-Lifecycle

The kernel automatically handles task state transitions:
- \`objective_received\` → \`tasks_create\` (task created with objective title)
- \`agent_started_working\` → \`tasks_update\` (status → in_progress)
- \`agent_finished\` → \`tasks_close\` (status → done)
- \`agent_error\` → \`tasks_apply_event\` (status → blocked with error reason)

## When to Create Tasks

Create tasks for:
- Multi-step features that need tracking
- Bugs that cannot be fixed immediately
- Researchspikes that need follow-up
- Chores and cleanup work

## Task Naming

Use clear, actionable titles:
- ✅ "Add circuit breaker for payments API"
- ❌ "fix bug" or "work on payments"
`,
};

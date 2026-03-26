import { assertEquals } from "@std/assert";

import { parseSkillFrontmatter } from "./skill-injector.ts";

Deno.test("parseSkillFrontmatter parses YAML-list triggers", () => {
  const skill = parseSkillFrontmatter(`---
name: "YAML Skill"
triggers:
  - "alpha"
  - beta trigger
---
YAML body
`);

  assertEquals(skill?.name, "YAML Skill");
  assertEquals(skill?.triggers, ["alpha", "beta trigger"]);
});

Deno.test("parseSkillFrontmatter parses comma-separated triggers", () => {
  const skill = parseSkillFrontmatter(`---
name: Legacy Skill
triggers: alpha, beta trigger, gamma
---
Legacy body
`);

  assertEquals(skill?.name, "Legacy Skill");
  assertEquals(skill?.triggers, ["alpha", "beta trigger", "gamma"]);
});

Deno.test("parseSkillFrontmatter parses mixed quoted/unquoted comma values", () => {
  const skill = parseSkillFrontmatter(`---
name: Mixed Skill
triggers: "alpha", beta, 'gamma trigger'
---
Mixed body
`);

  assertEquals(skill?.triggers, ["alpha", "beta", "gamma trigger"]);
});

Deno.test("parseSkillFrontmatter returns empty triggers for empty triggers field", () => {
  const skill = parseSkillFrontmatter(`---
name: Empty Skill
triggers:
---
Empty body
`);

  assertEquals(skill?.triggers, []);
});

Deno.test("parseSkillFrontmatter returns empty triggers when missing triggers", () => {
  const skill = parseSkillFrontmatter(`---
name: Missing Trigger Skill
description: no triggers here
---
Body
`);

  assertEquals(skill?.triggers, []);
});

Deno.test("parseSkillFrontmatter returns null for malformed frontmatter", () => {
  const skill = parseSkillFrontmatter(`---
name: Broken Skill
triggers: alpha, beta
Body without closing fence
`);

  assertEquals(skill, null);
});

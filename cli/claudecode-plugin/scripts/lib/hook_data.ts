/**
 * Shared hook payload base type.
 *
 * Both PreToolUse and PostToolUse hook payloads share these fields. Each hook
 * defines a local interface that extends this base to add hook-specific fields.
 *
 * CC payload shapes use either snake_case (tool_name, tool_input) or camelCase
 * (toolName, toolInput) depending on the build; both variants are optional so
 * the consumer can fall back across them at runtime.
 */
export interface BaseHookData {
  tool_name?: string;
  toolName?: string;
  tool_input?: Record<string, unknown>;
  toolInput?: Record<string, unknown>;
  cwd?: string;
  directory?: string;
  session_id?: string;
  sessionId?: string;
}

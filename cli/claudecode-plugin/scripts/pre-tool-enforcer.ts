#!/usr/bin/env -S deno run -A --quiet
/**
 * Overmind Pre-Tool Enforcer Hook
 * Pre-tool checks and safety enforcement.
 *
 * When `OVERMIND_EDIT_HARNESS=1`, also enforces the read-hash contract:
 * any `Edit` / `Write` whose target's current sha256 does not match the
 * sha256 captured at last `Read` is rejected with a structured stop reason.
 */

import { readStdin } from "./lib/stdin.ts";
import {
  type CacheEntry,
  computeSha256,
  enforceMaxBytes,
  getCachePath,
  getEntry,
  isTransientPath,
  loadCache,
  pruneStale,
  resolvePathSafely,
} from "./lib/read_hash_cache.ts";
import { isHarnessEnabled } from "./lib/harness_config.ts";
import { tryAcquire, type TryAcquireResult } from "./lib/lock_client.ts";
import type { BaseHookData } from "./lib/hook_data.ts";

export { isHarnessEnabled };
export type { BaseHookData };

// PreToolUse-specific hook payload. Extends BaseHookData with the agent
// identity fields used for the cross-agent lock check (M4).
// CC's hook payload identity. `agentId` (subagents) and `agent_type`
// (some payload shapes) are equivalent — see `subagent-coordinator.ts`.
export interface HookData extends BaseHookData {
  agentId?: string;
  agent_type?: string;
}

const DEFAULT_KERNEL_URL = "http://localhost:8080";

export type Decision =
  | { kind: "allow"; message?: string }
  | { kind: "deny"; reason: string };

// CC's file-mutating tools as of 2026. `Update` was added after `Edit`/`Write`
// — verified against a live CC session diff (Update(path) → Added/removed
// lines). `MultiEdit` is the legacy batched-edit tool; harmless if absent.
// Adding a name here that doesn't exist is a no-op (gate just never fires).
export const FILE_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "Update",
  "MultiEdit",
]);

function outputAllow(additionalContext?: string): void {
  const result: Record<string, unknown> = { continue: true };
  if (additionalContext) {
    result.hookSpecificOutput = {
      hookEventName: "PreToolUse",
      additionalContext,
    };
  } else {
    result.suppressOutput = true;
  }
  console.log(JSON.stringify(result));
}

function outputDeny(reason: string): void {
  console.log(JSON.stringify({ continue: false, stopReason: reason }));
}

// Normalize a command string before danger-pattern matching (B1):
// 1. Remove backslash-newline continuations (\ at end of line).
// 2. Outside single-quoted regions, unescape \<char> → <char>
//    (catches "rm -rf \/").
// 3. Collapse runs of whitespace to a single space (catches "rm  -rf /").
// Single-quoted regions are passed through verbatim per POSIX quoting rules.
function normalizeDangerInput(s: string): string {
  // Step 1: strip backslash-newline continuations.
  let r = s.replace(/\\\n/g, " ");

  // Step 2: unescape backslash sequences outside single-quoted regions.
  let out = "";
  let inSingle = false;
  for (let i = 0; i < r.length; i++) {
    const ch = r[i];
    if (ch === "'" && !inSingle) {
      inSingle = true;
      out += ch;
      continue;
    }
    if (ch === "'" && inSingle) {
      inSingle = false;
      out += ch;
      continue;
    }
    if (!inSingle && ch === "\\" && i + 1 < r.length) {
      // Skip the backslash, keep the next character as-is.
      out += r[++i];
      continue;
    }
    out += ch;
  }
  r = out;

  // Step 3: collapse whitespace runs.
  return r.replace(/\s+/g, " ");
}

export function evaluateBash(command: string, _depth = 0): Decision {
  // Normalize before matching so whitespace mutations and escape tricks don't
  // evade the literal-substring scan (B1).
  const normalized = normalizeDangerInput(command);

  // Direct danger patterns run FIRST at every depth — the depth guard below
  // only gates the more-expensive recursive descent, not this check (N6).
  // Applied to the normalized command string so whitespace/escape mutations
  // are caught (B1, N6).
  if (
    normalized.includes("rm -rf /") ||
    normalized.includes("rm -f /") ||
    normalized.includes(":(){ :|:& };:") ||
    normalized.includes("> /dev/sda")
  ) {
    return {
      kind: "allow",
      message:
        "[OVERMIND SAFETY] Dangerous command detected. Verify this is intentional before executing.",
    };
  }

  // Guard against infinite recursion in adversarial inputs. Only the recursive
  // descent is gated — the literal scan above already ran (N6).
  if (_depth > 5) return { kind: "allow" };

  // Recursive check: detect `bash -c '...'`, `sh -c '...'`, `eval '...'`, and
  // backtick-wrapped commands. These wrappers allow an agent to embed a
  // dangerous inner command that the top-level scan would otherwise miss.
  // We extract the inner body and re-run evaluateBash on it.
  for (const segment of splitTopLevelSegments(normalized)) {
    const tokens = tokenizeQuoteAware(segment.trim());
    if (tokens.length === 0) continue;

    // bash -c <body> / sh -c <body>
    // Handles:
    //   bash -c 'cmd'           (position +1)
    //   bash -ic 'cmd'          (clustered flags — B2)
    //   bash --norc -c 'cmd'    (long flags before -c — B2)
    //   bash -c -- 'cmd'        (-- separator — B2)
    const shellIdx = tokens.findIndex(
      (t) =>
        t === "bash" || t === "sh" || t.endsWith("/bash") || t.endsWith("/sh"),
    );
    if (shellIdx > -1) {
      // Walk all tokens after the shell binary looking for -c anywhere in the
      // flag walk (not only position +1). Clustered flags like `-ic` also
      // count. Stop scanning once we hit a non-flag or `--`.
      let cIdx = -1;
      for (let i = shellIdx + 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === "--") {
          // `--` ends flag processing; body is the next token.
          cIdx = i; // treat `--` position so body = tokens[cIdx+1]
          break;
        }
        if (t.startsWith("-") && t.includes("c")) {
          cIdx = i;
          break;
        }
        if (!t.startsWith("-")) break; // non-flag positional ends the flag walk
      }
      if (cIdx > -1) {
        const bodyTok = tokens[cIdx + 1];
        if (bodyTok) {
          const inner = evaluateBash(stripQuotes(bodyTok), _depth + 1);
          if (inner.kind === "allow" && inner.message) return inner;
        }
      }
    }

    // eval <body> — accept `eval` anywhere in the token list, not only at
    // index 0. Also handles `command eval`, `\eval`, `builtin eval` (B2).
    const evalIdx = tokens.findIndex((t) => {
      // Strip a leading backslash (e.g. `\eval`) before comparing so `\eval`
      // also matches.
      const bare = t.replace(/^\\/, "").split("/").pop()!;
      return bare === "eval";
    });
    if (evalIdx > -1 && tokens.length > evalIdx + 1) {
      // De-quote each arg individually then join with a space so multi-arg
      // forms like `eval 'rm' '-rf' '/'` produce `rm -rf /` (B2).
      const body = tokens
        .slice(evalIdx + 1)
        .map(stripQuotes)
        .join(" ");
      const inner = evaluateBash(body, _depth + 1);
      if (inner.kind === "allow" && inner.message) return inner;
    }

    // Backtick command substitution: extract content between first pair of ``.
    const backtickMatch = segment.match(/`([^`]+)`/);
    if (backtickMatch) {
      const inner = evaluateBash(backtickMatch[1], _depth + 1);
      if (inner.kind === "allow" && inner.message) return inner;
    }
  }

  return { kind: "allow" };
}

// Quote-aware whitespace tokenizer. Single and double quotes balance and
// suppress whitespace splits inside them. Backslash-escaping is intentionally
// NOT handled — bash quoting is rich enough that a perfect parser would be
// its own module; we accept that exotic constructs may misparse and rely on
// the fail-open warn-not-block contract.
function tokenizeQuoteAware(s: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  for (const ch of s) {
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      buf += ch;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      buf += ch;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (buf) {
        tokens.push(buf);
        buf = "";
      }
      continue;
    }
    buf += ch;
  }
  if (buf) tokens.push(buf);
  return tokens;
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    return s.slice(1, -1);
  }
  return s;
}

// Split a command on top-level shell separators (|, ||, &, &&, ;) so that
// `sed -i ... file && other` doesn't pull tokens past the `&&`. Quote-aware
// and $() / backtick nesting-aware: separators inside command substitutions
// are never treated as top-level splits.
//
// N5: also tracks `[[ ... ]]` test-bracket context. Bare `(` inside a `[[`
// block (e.g. in a regex like `[[ x =~ (foo|bar) ]]`) must NOT increment
// subshellDepth — otherwise the `]]` that closes the test-bracket would leave
// a phantom open depth and subsequent `&&` would be swallowed.
function splitTopLevelSegments(command: string): string[] {
  const segments: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  // Tracks $( ... ) nesting depth. Every `$(` increments, every unquoted `)`
  // at depth > 0 decrements. Backtick substitutions use a separate flag
  // because they don't nest (a second backtick always closes the first).
  let subshellDepth = 0;
  let inBacktick = false;
  // Tracks whether we are inside a [[ ... ]] test-bracket context (N5).
  // Only the outermost `[[` opens the context; nested `[[` is unusual but
  // we track depth to handle it correctly.
  let testBracketDepth = 0;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (!inDouble && !inBacktick && ch === "'") {
      inSingle = !inSingle;
      buf += ch;
      continue;
    }
    if (!inSingle && !inBacktick && ch === '"') {
      inDouble = !inDouble;
      buf += ch;
      continue;
    }
    // Backtick command substitution: toggle outside of single-quotes.
    if (!inSingle && !inDouble && ch === "`") {
      inBacktick = !inBacktick;
      buf += ch;
      continue;
    }
    if (!inSingle && !inDouble && !inBacktick) {
      // Detect `[[` (opening test-bracket) and `]]` (closing test-bracket).
      if (ch === "[" && command[i + 1] === "[") {
        testBracketDepth++;
        buf += "[[";
        i++; // consume second `[`
        continue;
      }
      if (ch === "]" && command[i + 1] === "]") {
        if (testBracketDepth > 0) testBracketDepth--;
        buf += "]]";
        i++; // consume second `]`
        continue;
      }

      // $( opens a subshell — track depth so inner `&&`/`|`/`;` are not splits.
      if (ch === "$" && command[i + 1] === "(") {
        subshellDepth++;
        buf += ch;
        continue;
      }
      if (ch === "(") {
        // A bare `(` also opens a subshell context (subshell grouping), but
        // NOT when we are inside a [[ ... ]] test-bracket — there `(` is part
        // of a regex alternation pattern and must not affect split depth (N5).
        if (testBracketDepth === 0) subshellDepth++;
        buf += ch;
        continue;
      }
      if (ch === ")") {
        if (subshellDepth > 0 && testBracketDepth === 0) {
          subshellDepth--;
          buf += ch;
          continue;
        }
        // Unmatched `)` or `)` inside [[ ]] — pass through.
        buf += ch;
        continue;
      }
      // Only split on separators at depth 0 (not inside a $() or backtick).
      if (subshellDepth === 0 && testBracketDepth === 0) {
        // Noclobber `>|` is a single redirect operator, not a pipe. Detect
        // by looking at the most recent non-whitespace char; if it's `>`,
        // keep the `|` attached to the buffer.
        if (ch === "|") {
          const prevNonSpace = buf.replace(/\s+$/, "");
          if (prevNonSpace.endsWith(">")) {
            buf += ch;
            continue;
          }
        }
        if (ch === "|" || ch === "&" || ch === ";") {
          if (buf.trim()) segments.push(buf);
          buf = "";
          // Skip the second char of "||" or "&&".
          if (command[i + 1] === ch) i++;
          continue;
        }
      }
    }
    buf += ch;
  }
  if (buf.trim()) segments.push(buf);
  return segments;
}

// Redirect operator + path. Reused by parser to capture redirect targets and
// to strip redirects from segments before sed/awk file detection. The
// optional `\|` after `>{1,2}` matches the `>|` noclobber-override form.
// Also matches `>>|` (which is not valid bash) — harmless over-match per
// the fail-open warn-not-block contract.
const REDIRECT_RE =
  /(?:^|\s)(?:1|2|&)?>{1,2}\|?\s*("([^"]+)"|'([^']+)'|([^\s|;&<>()]+))/g;

// Input redirect: `< file` or `0< file`. Strip these so that `patch -p1
// src/main.ts < changes.patch` doesn't count `changes.patch` as a positional
// argument to patch. Capture group 1 holds the path (unused — we only strip).
//
// N4: the lookbehind `(?<!<)` prevents matching `<<` (heredoc) and `<<<`
// (here-string) forms, which should be left intact in the segment so that
// parsers downstream don't accidentally treat heredoc tag names as file paths.
const INPUT_REDIRECT_RE =
  /(?:^|\s)(?:0)?(?<!<)<(?!<)\s*("([^"]+)"|'([^']+)'|([^\s|;&<>()]+))/g;

function isSedExpressionLike(token: string): boolean {
  // Crude heuristic: sed substitution / transliteration / address forms.
  // Matches `s/x/y/`, `s|x|y|`, `y/abc/xyz/`, `1,$d`, `/regex/p`.
  if (/^[sy][/|]/.test(token)) return true;
  if (/^\d*[,;]/.test(token)) return true;
  if (token.startsWith("/") && token.endsWith("/p")) return true;
  return false;
}

function isDevNullLike(path: string): boolean {
  return path.startsWith("/dev/");
}

function tokenIsSedCommand(token: string): boolean {
  return token === "sed" || token.endsWith("/sed");
}

function tokenIsAwkCommand(token: string): boolean {
  return token === "awk" || token.endsWith("/awk");
}

function tokenIsCpCommand(token: string): boolean {
  return token === "cp" || token.endsWith("/cp");
}

function tokenIsMvCommand(token: string): boolean {
  return token === "mv" || token.endsWith("/mv");
}

function tokenIsDdCommand(token: string): boolean {
  return token === "dd" || token.endsWith("/dd");
}

function tokenIsPerlCommand(token: string): boolean {
  return token === "perl" || token.endsWith("/perl");
}

function tokenIsRubyCommand(token: string): boolean {
  return token === "ruby" || token.endsWith("/ruby");
}

function tokenIsPatchCommand(token: string): boolean {
  return token === "patch" || token.endsWith("/patch");
}

function tokenIsTruncateCommand(token: string): boolean {
  return token === "truncate" || token.endsWith("/truncate");
}

function tokenIsInstallCommand(token: string): boolean {
  return token === "install" || token.endsWith("/install");
}

// Parse a Bash command for tokens that look like file writes the harness
// won't see (sed -i, awk -i inplace, output redirection, tee, cp, mv, dd,
// perl -i, ruby -i, patch, truncate, install). Permissive on purpose: we
// surface a warning, never block, so over-matching is preferred to under-
// matching. False positives are noisy; false negatives let stale writes
// through silently.
export function parseBashWriteCandidates(command: string): string[] {
  const found = new Set<string>();
  const addCandidate = (raw: string) => {
    const path = stripQuotes(raw);
    if (!path) return;
    if (isDevNullLike(path)) return;
    if (isSedExpressionLike(path)) return;
    found.add(path);
  };

  for (const segment of splitTopLevelSegments(command)) {
    // Strip redirect sequences before file detection so that neither output
    // redirects (`> /dev/null`) nor input redirects (`< patch.diff`) are
    // mistaken for positional file arguments. Output redirects are still
    // captured separately below via matchAll(REDIRECT_RE).
    const segmentNoRedir = segment
      .replace(REDIRECT_RE, "")
      .replace(INPUT_REDIRECT_RE, "");
    const tokens = tokenizeQuoteAware(segmentNoRedir);

    // sed [-i|--in-place ...] <file>. Detection accepts `sed` or any
    // path ending in `/sed` (e.g., `/usr/bin/sed`).
    const sedIdx = tokens.findIndex(tokenIsSedCommand);
    if (sedIdx > -1) {
      const inPlaceIdx = tokens.findIndex((t, i) =>
        i > sedIdx && /^(?:-i\S*|--in-place\S*)$/.test(t)
      );
      if (inPlaceIdx > -1) {
        // Walk from the end; first token that is not a flag, not quoted,
        // and not sed-expression-like is the file.
        for (let i = tokens.length - 1; i > inPlaceIdx; i--) {
          const t = tokens[i];
          if (t.startsWith("-")) continue;
          if (t.startsWith("'") || t.startsWith('"')) continue;
          if (isSedExpressionLike(t)) continue;
          if (t) {
            addCandidate(t);
            break;
          }
        }
      }
    }

    // awk -i inplace 'PROGRAM' <file>
    const awkIdx = tokens.findIndex(tokenIsAwkCommand);
    if (
      awkIdx > -1 && tokens[awkIdx + 1] === "-i" &&
      tokens[awkIdx + 2] === "inplace"
    ) {
      for (let i = tokens.length - 1; i > awkIdx + 2; i--) {
        const t = tokens[i];
        if (t.startsWith("-")) continue;
        if (t.startsWith("'") || t.startsWith('"')) continue;
        if (t) {
          addCandidate(t);
          break;
        }
      }
    }

    // cp <src> <dest> — the destination (last non-flag token) is the write target.
    // cp -r src/ dest/ and cp -f src dest are both captured via the same rule.
    // cp -i (interactive) is the safe flag — we still capture the dest since the
    // file may be overwritten.
    const cpIdx = tokens.findIndex(tokenIsCpCommand);
    if (cpIdx > -1) {
      const args = tokens.slice(cpIdx + 1).filter((t) => !t.startsWith("-"));
      // cp requires at least two positional args: source(s) + destination.
      // The last positional arg is the destination.
      if (args.length >= 2) {
        addCandidate(args[args.length - 1]);
      }
    }

    // mv <src> <dest> — same shape as cp: last positional arg is the destination.
    const mvIdx = tokens.findIndex(tokenIsMvCommand);
    if (mvIdx > -1) {
      const args = tokens.slice(mvIdx + 1).filter((t) => !t.startsWith("-"));
      if (args.length >= 2) {
        addCandidate(args[args.length - 1]);
      }
    }

    // dd: look for of=<file> among tokens.
    const ddIdx = tokens.findIndex(tokenIsDdCommand);
    if (ddIdx > -1) {
      for (let i = ddIdx + 1; i < tokens.length; i++) {
        const t = stripQuotes(tokens[i]);
        if (t.startsWith("of=")) {
          addCandidate(t.slice(3));
        }
      }
    }

    // perl -i ... <file> / perl -i.bak ... <file>
    // The `-i` flag (with or without an extension suffix) marks in-place editing.
    // Also detects clustered forms like `-pi` (N1).
    // The file is the last non-flag, non-program token.
    const perlIdx = tokens.findIndex(tokenIsPerlCommand);
    if (perlIdx > -1) {
      const hasInPlace = tokens.some(
        (t, i) =>
          i > perlIdx &&
          // anchored: -i or -i.bak (extension suffix)
          (/^-i/.test(t) ||
            // clustered: -pi, -pie, etc. — contains `i` in the short flag cluster
            (t.startsWith("-") && !t.startsWith("--") && t.includes("i"))),
      );
      if (hasInPlace) {
        // Walk backward: skip flags and -e program strings; first plain token is the file.
        let skipNext = false;
        for (let i = tokens.length - 1; i > perlIdx; i--) {
          const t = tokens[i];
          if (skipNext) {
            skipNext = false;
            continue;
          }
          if (t === "-e" || t === "-E") {
            skipNext = true;
            continue;
          }
          if (t.startsWith("-")) continue;
          if (t.startsWith("'") || t.startsWith('"')) continue;
          addCandidate(t);
          break;
        }
      }
    }

    // ruby -i ... <file> — same shape as perl -i.
    // Also detects clustered forms like `-pi` (N1).
    const rubyIdx = tokens.findIndex(tokenIsRubyCommand);
    if (rubyIdx > -1) {
      const hasInPlace = tokens.some(
        (t, i) =>
          i > rubyIdx &&
          (/^-i/.test(t) ||
            (t.startsWith("-") && !t.startsWith("--") && t.includes("i"))),
      );
      if (hasInPlace) {
        let skipNext = false;
        for (let i = tokens.length - 1; i > rubyIdx; i--) {
          const t = tokens[i];
          if (skipNext) {
            skipNext = false;
            continue;
          }
          if (t === "-e" || t === "-E") {
            skipNext = true;
            continue;
          }
          if (t.startsWith("-")) continue;
          if (t.startsWith("'") || t.startsWith('"')) continue;
          addCandidate(t);
          break;
        }
      }
    }

    // patch [-p<n>] [-i <patchfile>] [<file>]
    // patch modifies files in place. The target file is the last non-flag arg,
    // or the file listed inside the patch (we can't know that statically, so we
    // capture the last positional token if present).
    const patchIdx = tokens.findIndex(tokenIsPatchCommand);
    if (patchIdx > -1) {
      // Collect positional args (non-flags, skipping the arg after -i/-F/-r/-o).
      const skipFlagArgs = new Set(["-i", "-F", "-r", "-o", "-b", "-z"]);
      const positionals: string[] = [];
      let skipNext = false;
      for (let i = patchIdx + 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (skipNext) {
          skipNext = false;
          continue;
        }
        if (skipFlagArgs.has(t)) {
          skipNext = true;
          continue;
        }
        if (t.startsWith("-")) continue;
        positionals.push(t);
      }
      if (positionals.length > 0) {
        addCandidate(positionals[positionals.length - 1]);
      }
    }

    // truncate -s <size> <file> — truncates (overwrites) a file to a given size.
    const truncIdx = tokens.findIndex(tokenIsTruncateCommand);
    if (truncIdx > -1) {
      const args = tokens.slice(truncIdx + 1);
      let skipNext = false;
      for (let i = 0; i < args.length; i++) {
        const t = args[i];
        if (skipNext) {
          skipNext = false;
          continue;
        }
        if (t === "-s" || t === "--size" || t === "-c" || t === "--no-create") {
          if (t === "-s" || t === "--size") skipNext = true;
          continue;
        }
        if (t.startsWith("-")) continue;
        addCandidate(t);
      }
    }

    // install <src> <dest> — copies src to dest, creating the destination.
    // The last positional arg is the destination (file or directory).
    const installIdx = tokens.findIndex(tokenIsInstallCommand);
    if (installIdx > -1) {
      // Flags that consume a following argument.
      const installFlagArgs = new Set([
        "-g",
        "--group",
        "-m",
        "--mode",
        "-o",
        "--owner",
        "-t",
        "--target-directory",
        "-S",
        "--suffix",
      ]);
      const positionals: string[] = [];
      let skipNext = false;
      for (let i = installIdx + 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (skipNext) {
          skipNext = false;
          continue;
        }
        if (installFlagArgs.has(t)) {
          skipNext = true;
          continue;
        }
        if (t.startsWith("-")) continue;
        positionals.push(t);
      }
      // Need at least src + dest.
      if (positionals.length >= 2) {
        addCandidate(positionals[positionals.length - 1]);
      }
    }

    // Output redirection. Match against the original segment (not stripped).
    for (const m of segment.matchAll(REDIRECT_RE)) {
      const candidate = m[2] ?? m[3] ?? m[4];
      if (candidate) addCandidate(candidate);
    }

    // tee [-a] <file> [<file> ...]
    const teeIdx = tokens.indexOf("tee");
    if (teeIdx > -1) {
      for (let i = teeIdx + 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.startsWith("-")) continue;
        if (t) addCandidate(t);
      }
    }
  }

  return Array.from(found);
}

export function evaluateEnvWrite(path: string): Decision {
  if (
    path.includes(".env") &&
    !path.includes(".env.example") &&
    !path.includes(".env.template")
  ) {
    return {
      kind: "allow",
      message:
        "[OVERMIND SAFETY] Writing to .env file. Ensure no secrets are exposed in the content.",
    };
  }
  return { kind: "allow" };
}

export interface StalenessInputs {
  toolName: string;
  filePath: string;
  currentSha: string | null;
  cachedEntry: CacheEntry | undefined;
  isTransient: boolean;
}

// Pure decision: given the tool name, current sha, and last-known cached
// sha, decide whether to allow the edit or deny with a stale-read reason.
//
// Fail-open by design. Every "I don't know enough" path returns `allow` —
// missing file, no cache entry yet, transient path, non-mutating tool. The
// harness is a defense-in-depth layer above CC's own read-before-edit
// enforcement; a corrupted/missing cache or unknown tool must NOT block
// edits, or it would be worse than no harness at all. Only an
// unambiguous mismatch between stored and current sha denies.
export function decideStaleness(input: StalenessInputs): Decision {
  if (!FILE_MUTATING_TOOLS.has(input.toolName)) {
    return { kind: "allow" };
  }
  if (!input.filePath) return { kind: "allow" };
  if (input.isTransient) return { kind: "allow" };
  if (input.currentSha === null) return { kind: "allow" }; // missing file — CC will surface
  if (!input.cachedEntry) return { kind: "allow" }; // never read this session
  if (input.cachedEntry.sha256 === input.currentSha) return { kind: "allow" };
  return {
    kind: "deny",
    reason:
      `Stale read detected. ${input.filePath} changed since you last read it. Re-read the file before editing.`,
  };
}

function extractFilePath(toolInput: Record<string, unknown> | string): string {
  if (typeof toolInput === "string") return toolInput;
  return (toolInput.file_path as string) ?? (toolInput.filePath as string) ??
    "";
}

export interface EvaluateOptions {
  home?: string;
  harnessOn?: boolean;
}

export async function evaluateHarness(
  data: HookData,
  opts: EvaluateOptions = {},
): Promise<Decision> {
  const harnessOn = opts.harnessOn ?? isHarnessEnabled();
  if (!harnessOn) return { kind: "allow" };

  const toolName = data.tool_name ?? data.toolName ?? "";
  if (!FILE_MUTATING_TOOLS.has(toolName)) return { kind: "allow" };

  const toolInput = data.tool_input ?? data.toolInput ?? {};
  const rawPath = extractFilePath(toolInput);
  if (!rawPath) return { kind: "allow" };

  const cwd = data.cwd ?? data.directory ?? Deno.cwd();
  const home = opts.home ?? Deno.env.get("HOME") ?? "/";
  const cachePath = getCachePath(cwd, home);
  const cacheDir = cachePath.substring(0, cachePath.lastIndexOf("/"));
  // Resolve cwd first so the containment check inside resolvePathSafely uses
  // the real path (e.g. /private/var/... on macOS) rather than the symlink
  // form (/var/...). Without this, temp-dir paths used in tests would fail the
  // containment check and return the unresolved key, missing the cache entry.
  const cwdReal = await resolvePathSafely(cwd);
  const filePath = await resolvePathSafely(rawPath, cwdReal);

  if (isTransientPath(filePath, cacheDir, cwdReal)) return { kind: "allow" };

  // TOCTOU note: there is a small window between this sha256 read and CC's
  // actual Edit/Write apply. A concurrent writer could mutate the file in
  // that window. This is an inherent limitation of the hook approach
  // (Option B in edit-harness-spike.md); Option A (kernel-mediated tool)
  // would close it. Acceptable for M1.
  const cache = enforceMaxBytes(pruneStale(await loadCache(cachePath)));
  const cachedEntry = getEntry(cache, filePath);
  const currentSha = await computeSha256(filePath);

  return decideStaleness({
    toolName,
    filePath,
    currentSha,
    cachedEntry,
    isTransient: false,
  });
}

export interface LockClaimResult {
  readonly decision: Decision;
  // Surfaced when the kernel was unreachable / errored — main() prints it as
  // an `additionalContext` warning alongside any other message. Distinct from
  // `Decision.allow.message` so a deny path can still emit a nudge if needed.
  readonly warn?: string;
}

// Cross-agent lock check. Runs after the harness hash check passes for an
// Edit/Write/Update/MultiEdit. Posts to the kernel's /lock endpoint via the
// shared client; conflicts deny, errors fail open with a one-line warn.
// `OVERMIND_KERNEL_HTTP_URL` overrides the default; `OVERMIND_MODE` short-
// circuits the network call for scout/relay (single-writer).
export async function evaluateLockClaim(
  data: HookData,
  opts: EvaluateOptions & {
    env?: { get(key: string): string | undefined };
    fetcher?: typeof tryAcquire;
    // Injection seam for the identity-fallback log so tests can capture the
    // warn without spamming stderr. Defaults to `console.error` — stdout is
    // reserved for the JSON hook response.
    logger?: (message: string) => void;
  } = {},
): Promise<LockClaimResult> {
  const harnessOn = opts.harnessOn ?? isHarnessEnabled();
  if (!harnessOn) return { decision: { kind: "allow" } };

  const toolName = data.tool_name ?? data.toolName ?? "";
  if (!FILE_MUTATING_TOOLS.has(toolName)) {
    return { decision: { kind: "allow" } };
  }

  const toolInput = data.tool_input ?? data.toolInput ?? {};
  const rawPath = extractFilePath(toolInput);
  if (!rawPath) return { decision: { kind: "allow" } };

  const env = opts.env ?? Deno.env;
  const cwd = data.cwd ?? data.directory ?? Deno.cwd();
  const home = opts.home ?? env.get("HOME") ?? "/";
  const cachePath = getCachePath(cwd, home);
  const cacheDir = cachePath.substring(0, cachePath.lastIndexOf("/"));
  const cwdReal = await resolvePathSafely(cwd);
  const filePath = await resolvePathSafely(rawPath, cwdReal);

  // Mirror `evaluateHarness`: transient files (`/tmp`, `/var/folders/`, the
  // hash cache itself) are out of scope for the harness. Skipping them here
  // avoids a wasted localhost RTT and prevents two agents touching the same
  // /tmp scratch file from registering a spurious cross-agent conflict.
  if (isTransientPath(filePath, cacheDir, cwdReal)) {
    return { decision: { kind: "allow" } };
  }

  // Identity tuple: same fallbacks as the M1 hash cache so both layers fail
  // in the same direction. The redesign plan flags the fallback path as a
  // soft regression to "M1 only" — surface it on stderr so an operator can
  // see when the cross-agent guarantee silently degrades.
  const sessionIdRaw = data.session_id ?? data.sessionId;
  const agentIdRaw = data.agentId ?? data.agent_type;
  const sessionId = sessionIdRaw ?? "default";
  const agentId = agentIdRaw ?? "unknown";
  if (!sessionIdRaw || !agentIdRaw) {
    const log = opts.logger ?? ((m) => console.error(m));
    log(
      `[OVERMIND] Hook identity fallback: sessionId=${sessionId}, agentId=${agentId}. Cross-agent lock protection degraded.`,
    );
  }
  const url = env.get("OVERMIND_KERNEL_HTTP_URL") ?? DEFAULT_KERNEL_URL;
  const mode = env.get("OVERMIND_MODE");

  const acquire = opts.fetcher ?? tryAcquire;
  const result: TryAcquireResult = await acquire({
    url,
    path: filePath,
    sessionId,
    agentId,
    mode,
  });

  switch (result.status) {
    case "ok":
    case "skipped":
      return { decision: { kind: "allow" } };
    case "conflict":
      return {
        decision: {
          kind: "deny",
          reason:
            `File locked by agent ${result.holder.agentId} in session ${result.holder.sessionId}. Pick another file or wait.`,
        },
      };
    case "kernel_unavailable":
      return {
        decision: { kind: "allow" },
        warn:
          "[OVERMIND SAFETY] Lock check skipped: kernel unreachable. Cross-agent race protection is offline; the hash check still applies.",
      };
  }
}

// Warn (not block) when a Bash command appears to write to a path that's
// in the read-hash cache. The harness's PreToolUse hash check only sees
// Edit / Write; a `sed -i` or `>` redirect would silently bypass it. We
// surface a nudge so the agent knows to re-Read after.
export async function evaluateBashCacheBypass(
  command: string,
  data: HookData,
  opts: EvaluateOptions = {},
): Promise<Decision> {
  const harnessOn = opts.harnessOn ?? isHarnessEnabled();
  if (!harnessOn) return { kind: "allow" };
  if (!command) return { kind: "allow" };

  const candidates = parseBashWriteCandidates(command);
  if (candidates.length === 0) return { kind: "allow" };

  const cwd = data.cwd ?? data.directory ?? Deno.cwd();
  const home = opts.home ?? Deno.env.get("HOME") ?? "/";
  const cachePath = getCachePath(cwd, home);
  // Match evaluateHarness's pipeline (prune + cap) so a bloated cache file
  // doesn't blow up memory on the Bash check path.
  const cache = enforceMaxBytes(pruneStale(await loadCache(cachePath)));
  const cwdReal = await resolvePathSafely(cwd);

  const hits: string[] = [];
  for (const raw of candidates) {
    const resolved = await resolvePathSafely(raw, cwdReal);
    if (getEntry(cache, resolved)) hits.push(raw);
  }
  if (hits.length === 0) return { kind: "allow" };

  const list = hits.map((p) => `\`${p}\``).join(", ");
  return {
    kind: "allow",
    message:
      `[OVERMIND SAFETY] Bash write detected on hash-cached path(s): ${list}. The edit harness won't see this; prefer Edit/Write, or Read the file again afterwards to refresh the cache.`,
  };
}

// Bash tool branch logic, extracted for testability. Precedence is fixed:
// dangerous-pattern message wins; cache-bypass nudge only fires when no
// danger note was emitted. Returns the message (or undefined for the silent
// allow path). The orchestrator never denies a Bash command — both checks
// are warn-only.
export async function handleBashTool(
  command: string,
  data: HookData,
  opts: EvaluateOptions = {},
): Promise<string | undefined> {
  const danger = evaluateBash(command);
  if (danger.kind === "allow" && danger.message) return danger.message;
  const bypass = await evaluateBashCacheBypass(command, data, opts);
  return bypass.kind === "allow" ? bypass.message : undefined;
}

async function main(): Promise<void> {
  const input = await readStdin();
  if (!input.trim()) {
    outputAllow();
    return;
  }

  let data: HookData = {};
  try {
    data = JSON.parse(input);
  } catch {
    outputAllow();
    return;
  }

  const harnessDecision = await evaluateHarness(data);
  if (harnessDecision.kind === "deny") {
    outputDeny(harnessDecision.reason);
    return;
  }

  // Cross-agent lock check (M4). Only fires for file-mutating tools and only
  // when the harness is on. Conflict denies; kernel-unavailable warns.
  const lockResult = await evaluateLockClaim(data);
  if (lockResult.decision.kind === "deny") {
    outputDeny(lockResult.decision.reason);
    return;
  }

  const toolName = data.tool_name ?? data.toolName ?? "";
  const toolInput = data.tool_input ?? data.toolInput ?? {};

  let message: string | undefined = lockResult.warn;

  switch (toolName) {
    case "Bash": {
      const command = typeof toolInput === "string"
        ? toolInput
        : (toolInput.command as string) ?? "";
      // Safe to overwrite: `evaluateLockClaim` only emits a warn for tools
      // in `FILE_MUTATING_TOOLS`, which excludes Bash. So `message` is
      // always undefined on entry to this branch. If Bash ever joins the
      // mutating set, switch to the newline-join pattern used by the
      // Edit/Write/Update/MultiEdit branch below.
      message = await handleBashTool(command, data);
      break;
    }

    case "Write":
    case "Edit":
    case "Update":
    case "MultiEdit": {
      const path = extractFilePath(toolInput);
      const envDecision = evaluateEnvWrite(path);
      if (envDecision.kind === "allow" && envDecision.message) {
        // Compose with any lock-check warn already in `message` so a
        // kernel-unreachable + .env-write combo surfaces both nudges.
        message = message
          ? `${message}\n${envDecision.message}`
          : envDecision.message;
      }
      break;
    }
  }

  outputAllow(message);
}

if (import.meta.main) main();

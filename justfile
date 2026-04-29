set dotenv-load := true

OVERMIND_DIR := env("HOME") / ".config" / "overmind"
CLAUDE_CONFIG_DIR := env("HOME") / ".claude"
SETTINGS_FILE := CLAUDE_CONFIG_DIR / "settings.json"
OPENCODE_CONFIG_DIR := env("HOME") / ".config" / "opencode"
OPENCODE_PLUGIN_DIR := OPENCODE_CONFIG_DIR / "plugins" / "overmind"

# Compiled binary layout — kept in sync with installer.ts constants.
BIN_DIR := env("HOME") / ".local" / "bin"
OVERMIND_BIN := BIN_DIR / "overmind"
DIST_BIN := justfile_directory() / "dist" / "overmind"

repo_url := "https://github.com/fresha/overmind"

default:
    @just --list

# ── Install ──────────────────────────────────────────────────────────────────

install: install-claudecode install-opencode
    @echo "Overmind installed!"
    @echo "  Binary:    {{OVERMIND_BIN}}  →  {{DIST_BIN}}"
    @echo "  Daemon:    started (PID file at ~/.overmind/daemon.pid)"
    @echo "  MCP entry: registered in ~/.claude.json (restart Claude Code to pick up)"
    @echo ""
    @echo "For OpenCode:"
    @echo "  - Plugin symlinked to {{OPENCODE_PLUGIN_DIR}}"
    @echo "  - Restart OpenCode to load"

# Install Claude Code plugin: compile binary, symlink to PATH, register MCP,
# auto-start daemon. The installer is idempotent — safe to re-run.
install-claudecode:
    deno task install-plugin

# Compile + register + start (alias of install-claudecode for clarity)
install-claudecode-setup: install-claudecode

# Install via Claude Code marketplace (registers source + enables plugin)
install-marketplace:
    deno task install-plugin --mode marketplace

# Clone or update the Overmind repo
install-overmind-repo:
    @if [ ! -d "{{OVERMIND_DIR}}" ]; then \
        echo 'Cloning Overmind to {{OVERMIND_DIR}}...'; \
        git clone "{{repo_url}}" "{{OVERMIND_DIR}}"; \
    else \
        echo 'Updating Overmind...'; \
        git -C "{{OVERMIND_DIR}}" pull; \
    fi

# Install OpenCode plugin (simple symlink approach)
install-opencode:
    mkdir -p "{{OPENCODE_PLUGIN_DIR}}"
    ln -sf "{{OVERMIND_DIR}}/cli/opencode-plugin/index.ts" "{{OPENCODE_PLUGIN_DIR}}/main.ts"
    ln -sf "{{OVERMIND_DIR}}/config/overmind.toml" "{{OPENCODE_PLUGIN_DIR}}/config.toml"

# ── Uninstall ────────────────────────────────────────────────────────────────

uninstall:
    rm -rf "{{OPENCODE_PLUGIN_DIR}}"
    deno task uninstall-plugin

# ── Development ──────────────────────────────────────────────────────────────

# Boot the entire framework. With no arg: runs the kernel daemon (HTTP listener on :8080) —
# this is all you need after `just install` for the plugin's MCP to work end-to-end.
# With an arg: passes through to the CLI. Examples:
#   just dev            → start daemon (foreground, Ctrl+C to stop)
#   just dev status     → run `overmind status`
#   just dev doctor     → diagnose installation
#
# Uses the compiled binary when present; otherwise falls back to `deno run`
# so a fresh checkout still works without `just install` first.
dev arg="":
    #!/usr/bin/env bash
    if [ -x "{{DIST_BIN}}" ]; then
        if [ -z "{{arg}}" ]; then exec "{{DIST_BIN}}" daemon start
        else exec "{{DIST_BIN}}" {{arg}}
        fi
    else
        if [ -z "{{arg}}" ]; then exec deno run --allow-all cli/overmind.ts daemon start
        else exec deno run --allow-all cli/overmind.ts {{arg}}
        fi
    fi

# Run the kernel daemon in the foreground (Unix socket + HTTP listener on :8080).
# The MCP server (`overmind mcp`) talks to this on localhost. Ctrl+C to stop.
daemon:
    #!/usr/bin/env bash
    if [ -x "{{DIST_BIN}}" ]; then exec "{{DIST_BIN}}" daemon start
    else exec deno run --allow-all cli/overmind.ts daemon start
    fi

# Stop a running daemon by PID file.
daemon-stop:
    #!/usr/bin/env bash
    if [ -f ~/.overmind/daemon.pid ]; then
        pid=$(cat ~/.overmind/daemon.pid)
        if kill "$pid" 2>/dev/null; then
            echo "Stopped daemon (PID $pid)"
        else
            echo "PID $pid not running; removing stale daemon.pid"
            rm -f ~/.overmind/daemon.pid
        fi
    else
        echo "No daemon.pid found"
    fi

# Stop and restart the daemon (foreground).
daemon-restart:
    #!/usr/bin/env bash
    just daemon-stop
    sleep 0.3
    if [ -x "{{DIST_BIN}}" ]; then exec "{{DIST_BIN}}" daemon start
    else exec deno run --allow-all cli/overmind.ts daemon start
    fi

# Compile the unified binary without running the rest of the install. Useful
# during dev when you want a fresh artifact without touching ~/.claude.json.
compile:
    deno compile --allow-all --output {{DIST_BIN}} cli/overmind.ts
    @echo "Compiled to {{DIST_BIN}}"

dev-opencode:
    opencode --plugin "{{OVERMIND_DIR}}/cli/opencode-plugin/index.ts"

# ── Testing ───────────────────────────────────────────────────────────────────

test:
    deno test --allow-all

lint:
    deno lint

typecheck:
    deno check **/*.ts

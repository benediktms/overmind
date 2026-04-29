set dotenv-load := true

OVERMIND_DIR := env("HOME") / ".config" / "overmind"
CLAUDE_CONFIG_DIR := env("HOME") / ".claude"
SETTINGS_FILE := CLAUDE_CONFIG_DIR / "settings.json"
OPENCODE_CONFIG_DIR := env("HOME") / ".config" / "opencode"
OPENCODE_PLUGIN_DIR := OPENCODE_CONFIG_DIR / "plugins" / "overmind"

repo_url := "https://github.com/fresha/overmind"

default:
    @just --list

# ── Install ──────────────────────────────────────────────────────────────────

install: install-claudecode install-opencode
    @echo "Overmind installed!"
    @echo ""
    @echo "For Claude Code:"
    @echo "  1. Restart Claude Code"
    @echo "  2. Add to settings.json (or run 'just install-claudecode-setup'):"
    @echo ""
    @echo "  {"
    @echo '    \"extraKnownMarketplaces\": { \"overmind\": { \"source\": { \"source\": \"git\", \"url\": \"{{repo_url}}\" } } },'
    @echo '    \"enabledPlugins\": { \"overmind@local\": true }'
    @echo "  }"
    @echo ""
    @echo "For OpenCode:"
    @echo "  - Plugin symlinked to {{OPENCODE_PLUGIN_DIR}}"
    @echo "  - Restart OpenCode to load"

# Install Claude Code plugin via installer script
install-claudecode:
    deno task install-plugin

# Configure Claude Code settings.json with Overmind plugin (delegates to installer)
install-claudecode-setup:
    deno task install-plugin

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

dev:
    deno run --allow-all cli/main.ts

dev-opencode:
    opencode --plugin "{{OVERMIND_DIR}}/cli/opencode-plugin/index.ts"

# ── Testing ───────────────────────────────────────────────────────────────────

test:
    deno test --allow-all

lint:
    deno lint

typecheck:
    deno check **/*.ts

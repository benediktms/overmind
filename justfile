set dotenv-load = true

OVERMIND_DIR := env("HOME") / ".config" / "overmind"
CLAUDE_CONFIG_DIR := env("HOME") / ".claude"
SETTINGS_FILE := CLAUDE_CONFIG_DIR / "settings.json"
OPENCODE_CONFIG_DIR := env("HOME") / ".config" / "opencode"
OPENCODE_PLUGIN_DIR := OPENCODE_CONFIG_DIR / "plugins" / "overmind"

repo_url := "https://github.com/fresha/overmind"

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

# Set up Claude Code plugin via marketplace (OMC approach)
install-claudecode: install-overmind-repo
    @# Claude Code auto-installs plugins from marketplace on restart
    @# Just ensure the repo is cloned and permissions are noted
    @echo "Overmind repo: {{OVERMIND_DIR}}"

# Configure Claude Code settings.json with Overmind marketplace
install-claudecode-setup:
    @node -e "\
const fs = require('fs');\
const path = process.env.HOME + '/.claude/settings.json';\
const settings = JSON.parse(fs.readFileSync(path, 'utf8'));\
settings.extraKnownMarketplaces = settings.extraKnownMarketplaces || {};\
settings.extraKnownMarketplaces['overmind'] = { source: { source: 'git', url: '{{repo_url}}' } };\
settings.enabledPlugins = settings.enabledPlugins || {};\
settings.enabledPlugins['overmind@local'] = true;\
fs.writeFileSync(path, JSON.stringify(settings, null, 2));\
console.log('settings.json updated with overmind marketplace');\
"

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
    @node -e "\
const fs = require('fs');\
const path = process.env.HOME + '/.claude/settings.json';\
try {\
  const settings = JSON.parse(fs.readFileSync(path, 'utf8'));\
  delete settings.extraKnownMarketplaces?.['overmind'];\
  delete settings.enabledPlugins?.['overmind@local'];\
  fs.writeFileSync(path, JSON.stringify(settings, null, 2));\
  console.log('settings.json cleaned');\
} catch(e) { console.log('settings.json not modified'); }\
"

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

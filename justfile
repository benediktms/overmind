set dotenv-load = true

DEFAULT_AGENT_INSTALL_DIR := env("HOME") / ".config" / "overmind"
OPENCODE_PLUGIN_DIR := env("HOME") / ".config" / "opencode" / "plugins" / "overmind"
CLAUDECODE_PLUGIN_DIR := env("HOME") / ".claude" / "plugins" / "overmind"

repo_url := "https://github.com/fresha/overmind"

install:
    # Clone or update the repo
    if [ ! -d "{{DEFAULT_AGENT_INSTALL_DIR}}" ]; then
        git clone "{{repo_url}}" "{{DEFAULT_AGENT_INSTALL_DIR}}"
    else
        git -C "{{DEFAULT_AGENT_INSTALL_DIR}}" pull
    fi

    # Create plugin symlinks for OpenCode
    mkdir -p "{{OPENCODE_PLUGIN_DIR}}"
    ln -sf "{{DEFAULT_AGENT_INSTALL_DIR}}"/cli/opencode-plugin.ts "{{OPENCODE_PLUGIN_DIR}}/main.ts"
    ln -sf "{{DEFAULT_AGENT_INSTALL_DIR}}"/config/overmind.toml "{{OPENCODE_PLUGIN_DIR}}/config.toml"

    # Create plugin symlinks for Claude Code
    mkdir -p "{{CLAUDECODE_PLUGIN_DIR}}"
    ln -sf "{{DEFAULT_AGENT_INSTALL_DIR}}"/cli/claudecode-plugin.ts "{{CLAUDECODE_PLUGIN_DIR}}/main.ts"
    ln -sf "{{DEFAULT_AGENT_INSTALL_DIR}}"/config/overmind.toml "{{CLAUDECODE_PLUGIN_DIR}}/config.toml"

uninstall:
    rm -rf "{{OPENCODE_PLUGIN_DIR}}"
    rm -rf "{{CLAUDECODE_PLUGIN_DIR}}"

dev:
    deno run --allow-all cli/main.ts

test:
    deno test --allow-all

lint:
    deno lint

typecheck:
    deno check **/*.ts

# OpenCode Multiplexer Integration

Terminal multiplexer (tmux/zellij) integration for OpenCode — spawn subagent sessions as live panes.

## Features

- **Real-time visibility** into agent activity via tmux/zellij panes
- **Automatic pane management** — panes open/close as sessions start/end
- **Multi-terminal support** — tmux and zellij
- **Auto-detect** — automatically detects which multiplexer you're running

## Installation

### 1. Install the plugin

```bash
# From npm
npm install opencode-multiplexer-integration
# Or with bun
bun add opencode-multiplexer-integration
```

### 2. Configure in opencode.json

```jsonc
{
  "plugin": [["opencode-multiplexer-integration", {
    "multiplexer": {
      "type": "auto",
      "layout": "main-vertical",
      "main_pane_size": 60
    }
  }]]
}
```

### 3. Start OpenCode inside tmux or zellij

```bash
tmux
opencode
```

## Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `type` | string | `"none"` | `"auto"`, `"tmux"`, `"zellij"`, or `"none"` |
| `layout` | string | `"main-vertical"` | Layout preset (tmux only) |
| `main_pane_size` | number | `60` | Main pane size percentage (tmux only) |

### type

- `"auto"` — Auto-detect based on `$TMUX` / `$ZELLIJ` env vars
- `"tmux"` — Force tmux mode
- `"zellij"` — Force zellij mode
- `"none"` — Disabled

### layout (tmux only)

| Layout | Description |
|--------|-------------|
| `main-vertical` | Main pane on left, agents stacked on right |
| `main-horizontal` | Main pane on top, agents stacked below |
| `tiled` | All panes equal-sized grid |
| `even-horizontal` | All panes side by side |
| `even-vertical` | All panes stacked vertically |

## How It Works

When OpenCode creates child sessions (via `@agent` delegation), this plugin:

1. Detects the `session.created` event
2. Spawns a new tmux pane (or zellij tab) running `opencode attach --session <id>`
3. When the session completes or becomes idle, closes the pane
4. If a session resumes (busy after idle), respawns the pane

## Development

```bash
bun install
bun run build
bun test
```

## License

MIT

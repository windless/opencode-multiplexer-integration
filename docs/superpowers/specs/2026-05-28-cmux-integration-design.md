# cmux Terminal Multiplexer Integration Design

**Date:** 2026-05-28  
**Status:** Approved

## Overview

Add support for [cmux](https://github.com/manaflow-ai/cmux) — the macOS-native terminal multiplexer based on Ghostty — to the `multiplexer-integration` OpenCode plugin. This enables automatic pane creation for subagent sessions when OpenCode runs inside cmux.

## Decision Summary

| Choice | Rationale |
|--------|-----------|
| Pure CLI integration | Consistent with existing tmux/zellij implementations; no socket management overhead |
| One-shot pane creation | `cmux new-pane --direction right -- <command>` creates pane + terminal surface in one call |
| Full layout support | cmux has `new-split` primitives that can simulate layout patterns |
| Graceful shutdown (Ctrl+C + close) | Send Ctrl+C via `printf '\x03'`, wait 250ms, then `close-surface` |

## Architecture

### File Changes

| File | Change |
|------|--------|
| `src/multiplexer/cmux/index.ts` | **New** — `CmuxMultiplexer` class implementing `Multiplexer` |
| `src/multiplexer/types.ts` | Extend `Multiplexer['type']` to include `'cmux'` |
| `src/config/schema.ts` | Add `'cmux'` to `MultiplexerType` union |
| `src/multiplexer/factory.ts` | Add `cmux` case + auto detection via `CMUX_WORKSPACE_ID` |
| `src/multiplexer/index.ts` | Export `CmuxMultiplexer` |
| `tests/cmux.test.ts` | **New** — implementation tests |
| `tests/factory.test.ts` | Add cmux factory + auto detection tests |

### No Changes Needed

- `src/multiplexer/session-manager.ts` — depends only on `Multiplexer` interface
- `src/index.ts` — config parsing already delegates to factory
- `src/utils/compat.ts` and `src/utils/logger.ts` — no changes

## Component Design

### 1. CmuxMultiplexer (`src/multiplexer/cmux/index.ts`)

Implements the `Multiplexer` interface using cmux CLI commands via `crossSpawn`.

```
class CmuxMultiplexer implements Multiplexer {
  readonly type = 'cmux'

  isInsideSession(): boolean
  isAvailable(): Promise<boolean>
  spawnPane(sessionId, description, serverUrl, directory): Promise<PaneResult>
  closePane(paneId: string): Promise<boolean>
  applyLayout(layout, mainPaneSize): Promise<void>
}
```

### 2. Detection

**`isInsideSession()`**: Synchronous, zero I/O.
- Check `process.env.CMUX_WORKSPACE_ID` is defined and non-empty.
- cmux automatically sets `CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID`, `CMUX_TAB_ID` in managed terminals.

**`isAvailable()`**: Async, checks CLI availability.
- `command -v cmux` — verify CLI is installed.
- Optionally `cmux ping` to verify the cmux app is running (returns non-zero if not).

**Auto detection** (in `factory.ts` `auto` mode):
```
if (CMUX_WORKSPACE_ID) → cmux
else if (TMUX) → tmux
else if (ZELLIJ) → zellij
```

cmux is checked first because it may also set `TERM_PROGRAM=ghostty` (from Ghostty base). The `CMUX_WORKSPACE_ID` check is unambiguous.

### 3. spawnPane

Creates a new pane in the current workspace running the opencode attach command.

**Implementation:**
```typescript
const workspaceId = process.env.CMUX_WORKSPACE_ID
const cmd = `opencode attach "${sessionId}" --server-url "${serverUrl}"`
const result = await crossSpawn('cmux', [
  'new-pane',
  '--direction', 'right',
  '--json',
  '--',
  cmd
], { cwd: directory })

// Parse JSON from stdout to get surface_ref (e.g., "surface:5")
const output = JSON.parse(result.stdout)
const surfaceRef = output.surface_ref
```

**Returns:** `{ success: true, paneId: surfaceRef }` (we use surface ID as the pane identifier for close/send operations).

### 4. closePane

Graceful shutdown: send Ctrl+C first, then close the surface.

```typescript
// Step 1: Send Ctrl+C to surface (graceful termination)
await crossSpawn('cmux', ['send', '--surface', paneId, "$(printf '\\x03')"])

// Step 2: Wait 250ms for process to exit
await new Promise(resolve => setTimeout(resolve, 250))

// Step 3: Close the surface
await crossSpawn('cmux', ['close-surface', '--surface', paneId])
```

**Note:** cmux prevents closing the last surface in a workspace, but this won't affect us because we only close surfaces we created.

**Returns:** `true` on success, `false` on failure.

### 5. applyLayout

cmux has no single `select-layout` command. We simulate layouts using `new-split` primitives with debouncing (same pattern as TmuxMultiplexer, 150ms debounce).

**Layout mapping:**

| Layout | Commands to execute |
|--------|-------------------|
| `main-vertical` | `cmux new-split right` (main pane left, aux panes stack right) |
| `main-horizontal` | `cmux new-split down` (main pane top, aux panes stack bottom) |
| `tiled` | `cmux new-split right` then `cmux new-split down` (alternating pattern) |
| `even-horizontal` | `cmux new-split down` (sequential downward splits) |
| `even-vertical` | `cmux new-split right` (sequential rightward splits) |

**Debounce pattern** (same as tmux): Accumulate pane creations within 150ms window, then apply layout commands once to avoid redundant layout operations.

### 6. Layout Debounce Logic

```
┌─────────────────────────────────────────────────┐
│  spawnPane("agent-1")  ──┐                       │
│  spawnPane("agent-2")  ──┤ (within 150ms)       │
│  spawnPane("agent-3")  ──┘                       │
│                           │                       │
│                    ┌──────▼──────────┐            │
│                    │ 150ms debounce  │            │
│                    │ timer fires     │            │
│                    └──────┬──────────┘            │
│                           │                       │
│                    cmux new-split right            │
│                    cmux new-split down             │
│                    (based on layout config)        │
└─────────────────────────────────────────────────┘
```

## Configuration Changes

### schema.ts

```typescript
export const multiplexerTypeSchema = z.enum([
  'auto', 'tmux', 'zellij', 'cmux', 'none',
])
```

### factory.ts

```typescript
case 'cmux':
  return new CmuxMultiplexer()
```

Auto detection:
```typescript
function getAutoMultiplexerType(): MultiplexerType | null {
  if (process.env.CMUX_WORKSPACE_ID) return 'cmux'
  if (process.env.TMUX) return 'tmux'
  if (process.env.ZELLIJ) return 'zellij'
  return null
}
```

## Environment Variables Used

| Variable | Purpose |
|----------|---------|
| `CMUX_WORKSPACE_ID` | Detect in-session; target workspace for pane creation |
| `CMUX_SURFACE_ID` | Detect in-session (secondary check) |

## Testing

### cmux.test.ts

Mock `crossSpawn` and `process.env` to test:
1. `isInsideSession()` returns `true` when `CMUX_WORKSPACE_ID` is set
2. `isInsideSession()` returns `false` when not set
3. `isAvailable()` returns `true` when `command -v cmux` succeeds
4. `isAvailable()` returns `false` when binary not found
5. `spawnPane()` calls `cmux new-pane --direction right --json -- <cmd>` with correct args (including `--` separator and CDPATH handling)
6. `spawnPane()` parses `surface_ref` from JSON stdout
7. `closePane()` sends Ctrl+C then calls `close-surface`
8. `applyLayout()` calls `cmux new-split` with correct direction based on layout type
9. Layout debounce: multiple rapid `applyLayout` calls result in only one set of commands

### factory.test.ts (additions)

1. `getMultiplexer({ type: 'cmux' })` returns `CmuxMultiplexer` instance
2. `auto` mode detects cmux when `CMUX_WORKSPACE_ID` is set
3. `auto` mode cascades correctly (cmux has priority over tmux)
4. `none` mode still returns `null`

## Edge Cases

1. **Last surface protection**: cmux refuses to close the last surface. Not an issue since we only close surfaces we created as subagent panes.
2. **Shell injection in commands**: Commands passed to `new-pane` go through positional arguments after `--`, avoiding shell injection via flag parsing.
3. **New pane not ready immediately**: cmux may take a moment to initialize the terminal surface. Using `--json` ensures we get the surface_ref synchronously once created.
4. **CMUX_WORKSPACE_ID contains UUID**: The environment variable may contain a UUID (e.g., `550e8400-e29b-41d4-a716-446655440000`) rather than a ref like `workspace:2`. CMUX_WORKSPACE_ID should only be used for detection, not for passing to commands. However, cmux CLI commands accept both UUID and ref formats. If we need the workspace ref for commands, we can use `cmux identify --json` or just pass the UUID.
5. **Missing cmux CLI**: When cmux is running as a GUI app but CLI symlink is not set up, `isAvailable()` returns false. User needs to run the setup symlink command.

## Dependencies

- No new npm/bun dependencies required
- Uses existing `crossSpawn` utility from `src/utils/compat.ts`
- Uses existing `log` utility from `src/utils/logger.ts`

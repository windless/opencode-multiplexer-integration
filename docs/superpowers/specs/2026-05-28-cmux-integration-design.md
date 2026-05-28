# cmux Terminal Multiplexer Integration Design

**Date:** 2026-05-28  
**Status:** Approved (revised after specreview)

## Overview

Add support for [cmux](https://github.com/manaflow-ai/cmux) — the macOS-native terminal multiplexer based on Ghostty — to the `multiplexer-integration` OpenCode plugin. This enables automatic pane creation for subagent sessions when OpenCode runs inside cmux.

## Decision Summary

| Choice | Rationale |
|--------|-----------|
| Pure CLI integration | Consistent with existing tmux/zellij implementations; no socket management overhead |
| One-shot pane creation | `cmux new-pane --direction right "command"` creates pane + terminal surface with initial_command via positional arg |
| Layout: API-congruent no-op | cmux has no `select-layout` equivalent. Accept layout in constructor for API consistency (same as ZellijMultiplexer), but applyLayout is a no-op. |
| Graceful shutdown (Ctrl+C + close) | Send ETX character (`\u0003`) via `cmux send --surface <id>`, wait 250ms, then `close-surface` |

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

  constructor(layout, mainPaneSize)  // accept for API consistency (no-op)
  isInsideSession(): boolean
  isAvailable(): Promise<boolean>
  spawnPane(sessionId, description, serverUrl, directory): Promise<PaneResult>
  closePane(paneId: string): Promise<boolean>
  applyLayout(layout, mainPaneSize): Promise<void>  // no-op, see §5
}
```

### 2. Detection

**`isInsideSession()`**: Synchronous, zero I/O.
- Check `process.env.CMUX_WORKSPACE_ID` is defined and non-empty.
- cmux automatically sets `CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID`, `CMUX_TAB_ID` in managed terminals.

**`isAvailable()`**: Async, checks CLI binary availability.
- Use `which cmux` (or `where cmux` on Windows) — same pattern as TmuxMultiplexer.findBinary().
- No `cmux ping` check. Binary presence is sufficient; if the app is not running, spawnPane will fail with a clear error. This keeps isAvailable fast and side-effect-free.

**Auto detection** (in `factory.ts` `auto` mode):
```
if (CMUX_WORKSPACE_ID) → cmux
else if (TMUX) → tmux
else if (ZELLIJ) → zellij
```

cmux is checked first because it may also set `TERM_PROGRAM=ghostty` (from Ghostty base). The `CMUX_WORKSPACE_ID` check is unambiguous.

### 3. spawnPane

Creates a new pane in the current workspace running the opencode attach command.
Uses positional argument for initial_command (verified: cmux new-pane passes first positional arg as initial_command).

**Implementation:**
```typescript
// Build attach command (same format as tmux/zellij implementations)
const quotedDirectory = quoteShellArg(directory)
const quotedUrl = quoteShellArg(serverUrl)
const quotedSessionId = quoteShellArg(sessionId)

const opencodeCmd = [
  'opencode', 'attach', quotedUrl,
  '--session', quotedSessionId,
  '--dir', quotedDirectory,
].join(' ')

// cmux new-pane --direction right --json <initial_command>
const proc = crossSpawn([cmuxBin,
  'new-pane',
  '--direction', 'right',
  '--json',
  opencodeCmd,          // positional arg → initial_command
], { stdout: 'pipe', stderr: 'pipe' })

const stdout = await proc.stdout()
const output = JSON.parse(stdout)
const surfaceRef = output.surface_ref  // e.g., "surface:5"
```

**Returns:** `{ success: true, paneId: surfaceRef }` (we use surface ID as the pane identifier for close/send operations).

**Focus behavior:** cmux `new-pane` does NOT have an explicit `--focus false` CLI flag. If focus-stealing becomes an issue, it can be mitigated later via RPC.

### 4. closePane

Graceful shutdown: send Ctrl+C first, then close the surface.

```typescript
// Step 1: Send Ctrl+C (ETX, \u0003) to surface for graceful termination
// Uses raw control character, not shell expansion.
await crossSpawn([cmuxBin, 'send', '--surface', paneId, '\u0003'])

// Step 2: Wait 250ms for process to exit
await new Promise(resolve => setTimeout(resolve, 250))

// Step 3: Close the surface
await crossSpawn([cmuxBin, 'close-surface', '--surface', paneId])
```

**Why `\u0003` and not `$(printf '\\x03')`:** `crossSpawn` passes strings directly to `spawn` args without shell expansion. The string `\u0003` is a JavaScript escape for the ETX character byte 0x03, matching the approach used in `ZellijMultiplexer.closePane` (`'\u0003'`).

**Note:** cmux prevents closing the last surface in a workspace. This won't affect us because we only close surfaces we created as subagent panes. If the user has already closed the main pane (making our surface the last one), close-surface will fail gracefully and return false.

**Returns:** `true` on success, `false` on failure.

### 5. applyLayout — No-op (API-congruent)

cmux has **no `select-layout` equivalent**. The `new-split` command semantically creates new splits/pane-surfaces — it does **not** rebalance or rearrange existing panes. Using `new-split` for layout would create unwanted empty splits after each pane spawn.

**Decision:** `applyLayout()` is a **no-op**, same as `ZellijMultiplexer.applyLayout()`. The constructor accepts `layout` and `mainPaneSize` parameters for API consistency but does not use them.

```typescript
constructor(layout: MultiplexerLayout = 'main-vertical', mainPaneSize = 60) {
  // cmux does not support programmatic layout control.
  // Parameters accepted for API consistency (same as ZellijMultiplexer).
  void layout
  void mainPaneSize
}

async applyLayout(_layout: MultiplexerLayout, _mainPaneSize: number): Promise<void> {
  // No-op: cmux has no select-layout equivalent.
}
```

This avoids the false equivalence of mapping `new-split` to layout rebalancing, which would produce unintended side effects (extra empty splits) on every spawnPane burst.

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
  multiplexer = new CmuxMultiplexer(config.layout, config.main_pane_size)
  actualType = 'cmux'
  break
```

Auto detection:
```typescript
case 'auto': {
  if (process.env.CMUX_WORKSPACE_ID) {
    multiplexer = new CmuxMultiplexer(config.layout, config.main_pane_size)
    actualType = 'cmux'
  } else if (process.env.TMUX) {
    // ...existing tmux/zellij branches
  }
}
```

```typescript
function getAutoMultiplexerType(): 'tmux' | 'zellij' | 'cmux' | 'none' {
  if (process.env.CMUX_WORKSPACE_ID) return 'cmux'
  if (process.env.TMUX) return 'tmux'
  if (process.env.ZELLIJ) return 'zellij'
  return 'none'
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
3. `isAvailable()` returns `true` when `which cmux` succeeds
4. `isAvailable()` returns `false` when binary not found
5. `spawnPane()` calls `cmux new-pane --direction right --json <cmd>` with correct args
6. `spawnPane()` parses `surface_ref` from JSON stdout; returns failure on missing/parse error
7. `spawnPane()` returns `{ success: false }` when binary unavailable or new-pane exits non-zero
8. `closePane()` sends `\u0003` (ETX) then calls `close-surface` after delay
9. `closePane()` returns `false` for empty paneId
10. `closePane()` returns `false` when close-surface fails
11. `applyLayout()` does NOT spawn any cmux commands (verify no-op)
12. Constructor accepts layout and mainPaneSize without error

### factory.test.ts (additions)

1. `getMultiplexer({ type: 'cmux' })` returns `CmuxMultiplexer` instance with `type === 'cmux'`
2. `auto` mode detects cmux when `CMUX_WORKSPACE_ID` is set
3. `auto` mode cascades correctly (cmux has priority over tmux)
4. `none` mode still returns `null`

## Edge Cases

1. **Last surface protection**: cmux refuses to close the last surface. Since we only close surfaces we created, the user's original surface is always present. If the user closes their surface first, closePane will fail gracefully.
2. **Shell injection in commands**: Commands are passed as a single positional argument to `new-pane`, not through a shell. The `quoteShellArg` helper follows the same pattern as TmuxMultiplexer.
3. **JSON parse failure**: If `new-pane --json` returns malformed JSON or missing `surface_ref`, spawnPane returns `{ success: false }` gracefully.
4. **CMUX_WORKSPACE_ID format**: May be a UUID (e.g., `550e8400-...`) rather than a ref like `workspace:2`. Used only for detection; commands that need workspace context use `new-pane` which auto-targets the caller's workspace.
5. **Missing cmux CLI**: When cmux is running as a GUI app but CLI symlink is not set up, `isAvailable()` returns false. User needs to run the setup symlink command from cmux docs.

## Dependencies

- No new npm/bun dependencies required
- Uses existing `crossSpawn` utility from `src/utils/compat.ts`
- Uses existing `log` utility from `src/utils/logger.ts`

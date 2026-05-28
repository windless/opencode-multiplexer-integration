# cmux Terminal Multiplexer Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cmux terminal multiplexer support to the multiplexer-integration plugin so OpenCode subagent sessions automatically spawn panes inside cmux workspaces.

**Architecture:** Create `CmuxMultiplexer` class implementing the `Multiplexer` interface using cmux CLI commands (`new-pane`, `close-surface`, `send`). Follows tmux/zellij detection patterns. Layout is a no-op (same as ZellijMultiplexer) since cmux has no `select-layout` equivalent. ClosePane uses raw `\u0003` control character for Ctrl+C — same approach as ZellijMultiplexer.

**Tech Stack:** TypeScript, Bun test runner, cmux CLI (v0.64+)

**Post-review corrections applied:**
- Ctrl+C sent as `'\u0003'` (raw ETX byte), not `$(printf '\\x03')` shell expansion
- `new-pane` command: positional arg for initial_command, no `--` separator
- `applyLayout`: no-op (cmux `new-split` creates splits, does not rebalance)
- `isAvailable`: binary check only (`which cmux`), no `ping`
- Tests use dynamic import, not `require`

---

### Task 1: Extend type system and schema

**Files:**
- Modify: `src/multiplexer/types.ts:20`
- Modify: `src/config/schema.ts:4`
- Modify: `src/multiplexer/index.ts` — add export

- [ ] **Step 1: Add 'cmux' to Multiplexer type union**

```typescript
// src/multiplexer/types.ts line 20 — change:
readonly type: 'tmux' | 'zellij';
// to:
readonly type: 'tmux' | 'zellij' | 'cmux';
```

- [ ] **Step 2: Add 'cmux' to MultiplexerType schema**

```typescript
// src/config/schema.ts line 4 — change:
export const MultiplexerTypeSchema = z.enum(['auto', 'tmux', 'zellij', 'none']);
// to:
export const MultiplexerTypeSchema = z.enum(['auto', 'tmux', 'zellij', 'cmux', 'none']);
```

- [ ] **Step 3: Add CmuxMultiplexer export**

```typescript
// src/multiplexer/index.ts — add after ZellijMultiplexer export
export { CmuxMultiplexer } from './cmux';
```

- [ ] **Step 4: Verify TypeScript compiles (missing module expected)**

Run: `npx tsc --noEmit`
Expected: Error for `'./cmux'` module not found (expected — not created yet)

---

### Task 2: Create CmuxMultiplexer with detection and no-op stubs

**Files:**
- Create: `src/multiplexer/cmux/index.ts`
- Create: `tests/cmux.test.ts`

- [ ] **Step 1: Write the full test file**

```typescript
// tests/cmux.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type SpawnResult = {
  exited: Promise<number>;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
  kill: () => boolean;
  exitCode: number | null;
  proc: never;
};

const logMock = mock(() => {});
const crossSpawnMock = mock((_command: string[]) => createSpawnResult());

mock.module('../src/utils/logger', () => ({
  log: logMock,
}));

mock.module('../src/utils/compat', () => ({
  crossSpawn: crossSpawnMock,
}));

let importCounter = 0;

function createSpawnResult(
  exitCode = 0,
  stdout = '',
  stderr = '',
): SpawnResult {
  return {
    exited: Promise.resolve(exitCode),
    stdout: () => Promise.resolve(stdout),
    stderr: () => Promise.resolve(stderr),
    kill: () => true,
    exitCode,
    proc: {} as never,
  };
}

async function importFreshCmux() {
  return import(`../src/multiplexer/cmux/index?test=${importCounter++}`);
}

function commands(): string[][] {
  return crossSpawnMock.mock.calls.map((call) => call[0] as string[]);
}

// ─── Detection tests ──────────────────────────────

describe('CmuxMultiplexer — detection', () => {
  const originalCmuxWorkspaceId = process.env.CMUX_WORKSPACE_ID;
  const originalCmuxSurfaceId = process.env.CMUX_SURFACE_ID;

  afterEach(() => {
    process.env.CMUX_WORKSPACE_ID = originalCmuxWorkspaceId;
    process.env.CMUX_SURFACE_ID = originalCmuxSurfaceId;
  });

  test('isInsideSession returns true when CMUX_WORKSPACE_ID is set', async () => {
    process.env.CMUX_WORKSPACE_ID = 'workspace-1';
    process.env.CMUX_SURFACE_ID = 'surface-1';

    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    expect(cmux.isInsideSession()).toBe(true);
  });

  test('isInsideSession returns false when CMUX_WORKSPACE_ID is not set', async () => {
    delete process.env.CMUX_WORKSPACE_ID;
    delete process.env.CMUX_SURFACE_ID;

    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    expect(cmux.isInsideSession()).toBe(false);
  });

  test('isAvailable returns true when cmux CLI is found', async () => {
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/local/bin/cmux\n');
      return createSpawnResult();
    });

    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    const available = await cmux.isAvailable();
    expect(available).toBe(true);
  });

  test('isAvailable returns false when cmux CLI is not found', async () => {
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation(() => createSpawnResult(1));

    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    const available = await cmux.isAvailable();
    expect(available).toBe(false);
  });
});

// ─── spawnPane tests ──────────────────────────────

describe('CmuxMultiplexer — spawnPane', () => {
  beforeEach(() => {
    process.env.CMUX_WORKSPACE_ID = 'workspace-1';
    process.env.CMUX_SURFACE_ID = 'surface-1';

    logMock.mockClear();
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/local/bin/cmux\n');
      if (command[1] === 'new-pane') {
        return createSpawnResult(
          0,
          JSON.stringify({
            surface_ref: 'surface:5',
            pane_ref: 'pane:3',
            workspace_ref: 'workspace:1',
          }),
        );
      }
      return createSpawnResult();
    });
  });

  test('spawnPane creates a new pane with correct command args', async () => {
    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    await cmux.isAvailable(); // trigger binary detection

    const result = await cmux.spawnPane(
      'session-abc',
      'my-agent',
      'http://localhost:4096',
      '/home/user/project',
    );

    expect(result.success).toBe(true);
    expect(result.paneId).toBe('surface:5');

    // Verify new-pane command args
    const newPaneCalls = commands().filter((c) => c[1] === 'new-pane');
    expect(newPaneCalls).toHaveLength(1);

    const newPaneArgs = newPaneCalls[0];
    expect(newPaneArgs).toContain('--direction');
    expect(newPaneArgs).toContain('right');
    expect(newPaneArgs).toContain('--json');

    // The last argument should be the opencode attach command (positional arg, no -- separator)
    const attachCmd = newPaneArgs[newPaneArgs.length - 1];
    expect(attachCmd).toContain('opencode attach');
    expect(attachCmd).toContain('session-abc');
    expect(attachCmd).toContain('http://localhost:4096');
  });

  test('spawnPane returns success:false when binary not available', async () => {
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation(() => createSpawnResult(1));

    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    const result = await cmux.spawnPane(
      'session-abc', 'agent',
      'http://localhost:4096', '/repo',
    );

    expect(result.success).toBe(false);
  });

  test('spawnPane returns success:false when new-pane exits non-zero', async () => {
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/local/bin/cmux\n');
      if (command[1] === 'new-pane')
        return createSpawnResult(1, '', 'pane creation failed');
      return createSpawnResult();
    });

    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    const result = await cmux.spawnPane(
      'session-abc', 'agent',
      'http://localhost:4096', '/repo',
    );

    expect(result.success).toBe(false);
  });

  test('spawnPane handles missing surface_ref in JSON', async () => {
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/local/bin/cmux\n');
      if (command[1] === 'new-pane')
        return createSpawnResult(
          0,
          JSON.stringify({ pane_ref: 'pane:3' }), // no surface_ref
        );
      return createSpawnResult();
    });

    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    const result = await cmux.spawnPane(
      'session-abc', 'agent',
      'http://localhost:4096', '/repo',
    );

    expect(result.success).toBe(false);
  });
});

// ─── closePane tests ──────────────────────────────

describe('CmuxMultiplexer — closePane', () => {
  beforeEach(() => {
    logMock.mockClear();
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/local/bin/cmux\n');
      return createSpawnResult(0, '', '');
    });
  });

  test('closePane sends Ctrl+C then close-surface', async () => {
    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    await cmux.isAvailable();
    crossSpawnMock.mockClear(); // clear which calls

    const result = await cmux.closePane('surface:5');

    expect(result).toBe(true);

    const allCalls = commands();

    // First call: send Ctrl+C (raw ETX byte)
    const sendCalls = allCalls.filter((c) => c[1] === 'send');
    expect(sendCalls).toHaveLength(1);

    const sendArgs = sendCalls[0];
    const surfaceIdx = sendArgs.indexOf('surface:5');
    expect(surfaceIdx).toBeGreaterThan(0);
    expect(sendArgs[surfaceIdx - 1]).toBe('--surface');

    // The text argument should be the raw ETX byte \x03
    const textArg = sendArgs[sendArgs.length - 1];
    expect(textArg).toBe('\u0003');

    // Second call: close-surface
    const closeCalls = allCalls.filter((c) => c[1] === 'close-surface');
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0]).toContain('--surface');
    expect(closeCalls[0]).toContain('surface:5');
  });

  test('closePane returns false for empty paneId', async () => {
    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    const result = await cmux.closePane('');
    expect(result).toBe(false);
  });

  test('closePane returns false when close-surface fails', async () => {
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/local/bin/cmux\n');
      if (command[1] === 'send')
        return createSpawnResult(0, '', '');
      if (command[1] === 'close-surface')
        return createSpawnResult(1, '', 'no such surface');
      return createSpawnResult();
    });

    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    const result = await cmux.closePane('surface:99');
    expect(result).toBe(false);
  });
});

// ─── applyLayout tests (no-op) ────────────────────

describe('CmuxMultiplexer — applyLayout', () => {
  beforeEach(() => {
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation(() => createSpawnResult());
  });

  test('applyLayout is a no-op (does not spawn any cmux commands)', async () => {
    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    await cmux.applyLayout('main-vertical', 60);
    await cmux.applyLayout('tiled', 60);
    await cmux.applyLayout('even-horizontal', 60);

    // After all applyLayout calls, no commands should have been spawned
    // (beyond any initial which)
    const layoutCmds = commands().filter((c) =>
      c.includes('new-split') || c.includes('new-pane'),
    );
    expect(layoutCmds).toHaveLength(0);
  });

  test('constructor accepts layout and mainPaneSize without error', () => {
    const { CmuxMultiplexer } = require('../src/multiplexer/cmux/index');

    expect(() => new CmuxMultiplexer('main-vertical', 60)).not.toThrow();
    expect(() => new CmuxMultiplexer('tiled', 50)).not.toThrow();
    expect(() => new CmuxMultiplexer()).not.toThrow();
    expect(() => new CmuxMultiplexer(undefined, undefined)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests — they should fail (module not found)**

Run: `npx bun test tests/cmux.test.ts`
Expected: FAIL — `Cannot find module '../src/multiplexer/cmux/index'`

- [ ] **Step 3: Write CmuxMultiplexer implementation with detection, spawnPane, closePane, no-op applyLayout**

```typescript
// src/multiplexer/cmux/index.ts
/**
 * cmux multiplexer implementation
 *
 * cmux is a macOS-native terminal multiplexer built on Ghostty (libghostty).
 * It provides rich CLI with --json output for programmatic control.
 *
 * Key commands used:
 *   new-pane --direction right --json <cmd>   — create pane + terminal surface
 *   close-surface --surface <id>              — close a surface
 *   send --surface <id> <text>                — send text/keys to surface
 *
 * Layout: No-op (same as ZellijMultiplexer). cmux has no select-layout
 * equivalent; new-split creates new splits, it does not rebalance.
 */

import type { MultiplexerLayout } from '../../config/schema';
import { crossSpawn } from '../../utils/compat';
import { log } from '../../utils/logger';
import type { Multiplexer, PaneResult } from '../types';

export class CmuxMultiplexer implements Multiplexer {
  readonly type = 'cmux' as const;

  private binaryPath: string | null = null;
  private hasChecked = false;

  constructor(layout: MultiplexerLayout = 'main-vertical', mainPaneSize = 60) {
    // cmux does not support programmatic layout control.
    // Parameters accepted for API consistency (same as ZellijMultiplexer).
    void layout;
    void mainPaneSize;
  }

  async isAvailable(): Promise<boolean> {
    if (this.hasChecked) {
      return this.binaryPath !== null;
    }

    this.binaryPath = await this.findBinary();
    this.hasChecked = true;
    return this.binaryPath !== null;
  }

  isInsideSession(): boolean {
    return !!process.env.CMUX_WORKSPACE_ID;
  }

  // ─── spawnPane ──────────────────────────────

  async spawnPane(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
  ): Promise<PaneResult> {
    const cmuxBin = await this.getBinary();
    if (!cmuxBin) {
      log('[cmux] spawnPane: cmux binary not found');
      return { success: false };
    }

    try {
      // Build opencode attach command (same format as tmux/zellij)
      const quotedDirectory = quoteShellArg(directory);
      const quotedUrl = quoteShellArg(serverUrl);
      const quotedSessionId = quoteShellArg(sessionId);

      const opencodeCmd = [
        'opencode', 'attach', quotedUrl,
        '--session', quotedSessionId,
        '--dir', quotedDirectory,
      ].join(' ');

      // cmux new-pane --direction right --json <initial_command>
      // Positional arg after flags becomes initial_command
      const args = [
        'new-pane',
        '--direction', 'right',
        '--json',
        opencodeCmd,
      ];

      log('[cmux] spawnPane: executing', { cmuxBin, args });

      const proc = crossSpawn([cmuxBin, ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;
      const stdout = await proc.stdout();
      const stderr = await proc.stderr();

      log('[cmux] spawnPane: result', {
        exitCode,
        stderr: stderr.trim(),
      });

      if (exitCode === 0) {
        try {
          const output = JSON.parse(stdout) as {
            surface_ref?: string;
            pane_ref?: string;
          };
          const surfaceRef = output.surface_ref;
          if (surfaceRef) {
            // Rename the pane for visibility (best-effort, non-blocking)
            this.renamePane(surfaceRef, description);

            log('[cmux] spawnPane: SUCCESS', {
              surfaceRef,
              paneRef: output.pane_ref,
            });
            return { success: true, paneId: surfaceRef };
          }

          log('[cmux] spawnPane: no surface_ref in output', { output });
        } catch (parseErr) {
          log('[cmux] spawnPane: JSON parse failed', {
            stdout,
            error: String(parseErr),
          });
        }
      }

      return { success: false };
    } catch (err) {
      log('[cmux] spawnPane: exception', { error: String(err) });
      return { success: false };
    }
  }

  // ─── closePane ──────────────────────────────

  async closePane(paneId: string): Promise<boolean> {
    if (!paneId) {
      log('[cmux] closePane: no paneId provided');
      return false;
    }

    const cmuxBin = await this.getBinary();
    if (!cmuxBin) {
      log('[cmux] closePane: cmux binary not found');
      return false;
    }

    try {
      // Step 1: Send Ctrl+C (ETX byte) for graceful shutdown
      // Uses raw \u0003, same approach as ZellijMultiplexer.
      // crossSpawn passes strings directly to spawn args, no shell expansion.
      log('[cmux] closePane: sending Ctrl+C', { paneId });
      const ctrlCProc = crossSpawn(
        [cmuxBin, 'send', '--surface', paneId, '\u0003'],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      await ctrlCProc.exited;

      // Step 2: Wait for graceful shutdown
      await new Promise((r) => setTimeout(r, 250));

      // Step 3: Close the surface
      log('[cmux] closePane: closing surface', { paneId });
      const proc = crossSpawn(
        [cmuxBin, 'close-surface', '--surface', paneId],
        { stdout: 'pipe', stderr: 'pipe' },
      );

      const exitCode = await proc.exited;
      const stderr = await proc.stderr();

      log('[cmux] closePane: result', { exitCode, stderr: stderr.trim() });

      if (exitCode === 0) {
        return true;
      }

      log('[cmux] closePane: failed (surface may already be closed)', {
        paneId,
      });
      return false;
    } catch (err) {
      log('[cmux] closePane: exception', { error: String(err) });
      return false;
    }
  }

  // ─── applyLayout (no-op) ────────────────────

  async applyLayout(
    _layout: MultiplexerLayout,
    _mainPaneSize: number,
  ): Promise<void> {
    // No-op: cmux has no select-layout equivalent.
    // cmux new-split creates new split surfaces — it does NOT rebalance
    // existing panes. Using it for layout would create unwanted empty splits.
  }

  // ─── private helpers ────────────────────────

  private async findBinary(): Promise<string | null> {
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'where' : 'which';

    try {
      const proc = crossSpawn([cmd, 'cmux'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        log("[cmux] findBinary: 'which cmux' failed", { exitCode });
        return null;
      }

      const stdout = await proc.stdout();
      const path = stdout.trim().split('\n')[0];
      if (!path) {
        log('[cmux] findBinary: no path in output');
        return null;
      }

      log('[cmux] findBinary: found', { path });
      return path;
    } catch (err) {
      log('[cmux] findBinary: exception', { error: String(err) });
      return null;
    }
  }

  private async getBinary(): Promise<string | null> {
    await this.isAvailable();
    return this.binaryPath;
  }

  /**
   * Rename a pane for visibility (best-effort, non-blocking).
   * cmux uses pane title via ANSI escape sequences rather than a CLI flag.
   * This sends an OSC escape to set the terminal title.
   */
  private renamePane(surfaceRef: string, description: string): void {
    // cmux send reads terminal title from OSC sequences.
    // Best-effort: fire-and-forget, don't block.
    const title = description.slice(0, 30);
    crossSpawn(
      ['cmux', 'send', '--surface', surfaceRef, `\x1b]0;${title}\x07`],
      { stdout: 'ignore', stderr: 'ignore' },
    );
  }
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
```

- [ ] **Step 4: Run tests — should all pass**

Run: `npx bun test tests/cmux.test.ts`
Expected: ALL tests PASS (~12 tests)

---

### Task 3: Wire up factory and auto-detection

**Files:**
- Modify: `src/multiplexer/factory.ts`
- Modify: `tests/factory.test.ts`

- [ ] **Step 1: Add factory tests**

Append to `tests/factory.test.ts`:

```typescript
describe('cmux factory', () => {
  const originalCmuxWorkspaceId = process.env.CMUX_WORKSPACE_ID;
  const originalTmux = process.env.TMUX;
  const originalZellij = process.env.ZELLIJ;

  afterEach(() => {
    process.env.CMUX_WORKSPACE_ID = originalCmuxWorkspaceId;
    process.env.TMUX = originalTmux;
    process.env.ZELLIJ = originalZellij;
  });

  test('returns a cmux instance when type is cmux', async () => {
    const { getMultiplexer } = await importFreshFactory('cmux-direct');

    const mux = getMultiplexer({
      type: 'cmux',
      layout: 'main-vertical',
      main_pane_size: 60,
    });

    expect(mux).not.toBeNull();
    expect(mux!.type).toBe('cmux');
  });

  test('auto mode detects cmux when CMUX_WORKSPACE_ID is set', async () => {
    process.env.CMUX_WORKSPACE_ID = 'workspace-uuid-123';
    delete process.env.TMUX;
    delete process.env.ZELLIJ;

    const { getMultiplexer } = await importFreshFactory('cmux-auto');

    const mux = getMultiplexer({
      type: 'auto',
      layout: 'main-vertical',
      main_pane_size: 60,
    });

    expect(mux).not.toBeNull();
    expect(mux!.type).toBe('cmux');
  });

  test('cmux has priority over tmux in auto mode', async () => {
    process.env.CMUX_WORKSPACE_ID = 'workspace-uuid-123';
    process.env.TMUX = '/tmp/tmux-1000/default,1,0';

    const { getMultiplexer } = await importFreshFactory('cmux-priority');

    const mux = getMultiplexer({
      type: 'auto',
      layout: 'main-vertical',
      main_pane_size: 60,
    });

    expect(mux).not.toBeNull();
    expect(mux!.type).toBe('cmux');
  });

  test('none type returns null', async () => {
    const { getMultiplexer } = await importFreshFactory('none');

    const mux = getMultiplexer({ type: 'none' });
    expect(mux).toBeNull();
  });
});
```

- [ ] **Step 2: Run factory tests — cmux tests should fail**

Run: `npx bun test tests/factory.test.ts`
Expected: cmux factory tests FAIL (factory doesn't handle 'cmux')

- [ ] **Step 3: Add cmux to factory.ts**

**Add import** (after zellij import):
```typescript
import { CmuxMultiplexer } from './cmux';
```

**Add cmux case in switch** (before `case 'zellij'`):
```typescript
case 'cmux':
  multiplexer = new CmuxMultiplexer(config.layout, config.main_pane_size);
  actualType = 'cmux';
  break;
```

**Update auto detection** (replace the `case 'auto'` block):
```typescript
case 'auto': {
  // Auto-detect based on environment variables only
  // cmux first: CMUX_WORKSPACE_ID is unambiguous; TMUX/TERM_PROGRAM may be set
  if (process.env.CMUX_WORKSPACE_ID) {
    multiplexer = new CmuxMultiplexer(config.layout, config.main_pane_size);
    actualType = 'cmux';
  } else if (process.env.TMUX) {
    multiplexer = new TmuxMultiplexer(config.layout, config.main_pane_size);
    actualType = 'tmux';
  } else if (process.env.ZELLIJ) {
    multiplexer = new ZellijMultiplexer(
      config.layout,
      config.main_pane_size,
    );
    actualType = 'zellij';
  } else {
    log('[multiplexer] auto: not inside any session, disabling');
    return null;
  }
  break;
}
```

**Update `getAutoMultiplexerType`**:
```typescript
export function getAutoMultiplexerType(): 'tmux' | 'zellij' | 'cmux' | 'none' {
  if (process.env.CMUX_WORKSPACE_ID) {
    return 'cmux';
  }
  if (process.env.TMUX) {
    return 'tmux';
  }
  if (process.env.ZELLIJ) {
    return 'zellij';
  }
  return 'none';
}
```

- [ ] **Step 4: Run all tests**

Run: `npx bun test tests/cmux.test.ts tests/factory.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Verify TypeScript**

Run: `npx tsc --noEmit`
Expected: No errors (except pre-existing bun:test LSP warnings)

---

### Task 4: Run full test suite and verification

- [ ] **Step 1: Run all project tests**

Run: `npx bun test`
Expected: ALL tests PASS (tmux, zellij, factory, session-manager, cmux)

- [ ] **Step 2: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 3: Run linter**

Run: `npx biome check src/`
Expected: No format/lint errors

- [ ] **Step 4: Review final file changes**

```
Files created:
  src/multiplexer/cmux/index.ts

Files modified:
  src/multiplexer/types.ts          (line 20: type union)
  src/config/schema.ts              (line 4: enum value)
  src/multiplexer/factory.ts        (import + cases + auto detection)
  src/multiplexer/index.ts          (export)
  tests/cmux.test.ts                (new)
  tests/factory.test.ts             (cmux factory tests)
```

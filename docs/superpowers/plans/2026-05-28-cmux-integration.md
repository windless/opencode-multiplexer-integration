# cmux Terminal Multiplexer Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cmux terminal multiplexer support to the multiplexer-integration plugin so OpenCode subagent sessions automatically spawn panes inside cmux workspaces.

**Architecture:** Create `CmuxMultiplexer` class implementing the `Multiplexer` interface using cmux CLI commands (`new-pane`, `new-split`, `close-surface`, `send`). Follow the same pattern as `TmuxMultiplexer`: binary detection via `which`, debounced layout application, and graceful pane closure (Ctrl+C → wait → close).

**Tech Stack:** TypeScript, Bun test runner, cmux CLI (v0.64+)

---

### Task 1: Extend type system and schema

**Files:**
- Modify: `src/multiplexer/types.ts:20`
- Modify: `src/config/schema.ts:4`
- Modify: `src/multiplexer/index.ts:17` (add export)

- [ ] **Step 1: Add 'cmux' to Multiplexer type union**

```typescript
// src/multiplexer/types.ts line 20
readonly type: 'tmux' | 'zellij' | 'cmux';
```

- [ ] **Step 2: Add 'cmux' to MultiplexerType schema**

```typescript
// src/config/schema.ts line 4
export const MultiplexerTypeSchema = z.enum(['auto', 'tmux', 'zellij', 'cmux', 'none']);
```

- [ ] **Step 3: Add CmuxMultiplexer export**

```typescript
// src/multiplexer/index.ts — add after ZellijMultiplexer export
export { CmuxMultiplexer } from './cmux';
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Missing module error for `./cmux` (expected — not created yet)

- [ ] **Step 5: Commit**

```bash
git add src/multiplexer/types.ts src/config/schema.ts src/multiplexer/index.ts
git commit -m "feat(types): add cmux to Multiplexer type union and schema"
```

---

### Task 2: Create CmuxMultiplexer with detection methods

**Files:**
- Create: `src/multiplexer/cmux/index.ts`

- [ ] **Step 1: Write the failing tests for isInsideSession and isAvailable**

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

describe('CmuxMultiplexer — detection', () => {
  const originalCmuxWorkspaceId = process.env.CMUX_WORKSPACE_ID;
  const originalCmuxSurfaceId = process.env.CMUX_SURFACE_ID;

  afterEach(() => {
    process.env.CMUX_WORKSPACE_ID = originalCmuxWorkspaceId;
    process.env.CMUX_SURFACE_ID = originalCmuxSurfaceId;
  });

  test('isInsideSession returns true when CMUX_WORKSPACE_ID is set', () => {
    process.env.CMUX_WORKSPACE_ID = 'workspace-1';
    process.env.CMUX_SURFACE_ID = 'surface-1';

    const { CmuxMultiplexer } = require('../src/multiplexer/cmux/index');
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    expect(cmux.isInsideSession()).toBe(true);
  });

  test('isInsideSession returns false when CMUX_WORKSPACE_ID is not set', () => {
    delete process.env.CMUX_WORKSPACE_ID;
    delete process.env.CMUX_SURFACE_ID;

    const { CmuxMultiplexer } = require('../src/multiplexer/cmux/index');
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

    const { CmuxMultiplexer } = require('../src/multiplexer/cmux/index');
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    const available = await cmux.isAvailable();
    expect(available).toBe(true);
  });

  test('isAvailable returns false when cmux CLI is not found', async () => {
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation((_command: string[]) => {
      return createSpawnResult(1); // which fails
    });

    const { CmuxMultiplexer } = require('../src/multiplexer/cmux/index');
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    const available = await cmux.isAvailable();
    expect(available).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx bun test tests/cmux.test.ts`
Expected: FAIL — module `../src/multiplexer/cmux/index` not found

- [ ] **Step 3: Write CmuxMultiplexer with detection methods**

```typescript
// src/multiplexer/cmux/index.ts
/**
 * cmux multiplexer implementation
 *
 * cmux is a macOS-native terminal multiplexer built on Ghostty (libghostty).
 * It provides rich CLI with --json output for programmatic control.
 *
 * Key commands used:
 *   new-pane --direction right --json -- <cmd>   — create pane + terminal surface
 *   new-split right|down                          — split layout
 *   close-surface --surface <id>                 — close a surface
 *   send --surface <id> <text>                   — send text to surface
 */

import type { MultiplexerLayout } from '../../config/schema';
import { crossSpawn } from '../../utils/compat';
import { log } from '../../utils/logger';
import type { Multiplexer, PaneResult } from '../types';

const CMUX_LAYOUT_DEBOUNCE_MS = 150;

export class CmuxMultiplexer implements Multiplexer {
  readonly type = 'cmux' as const;

  private binaryPath: string | null = null;
  private hasChecked = false;
  private storedLayout: MultiplexerLayout;
  private storedMainPaneSize: number;
  private layoutTimer?: ReturnType<typeof setTimeout>;
  private layoutGeneration = 0;

  constructor(layout: MultiplexerLayout = 'main-vertical', mainPaneSize = 60) {
    this.storedLayout = layout;
    this.storedMainPaneSize = mainPaneSize;
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

  // Placeholder stubs for remaining Multiplexer methods
  async spawnPane(
    _sessionId: string,
    _description: string,
    _serverUrl: string,
    _directory: string,
  ): Promise<PaneResult> {
    return { success: false };
  }

  async closePane(_paneId: string): Promise<boolean> {
    return false;
  }

  async applyLayout(
    _layout: MultiplexerLayout,
    _mainPaneSize: number,
  ): Promise<void> {
    // no-op for now
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx bun test tests/cmux.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/multiplexer/cmux/index.ts tests/cmux.test.ts
git commit -m "feat(cmux): add CmuxMultiplexer class with detection methods"
```

---

### Task 3: Implement spawnPane

**Files:**
- Modify: `src/multiplexer/cmux/index.ts` — replace spawnPane stub
- Modify: `tests/cmux.test.ts` — add spawnPane tests

- [ ] **Step 1: Add spawnPane tests**

Append to `tests/cmux.test.ts` inside the describe block:

```typescript
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

  test('spawnPane creates a new pane with the correct command', async () => {
    const { CmuxMultiplexer } = require('../src/multiplexer/cmux/index');
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    // trigger isAvailable so next calls use cached binary
    await cmux.isAvailable();

    const result = await cmux.spawnPane(
      'session-abc',
      'my-agent',
      'http://localhost:4096',
      '/home/user/project',
    );

    expect(result.success).toBe(true);
    expect(result.paneId).toBe('surface:5');

    // Verify the new-pane command
    const newPaneCalls = commands().filter((c) => c[1] === 'new-pane');
    expect(newPaneCalls).toHaveLength(1);

    const newPaneArgs = newPaneCalls[0];
    expect(newPaneArgs).toContain('--direction');
    expect(newPaneArgs).toContain('right');
    expect(newPaneArgs).toContain('--json');

    // The last argument after '--' should be the opencode attach command
    const dashIndex = newPaneArgs.indexOf('--');
    expect(dashIndex).toBeGreaterThan(0);
    const attachCmd = newPaneArgs[dashIndex + 1] as string;
    expect(attachCmd).toContain('opencode attach');
    expect(attachCmd).toContain('session-abc');
    expect(attachCmd).toContain('http://localhost:4096');
  });

  test('spawnPane returns success:false when cmux binary not available', async () => {
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation(() => createSpawnResult(1));

    const { CmuxMultiplexer } = require('../src/multiplexer/cmux/index');
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    const result = await cmux.spawnPane(
      'session-abc',
      'agent',
      'http://localhost:4096',
      '/repo',
    );

    expect(result.success).toBe(false);
  });

  test('spawnPane returns success:false when new-pane exits with non-zero', async () => {
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/local/bin/cmux\n');
      if (command[1] === 'new-pane')
        return createSpawnResult(1, '', 'pane creation failed');
      return createSpawnResult();
    });

    const { CmuxMultiplexer } = require('../src/multiplexer/cmux/index');
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    const result = await cmux.spawnPane(
      'session-abc',
      'agent',
      'http://localhost:4096',
      '/repo',
    );

    expect(result.success).toBe(false);
  });

  test('spawnPane schedules layout after successful creation', async () => {
    const { CmuxMultiplexer } = require('../src/multiplexer/cmux/index');
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    await cmux.spawnPane(
      'session-1',
      'First worker',
      'http://localhost:4096',
      '/repo',
    );

    // Layout is scheduled (debounced), not applied immediately
    const newSplitCalls = commands().filter((c) => c[1] === 'new-split');
    expect(newSplitCalls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx bun test tests/cmux.test.ts`
Expected: spawnPane tests FAIL (stub returns `{ success: false }`)

- [ ] **Step 3: Implement spawnPane**

Replace the `spawnPane` stub in `src/multiplexer/cmux/index.ts`:

```typescript
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
    // Build the opencode attach command
    const quotedDirectory = quoteShellArg(directory);
    const quotedUrl = quoteShellArg(serverUrl);
    const quotedSessionId = quoteShellArg(sessionId);

    const opencodeCmd = [
      'opencode',
      'attach',
      quotedUrl,
      '--session',
      quotedSessionId,
      '--dir',
      quotedDirectory,
    ].join(' ');

    const args = [
      'new-pane',
      '--direction',
      'right',
      '--json',
      '--',
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
          // Schedule layout rebalance after pane creation settles
          this.scheduleLayout();

          log('[cmux] spawnPane: SUCCESS', {
            surfaceRef,
            paneRef: output.pane_ref,
          });
          return { success: true, paneId: surfaceRef };
        }
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
```

Also add the `scheduleLayout` and `quoteShellArg` helpers (will be used by later tasks):

```typescript
// Add at the bottom of the class, before the closing brace
private scheduleLayout(): void {
  if (this.layoutTimer) clearTimeout(this.layoutTimer);

  const gen = ++this.layoutGeneration;
  this.layoutTimer = setTimeout(() => {
    this.layoutTimer = undefined;
    if (this.layoutGeneration === gen) {
      void this.applyLayoutNow(this.storedLayout, this.storedMainPaneSize);
    }
  }, CMUX_LAYOUT_DEBOUNCE_MS);
  this.layoutTimer.unref?.();
}

private async applyLayoutNow(
  _layout: MultiplexerLayout,
  _mainPaneSize: number,
): Promise<void> {
  // Will be implemented in Task 5
}
```

And add the standalone helper at the bottom of the file (after the class):

```typescript
function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx bun test tests/cmux.test.ts`
Expected: ALL tests PASS (4 detection + 4 spawnPane = 8)

- [ ] **Step 5: Commit**

```bash
git add src/multiplexer/cmux/index.ts tests/cmux.test.ts
git commit -m "feat(cmux): implement spawnPane with --json new-pane"
```

---

### Task 4: Implement closePane

**Files:**
- Modify: `src/multiplexer/cmux/index.ts` — replace closePane stub
- Modify: `tests/cmux.test.ts` — add closePane tests

- [ ] **Step 1: Add closePane tests**

Append to `tests/cmux.test.ts`:

```typescript
describe('CmuxMultiplexer — closePane', () => {
  beforeEach(() => {
    logMock.mockClear();
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/local/bin/cmux\n');
      if (command[1] === 'send')
        return createSpawnResult(0, '', '');
      if (command[1] === 'close-surface')
        return createSpawnResult(0, '', '');
      return createSpawnResult();
    });
  });

  test('closePane sends Ctrl+C then closes surface after delay', async () => {
    const { CmuxMultiplexer } = require('../src/multiplexer/cmux/index');
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    // trigger isAvailable
    await cmux.isAvailable();

    crossSpawnMock.mockClear(); // clear which calls

    const result = await cmux.closePane('surface:5');

    expect(result).toBe(true);

    const allCalls = commands();

    // First call: send Ctrl+C
    const sendCalls = allCalls.filter((c) => c[1] === 'send');
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toContain('--surface');
    expect(sendCalls[0]).toContain('surface:5');

    // Extract the text argument to verify it contains Ctrl+C
    const sendArgs = sendCalls[0];
    const textArg = sendArgs[sendArgs.length - 1];
    expect(textArg).toContain('\\x03');

    // Second call: close-surface
    const closeCalls = allCalls.filter((c) => c[1] === 'close-surface');
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0]).toContain('--surface');
    expect(closeCalls[0]).toContain('surface:5');
  });

  test('closePane returns false when paneId is empty', async () => {
    const { CmuxMultiplexer } = require('../src/multiplexer/cmux/index');
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    const result = await cmux.closePane('');

    expect(result).toBe(false);
    expect(logMock).toHaveBeenCalledWith(
      '[cmux] closePane: no paneId provided',
    );
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

    const { CmuxMultiplexer } = require('../src/multiplexer/cmux/index');
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    const result = await cmux.closePane('surface:99');

    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx bun test tests/cmux.test.ts`
Expected: closePane tests FAIL (stub returns `false`)

- [ ] **Step 3: Implement closePane**

Replace the `closePane` stub in `src/multiplexer/cmux/index.ts`:

```typescript
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
    // Step 1: Send Ctrl+C for graceful shutdown
    log('[cmux] closePane: sending Ctrl+C', { paneId });
    const ctrlCProc = crossSpawn(
      [cmuxBin, 'send', '--surface', paneId, "$(printf '\\x03')"],
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
      // Schedule layout rebalance
      this.scheduleLayout();
      return true;
    }

    log('[cmux] closePane: failed (surface may already be closed)', { paneId });
    return false;
  } catch (err) {
    log('[cmux] closePane: exception', { error: String(err) });
    return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx bun test tests/cmux.test.ts`
Expected: ALL tests PASS (8 previous + 3 closePane = 11)

- [ ] **Step 5: Commit**

```bash
git add src/multiplexer/cmux/index.ts tests/cmux.test.ts
git commit -m "feat(cmux): implement closePane with graceful Ctrl+C shutdown"
```

---

### Task 5: Implement applyLayout

**Files:**
- Modify: `src/multiplexer/cmux/index.ts` — replace applyLayout stub + applyLayoutNow
- Modify: `tests/cmux.test.ts` — add layout tests

**Layout strategy for cmux:**

cmux has no `select-layout` equivalent. Use `new-split` to approximate layout behavior:

| Layout | cmux commands |
|--------|--------------|
| `main-vertical` | `new-split right` |
| `main-horizontal` | `new-split down` |
| `tiled` | `new-split right` → `new-split down` |
| `even-horizontal` | `new-split down` |
| `even-vertical` | `new-split right` |

- [ ] **Step 1: Add layout tests**

Append to `tests/cmux.test.ts`:

```typescript
describe('CmuxMultiplexer — layout', () => {
  beforeEach(() => {
    logMock.mockClear();
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/local/bin/cmux\n');
      return createSpawnResult(0, '', '');
    });
  });

  test('applyLayout main-vertical sends new-split right', async () => {
    const { CmuxMultiplexer } = require('../src/multiplexer/cmux/index');
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    await cmux.applyLayout('main-vertical', 60);

    const splitCalls = commands().filter((c) => c[1] === 'new-split');
    expect(splitCalls).toHaveLength(1);
    expect(splitCalls[0]).toContain('right');
  });

  test('applyLayout main-horizontal sends new-split down', async () => {
    const { CmuxMultiplexer } = require('../src/multiplexer/cmux/index');
    const cmux = new CmuxMultiplexer('main-horizontal', 60);

    await cmux.applyLayout('main-horizontal', 60);

    const splitCalls = commands().filter((c) => c[1] === 'new-split');
    expect(splitCalls).toHaveLength(1);
    expect(splitCalls[0]).toContain('down');
  });

  test('applyLayout tiled sends new-split right then down', async () => {
    const { CmuxMultiplexer } = require('../src/multiplexer/cmux/index');
    const cmux = new CmuxMultiplexer('tiled', 60);

    await cmux.applyLayout('tiled', 60);

    const splitCalls = commands().filter((c) => c[1] === 'new-split');
    expect(splitCalls).toHaveLength(2);
    expect(splitCalls[0]).toContain('right');
    expect(splitCalls[1]).toContain('down');
  });

  test('applyLayout even-horizontal sends new-split down', async () => {
    const { CmuxMultiplexer } = require('../src/multiplexer/cmux/index');
    const cmux = new CmuxMultiplexer('even-horizontal', 60);

    await cmux.applyLayout('even-horizontal', 60);

    const splitCalls = commands().filter((c) => c[1] === 'new-split');
    expect(splitCalls).toHaveLength(1);
    expect(splitCalls[0]).toContain('down');
  });

  test('applyLayout even-vertical sends new-split right', async () => {
    const { CmuxMultiplexer } = require('../src/multiplexer/cmux/index');
    const cmux = new CmuxMultiplexer('even-vertical', 60);

    await cmux.applyLayout('even-vertical', 60);

    const splitCalls = commands().filter((c) => c[1] === 'new-split');
    expect(splitCalls).toHaveLength(1);
    expect(splitCalls[0]).toContain('right');
  });

  test('layout commands use binary path from detection', async () => {
    const { CmuxMultiplexer } = require('../src/multiplexer/cmux/index');
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    // Trigger binary detection
    await cmux.isAvailable();

    crossSpawnMock.mockClear(); // clear which calls

    await cmux.applyLayout('main-vertical', 60);

    const splitCalls = commands().filter((c) => c[1] === 'new-split');
    expect(splitCalls).toHaveLength(1);
    // The binary path should be used, not just 'cmux'
    expect(splitCalls[0][0]).toBe('/usr/local/bin/cmux');
  });

  test('direct applyLayout cancels a pending debounced layout', async () => {
    const { CmuxMultiplexer } = require('../src/multiplexer/cmux/index');
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    // Trigger a debounced layout via spawnPane
    process.env.CMUX_WORKSPACE_ID = 'workspace-1';
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/local/bin/cmux\n');
      if (command[1] === 'new-pane')
        return createSpawnResult(
          0,
          JSON.stringify({ surface_ref: 'surface:5' }),
        );
      return createSpawnResult(0, '', '');
    });

    await cmux.spawnPane(
      'session-1',
      'First worker',
      'http://localhost:4096',
      '/repo',
    );

    // Immediately call applyLayout directly — should override debounced
    await cmux.applyLayout('tiled', 60);

    // Clear and wait long enough for debounce to have fired
    crossSpawnMock.mockClear();

    await new Promise((resolve) => setTimeout(resolve, 300));

    // No additional layout commands should have been issued
    const postWaitCalls = commands().filter((c) => c[1] === 'new-split');
    expect(postWaitCalls).toHaveLength(0);
  });

  test('debounce coalesces burst pane spawns into one layout application', async () => {
    const { CmuxMultiplexer } = require('../src/multiplexer/cmux/index');
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    process.env.CMUX_WORKSPACE_ID = 'workspace-1';
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/local/bin/cmux\n');
      if (command[1] === 'new-pane')
        return createSpawnResult(
          0,
          JSON.stringify({ surface_ref: 'surface:5' }),
        );
      return createSpawnResult(0, '', '');
    });

    await cmux.spawnPane(
      'session-1',
      'First worker',
      'http://localhost:4096',
      '/repo',
    );
    await cmux.spawnPane(
      'session-2',
      'Second worker',
      'http://localhost:4096',
      '/repo',
    );

    // Layout should NOT have been applied yet (debounced)
    const immediateSplitCalls = commands().filter((c) => c[1] === 'new-split');
    expect(immediateSplitCalls).toHaveLength(0);

    // Wait for debounce
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Now layout should have been applied exactly once
    const deferredSplitCalls = commands().filter((c) => c[1] === 'new-split');
    expect(deferredSplitCalls).toHaveLength(1);
    expect(deferredSplitCalls[0]).toContain('right');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx bun test tests/cmux.test.ts`
Expected: layout tests FAIL (applyLayout is a no-op stub)

- [ ] **Step 3: Implement applyLayout and applyLayoutNow**

Replace `applyLayout` stub and `applyLayoutNow` placeholder in `src/multiplexer/cmux/index.ts`:

```typescript
async applyLayout(
  layout: MultiplexerLayout,
  mainPaneSize: number,
): Promise<void> {
  // Cancel any pending debounced layout
  if (this.layoutTimer) {
    clearTimeout(this.layoutTimer);
    this.layoutTimer = undefined;
  }

  // Increment generation so pending timer becomes stale
  this.layoutGeneration++;
  await this.applyLayoutNow(layout, mainPaneSize);
}

private async applyLayoutNow(
  layout: MultiplexerLayout,
  mainPaneSize: number,
): Promise<void> {
  const cmuxBin = await this.getBinary();
  if (!cmuxBin) return;

  // Store for later use
  this.storedLayout = layout;
  this.storedMainPaneSize = mainPaneSize;

  try {
    const splitDirections = layoutToCmuxSplits(layout);

    for (const direction of splitDirections) {
      const proc = crossSpawn(
        [cmuxBin, 'new-split', direction],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stderr = await proc.stderr();
        log('[cmux] applyLayout: new-split failed', {
          direction,
          exitCode,
          stderr: stderr.trim(),
        });
        return; // stop on first failure
      }
    }

    log('[cmux] applyLayout: applied', { layout, mainPaneSize });
  } catch (err) {
    log('[cmux] applyLayout: exception', { error: String(err) });
  }
}
```

Also add the `layoutToCmuxSplits` helper function at the bottom of the file:

```typescript
/**
 * Map MultiplexerLayout to a sequence of cmux new-split directions.
 *
 * cmux has no select-layout equivalent; we approximate layouts
 * through sequential new-split commands within the current pane.
 */
function layoutToCmuxSplits(layout: MultiplexerLayout): string[] {
  switch (layout) {
    case 'main-vertical':
      return ['right'];
    case 'main-horizontal':
      return ['down'];
    case 'tiled':
      return ['right', 'down'];
    case 'even-horizontal':
      return ['down'];
    case 'even-vertical':
      return ['right'];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx bun test tests/cmux.test.ts`
Expected: ALL tests PASS (11 previous + 8 layout = 19)

- [ ] **Step 5: Commit**

```bash
git add src/multiplexer/cmux/index.ts tests/cmux.test.ts
git commit -m "feat(cmux): implement applyLayout with new-split commands"
```

---

### Task 6: Wire up factory and auto-detection

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

    const mux = getMultiplexer({
      type: 'none',
    });

    expect(mux).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx bun test tests/factory.test.ts`
Expected: cmux factory tests FAIL (factory doesn't handle 'cmux')

- [ ] **Step 3: Add cmux to factory**

In `src/multiplexer/factory.ts`:

**Add import:**
```typescript
import { CmuxMultiplexer } from './cmux';
```

**Add cmux case in switch (before zellij):**
```typescript
case 'cmux':
  multiplexer = new CmuxMultiplexer(config.layout, config.main_pane_size);
  actualType = 'cmux';
  break;
```

**Update auto detection (add cmux check BEFORE tmux):**
```typescript
case 'auto': {
  if (process.env.CMUX_WORKSPACE_ID) {
    multiplexer = new CmuxMultiplexer(config.layout, config.main_pane_size);
    actualType = 'cmux';
  } else if (process.env.TMUX) {
    multiplexer = new TmuxMultiplexer(config.layout, config.main_pane_size);
    actualType = 'tmux';
  } else if (process.env.ZELLIJ) {
    multiplexer = new ZellijMultiplexer(config.layout, config.main_pane_size);
    actualType = 'zellij';
  } else {
    log('[multiplexer] auto: not inside any session, disabling');
    return null;
  }
  break;
}
```

**Update `getAutoMultiplexerType`:**
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

Run: `npx bun test tests/factory.test.ts tests/cmux.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/multiplexer/factory.ts tests/factory.test.ts
git commit -m "feat(factory): wire cmux into multiplexer factory with auto-detection"
```

---

### Task 7: Run full test suite and final verification

**Files:** None (verification only)

- [ ] **Step 1: Run all project tests**

Run: `npx bun test`
Expected: ALL tests PASS (tmux, zellij, factory, session-manager, cmux)

- [ ] **Step 2: Run TypeScript type checking**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run linter**

Run: `npx biome check src/`
Expected: No errors (format+lint pass)

- [ ] **Step 4: Review final file structure**

Expected files created/modified:
- `src/multiplexer/cmux/index.ts` — new (implementation)
- `src/multiplexer/types.ts` — modified (line 20)
- `src/config/schema.ts` — modified (line 4)
- `src/multiplexer/factory.ts` — modified (import + cases)
- `src/multiplexer/index.ts` — modified (export)
- `tests/cmux.test.ts` — new (tests)
- `tests/factory.test.ts` — modified (cmux tests)

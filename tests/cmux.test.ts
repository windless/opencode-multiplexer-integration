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

mock.module('../src/utils/logger', () => ({ log: logMock }));
mock.module('../src/utils/compat', () => ({ crossSpawn: crossSpawnMock }));

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

// ─── detection ──────────────────────────────────

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

  test('isInsideSession returns false when not set', async () => {
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
    expect(await cmux.isAvailable()).toBe(true);
  });

  test('isAvailable returns false when CLI not found', async () => {
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation(() => createSpawnResult(1));
    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);
    expect(await cmux.isAvailable()).toBe(false);
  });
});

// ─── spawnPane ──────────────────────────────────

describe('CmuxMultiplexer — spawnPane', () => {
  let surfaceCounter = 5;

  beforeEach(() => {
    process.env.CMUX_WORKSPACE_ID = 'workspace-1';
    process.env.CMUX_SURFACE_ID = 'surface-1';
    surfaceCounter = 5;

    logMock.mockClear();
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/local/bin/cmux\n');
      if (command[1] === 'new-pane') {
        const ref = `surface:${surfaceCounter++}`;
        return createSpawnResult(
          0,
          JSON.stringify({
            surface_ref: ref,
            pane_ref: 'pane:3',
            workspace_ref: 'workspace:1',
          }),
        );
      }
      return createSpawnResult();
    });
  });

  test('1st agent: splits from main pane with right direction', async () => {
    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);
    await cmux.isAvailable();

    const result = await cmux.spawnPane(
      'session-1',
      'agent-1',
      'http://localhost:4096',
      '/repo',
    );

    expect(result.success).toBe(true);
    expect(result.paneId).toBe('surface:5');

    const newPaneArgs = commands().find((c) => c[1] === 'new-pane')!;
    expect(newPaneArgs).toContain('--direction');
    expect(newPaneArgs).toContain('right');
    expect(newPaneArgs).not.toContain('--surface'); // 1st agent: no --surface
  });

  test('2nd agent: focuses previous pane then splits (no --surface)', async () => {
    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);
    await cmux.isAvailable();

    // 1st agent (warm up cascade)
    await cmux.spawnPane(
      'session-1',
      'agent-1',
      'http://localhost:4096',
      '/repo',
    );

    crossSpawnMock.mockClear(); // clear to see only 2nd agent's calls

    // 2nd agent
    const result = await cmux.spawnPane(
      'session-2',
      'agent-2',
      'http://localhost:4096',
      '/repo',
    );

    expect(result.success).toBe(true);
    expect(result.paneId).toBe('surface:6');

    // 2nd agent should focus the previous agent's pane first
    const focusArgs = commands().find((c) => c[1] === 'focus-pane')!;
    expect(focusArgs).toBeDefined();
    expect(focusArgs).toContain('--pane');
    expect(focusArgs).toContain('pane:3'); // previous agent's pane_ref

    // Then new-pane splits within that pane (no --surface)
    const newPaneArgs = commands().find((c) => c[1] === 'new-pane')!;
    expect(newPaneArgs).toContain('--direction');
    expect(newPaneArgs).toContain('down'); // main-vertical nested = down
    expect(newPaneArgs).not.toContain('--surface');
  });

  test('main-horizontal: 1st down, 2nd nested right', async () => {
    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-horizontal', 60);
    await cmux.isAvailable();

    // 1st agent
    await cmux.spawnPane(
      'session-1',
      'agent-1',
      'http://localhost:4096',
      '/repo',
    );

    let paneArgs = commands().find((c) => c[1] === 'new-pane')!;
    expect(paneArgs).toContain('down'); // first direction
    expect(paneArgs).not.toContain('--surface');

    crossSpawnMock.mockClear();

    // 2nd agent
    await cmux.spawnPane(
      'session-2',
      'agent-2',
      'http://localhost:4096',
      '/repo',
    );

    // 2nd agent focuses previous pane first
    const focusArgs = commands().find((c) => c[1] === 'focus-pane')!;
    expect(focusArgs).toBeDefined();

    paneArgs = commands().find((c) => c[1] === 'new-pane')!;
    expect(paneArgs).toContain('right'); // nested direction
    expect(paneArgs).not.toContain('--surface');
  });

  test('closePane clears lastAgent so next spawn is first agent again', async () => {
    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);
    await cmux.isAvailable();

    await cmux.spawnPane(
      'session-1',
      'agent-1',
      'http://localhost:4096',
      '/repo',
    );
    await cmux.closePane('surface:5'); // close the last agent

    crossSpawnMock.mockClear();

    // Next spawn should be 1st agent again (no --surface)
    await cmux.spawnPane(
      'session-2',
      'agent-2',
      'http://localhost:4096',
      '/repo',
    );

    const newPaneArgs = commands().find((c) => c[1] === 'new-pane')!;
    expect(newPaneArgs).not.toContain('--surface');
  });

  test('returns failure when binary not available', async () => {
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation(() => createSpawnResult(1));
    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);
    const result = await cmux.spawnPane('s', 'a', 'http://x', '/');
    expect(result.success).toBe(false);
  });

  test('returns failure when new-pane exits non-zero', async () => {
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/local/bin/cmux\n');
      if (command[1] === 'new-pane')
        return createSpawnResult(1, '', 'creation failed');
      return createSpawnResult();
    });
    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);
    const result = await cmux.spawnPane('s', 'a', 'http://x', '/');
    expect(result.success).toBe(false);
  });

  test('handles missing surface_ref in JSON', async () => {
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/local/bin/cmux\n');
      if (command[1] === 'new-pane')
        return createSpawnResult(0, JSON.stringify({ pane_ref: 'pane:3' }));
      return createSpawnResult();
    });
    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);
    const result = await cmux.spawnPane('s', 'a', 'http://x', '/');
    expect(result.success).toBe(false);
  });
});

// ─── closePane ──────────────────────────────────

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

  test('sends Ctrl+C then close-surface', async () => {
    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);
    await cmux.isAvailable();
    crossSpawnMock.mockClear();

    const result = await cmux.closePane('surface:5');
    expect(result).toBe(true);

    const allCalls = commands();

    const sendCalls = allCalls.filter((c) => c[1] === 'send');
    expect(sendCalls).toHaveLength(1);
    const sendArgs = sendCalls[0];
    expect(sendArgs).toContain('--surface');
    expect(sendArgs).toContain('surface:5');
    // Should send raw ETX byte \u0003 (Ctrl+C)
    expect(sendArgs[sendArgs.length - 1]).toBe('\u0003');

    const closeCalls = allCalls.filter((c) => c[1] === 'close-surface');
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0]).toContain('--surface');
    expect(closeCalls[0]).toContain('surface:5');
  });

  test('returns false for empty paneId', async () => {
    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);
    expect(await cmux.closePane('')).toBe(false);
  });

  test('returns false when close-surface fails', async () => {
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/local/bin/cmux\n');
      if (command[1] === 'send') return createSpawnResult(0, '', '');
      if (command[1] === 'close-surface')
        return createSpawnResult(1, '', 'no such surface');
      return createSpawnResult();
    });
    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);
    expect(await cmux.closePane('surface:99')).toBe(false);
  });
});

// ─── applyLayout (no-op) ────────────────────────

describe('CmuxMultiplexer — applyLayout', () => {
  beforeEach(() => {
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation(() => createSpawnResult());
  });

  test('is a no-op (no cmux commands spawned)', async () => {
    const { CmuxMultiplexer } = await importFreshCmux();
    const cmux = new CmuxMultiplexer('main-vertical', 60);

    await cmux.applyLayout('main-vertical', 60);
    await cmux.applyLayout('tiled', 60);

    const layoutCmds = commands().filter(
      (c) => c.includes('new-split') || c.includes('new-pane'),
    );
    expect(layoutCmds).toHaveLength(0);
  });

  test('constructor accepts layout and mainPaneSize without error', async () => {
    const { CmuxMultiplexer } = await importFreshCmux();
    expect(() => new CmuxMultiplexer('main-vertical', 60)).not.toThrow();
    expect(() => new CmuxMultiplexer('tiled', 50)).not.toThrow();
    expect(() => new CmuxMultiplexer()).not.toThrow();
  });
});

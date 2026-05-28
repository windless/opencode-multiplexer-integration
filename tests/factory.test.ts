import { afterEach, describe, expect, test } from 'bun:test';

async function importFreshFactory(suffix: string) {
  return import(
    `../src/multiplexer/factory?test=${suffix}-${Date.now()}-${Math.random()}`
  );
}

describe('multiplexer factory', () => {
  const originalTmux = process.env.TMUX;
  const originalTmuxPane = process.env.TMUX_PANE;

  afterEach(() => {
    process.env.TMUX = originalTmux;
    process.env.TMUX_PANE = originalTmuxPane;
  });

  test('returns a fresh tmux instance per call', async () => {
    process.env.TMUX = '/tmp/tmux-1000/default,123,0';
    process.env.TMUX_PANE = '%1';

    const { getMultiplexer } = await importFreshFactory('tmux-first');

    const first = getMultiplexer({
      type: 'tmux',
      layout: 'main-vertical',
      main_pane_size: 60,
    });

    process.env.TMUX_PANE = '%2';

    const { getMultiplexer: getMultiplexerAgain } =
      await importFreshFactory('tmux-second');

    const second = getMultiplexerAgain({
      type: 'tmux',
      layout: 'main-vertical',
      main_pane_size: 60,
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(Object.is(first, second)).toBe(false);
  });

  test('returns a fresh auto-detected tmux instance per call', async () => {
    process.env.TMUX = '/tmp/tmux-1000/default,123,0';
    process.env.TMUX_PANE = '%1';

    const { getMultiplexer } = await importFreshFactory('auto-first');

    const first = getMultiplexer({
      type: 'auto',
      layout: 'main-vertical',
      main_pane_size: 60,
    });

    process.env.TMUX_PANE = '%2';

    const { getMultiplexer: getMultiplexerAgain } =
      await importFreshFactory('auto-second');

    const second = getMultiplexerAgain({
      type: 'auto',
      layout: 'main-vertical',
      main_pane_size: 60,
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(Object.is(first, second)).toBe(false);
  });
});

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
    expect(mux?.type).toBe('cmux');
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
    expect(mux?.type).toBe('cmux');
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
    expect(mux?.type).toBe('cmux');
  });
});

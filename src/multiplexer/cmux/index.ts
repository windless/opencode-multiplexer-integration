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
    _description: string,
    serverUrl: string,
    directory: string,
  ): Promise<PaneResult> {
    const cmuxBin = await this.getBinary();
    if (!cmuxBin) {
      log('[cmux] spawnPane: cmux binary not found');
      return { success: false };
    }

    try {
      // Step 1: Create a new pane (empty, no initial command)
      const createArgs = ['new-pane', '--direction', 'right', '--json'];

      log('[cmux] spawnPane: creating pane', { cmuxBin, createArgs });

      const createProc = crossSpawn([cmuxBin, ...createArgs], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const createExitCode = await createProc.exited;
      const createStdout = await createProc.stdout();
      const createStderr = await createProc.stderr();

      log('[cmux] spawnPane: create result', {
        exitCode: createExitCode,
        stderr: createStderr.trim(),
      });

      if (createExitCode !== 0) {
        return { success: false };
      }

      // Parse surface_ref from JSON output
      let surfaceRef: string | undefined;
      try {
        const output = JSON.parse(createStdout) as {
          surface_ref?: string;
          pane_ref?: string;
        };
        surfaceRef = output.surface_ref;
        if (!surfaceRef) {
          log('[cmux] spawnPane: no surface_ref in output', { output });
          return { success: false };
        }
      } catch (parseErr) {
        log('[cmux] spawnPane: JSON parse failed', {
          stdout: createStdout,
          error: String(parseErr),
        });
        return { success: false };
      }

      // Step 2: Send the opencode attach command to the new surface
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

      // Brief wait for the terminal surface to be ready
      await new Promise((r) => setTimeout(r, 100));

      log('[cmux] spawnPane: sending command', {
        surfaceRef,
        cmd: opencodeCmd,
      });

      const sendProc = crossSpawn(
        [cmuxBin, 'send', '--surface', surfaceRef, `${opencodeCmd}\n`],
        { stdout: 'pipe', stderr: 'pipe' },
      );

      const sendExitCode = await sendProc.exited;
      const sendStderr = await sendProc.stderr();

      log('[cmux] spawnPane: send result', {
        exitCode: sendExitCode,
        stderr: sendStderr.trim(),
      });

      if (sendExitCode === 0) {
        log('[cmux] spawnPane: SUCCESS', { surfaceRef });
        return { success: true, paneId: surfaceRef };
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
      // Send Ctrl+C (ETX byte) — raw \u0003, same approach as ZellijMultiplexer
      log('[cmux] closePane: sending Ctrl+C', { paneId });
      const ctrlCProc = crossSpawn(
        [cmuxBin, 'send', '--surface', paneId, '\u0003'],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      await ctrlCProc.exited;

      await new Promise((r) => setTimeout(r, 250));

      log('[cmux] closePane: closing surface', { paneId });
      const proc = crossSpawn([cmuxBin, 'close-surface', '--surface', paneId], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;
      const stderr = await proc.stderr();

      log('[cmux] closePane: result', { exitCode, stderr: stderr.trim() });

      if (exitCode === 0) return true;

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
  }

  // ─── private helpers ────────────────────────

  private async findBinary(): Promise<string | null> {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
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
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

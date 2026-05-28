import type { Plugin } from '@opencode-ai/plugin';
import type { MultiplexerConfig } from './config';
import {
  getMultiplexer,
  MultiplexerSessionManager,
  startAvailabilityCheck,
} from './multiplexer';

const PLUGIN_NAME = 'opencode-multiplexer-integration';

const MultiplexerPlugin: Plugin = async (ctx, options) => {
  // Load multiplexer config from plugin options.
  // Users configure it via opencode.json using the tuple syntax:
  // {
  //   "plugin": [
  //     ["opencode-multiplexer-integration", {
  //       "multiplexer": {
  //         "type": "tmux",
  //         "layout": "main-vertical",
  //         "main_pane_size": 60
  //       }
  //     }]
  //   ]
  // }
  // Default to 'none' (disabled).

  const multiplexerConfig: MultiplexerConfig = {
    type: 'none',
    layout: 'main-vertical',
    main_pane_size: 60,
  };

  // Apply user-provided options from the plugin tuple syntax
  const userMultiplexerConfig = (options as Record<string, unknown>)
    ?.multiplexer as Record<string, unknown> | undefined;

  if (userMultiplexerConfig) {
    if (typeof userMultiplexerConfig.type === 'string') {
      multiplexerConfig.type =
        userMultiplexerConfig.type as MultiplexerConfig['type'];
    }
    if (typeof userMultiplexerConfig.layout === 'string') {
      multiplexerConfig.layout =
        userMultiplexerConfig.layout as MultiplexerConfig['layout'];
    }
    if (typeof userMultiplexerConfig.main_pane_size === 'number') {
      multiplexerConfig.main_pane_size = userMultiplexerConfig.main_pane_size;
    }
  }

  let multiplexerEnabled = false;

  try {
    // Check if we're inside a multiplexer session
    const multiplexer = getMultiplexer(multiplexerConfig);
    multiplexerEnabled =
      multiplexerConfig.type !== 'none' &&
      multiplexer !== null &&
      multiplexer.isInsideSession();

    if (multiplexerEnabled) {
      startAvailabilityCheck(multiplexerConfig);
    }
  } catch {
    // Ignore - multiplexer not available
  }

  // Initialize session manager
  const multiplexerSessionManager = new MultiplexerSessionManager(
    ctx,
    multiplexerConfig,
  );

  return {
    name: PLUGIN_NAME,

    // No custom agents, tools, or MCPs — this is a pure event-driven plugin

    config: async () => {
      // Config is loaded from plugin options at init time.
      // No additional config merging needed here since OpenCode passes
      // plugin-specific options via the tuple syntax in the plugin array,
      // which are received as the `options` parameter in the plugin factory.
    },

    event: async (input) => {
      const event = input.event as {
        type: string;
        properties?: {
          info?: {
            id?: string;
            parentID?: string;
            title?: string;
            directory?: string;
          };
          sessionID?: string;
          status?: { type: string };
        };
      };

      // Handle multiplexer pane spawning for OpenCode's Task tool sessions
      await multiplexerSessionManager.onSessionCreated(event);

      // Handle session status/idle events for pane cleanup
      await multiplexerSessionManager.onSessionStatus(event);

      // Handle session.deleted events for pane cleanup
      await multiplexerSessionManager.onSessionDeleted(event);
    },

    // Cleanup on plugin dispose
    dispose: async () => {
      await multiplexerSessionManager.cleanup();
    },
  };
};

export default MultiplexerPlugin;

import { z } from 'zod';

// Multiplexer type options
export const MultiplexerTypeSchema = z.enum(['auto', 'tmux', 'zellij', 'cmux', 'none']);
export type MultiplexerType = z.infer<typeof MultiplexerTypeSchema>;

// Layout options (shared across multiplexers)
export const MultiplexerLayoutSchema = z.enum([
  'main-horizontal', // Main pane on top, agents stacked below
  'main-vertical', // Main pane on left, agents stacked on right
  'tiled', // All panes equal size grid
  'even-horizontal', // All panes side by side
  'even-vertical', // All panes stacked vertically
]);

export type MultiplexerLayout = z.infer<typeof MultiplexerLayoutSchema>;

// Legacy Tmux layout options (for backward compatibility)
export const TmuxLayoutSchema = MultiplexerLayoutSchema;
export type TmuxLayout = MultiplexerLayout;

// Multiplexer integration configuration (new unified config)
export const MultiplexerConfigSchema = z.object({
  type: MultiplexerTypeSchema,
  layout: MultiplexerLayoutSchema.optional(),
  main_pane_size: z.number().min(20).max(80).optional(), // percentage for main pane
});

export type MultiplexerConfig = z.infer<typeof MultiplexerConfigSchema>;

// Legacy Tmux integration configuration (for backward compatibility)
// When tmux.enabled is true, it's equivalent to multiplexer.type = 'tmux'
export const TmuxConfigSchema = z.object({
  enabled: z.boolean().optional(),
  layout: TmuxLayoutSchema.optional(),
  main_pane_size: z.number().min(20).max(80).optional(), // percentage for main pane
});

export type TmuxConfig = z.infer<typeof TmuxConfigSchema>;

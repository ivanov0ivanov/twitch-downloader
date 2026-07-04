import pc from 'picocolors';

/**
 * Unified terminal logging.
 * Convention: [status icon] [short action] [key detail]
 *   …  in progress
 *   ✓  done
 *   ✖  failed
 *   ▲  warning
 *   ●  info
 * Icons must stay non-emoji glyphs (same family @clack/prompts uses): emoji-class
 * codepoints (⚠ U+26A0, ℹ U+2139, …) are given one terminal cell but render via
 * the two-cell Segoe UI Emoji fallback and collide with the following text.
 */
export const log = {
  /** An action has started. */
  step(text) {
    console.log(`${pc.cyan('…')} ${text}`);
  },
  /** An action finished successfully. */
  ok(text) {
    console.log(`${pc.green('✓')} ${text}`);
  },
  /** An action failed. */
  fail(text) {
    console.log(`${pc.red('✖')} ${text}`);
  },
  /** Something needs attention but is not fatal. */
  warn(text) {
    console.log(`${pc.yellow('▲')} ${text}`);
  },
  /** Neutral information. */
  info(text) {
    console.log(`${pc.blue('●')} ${text}`);
  },
  /** Plain indented detail line (used under a status line, e.g. stats rows). */
  detail(text) {
    console.log(`  ${pc.dim(text)}`);
  },
  blank() {
    console.log('');
  },
};

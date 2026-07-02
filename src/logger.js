import pc from 'picocolors';

/**
 * Unified terminal logging.
 * Convention: [status icon] [short action] [key detail]
 *   …  in progress
 *   ✓  done
 *   ✖  failed
 *   ⚠  warning
 *   ℹ  info
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
    console.log(`${pc.yellow('⚠')} ${text}`);
  },
  /** Neutral information. */
  info(text) {
    console.log(`${pc.blue('ℹ')} ${text}`);
  },
  /** Plain indented detail line (used under a status line, e.g. stats rows). */
  detail(text) {
    console.log(`  ${pc.dim(text)}`);
  },
  blank() {
    console.log('');
  },
};

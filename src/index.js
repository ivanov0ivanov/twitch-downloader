import { readFileSync } from 'node:fs';
import { printBanner } from './banner.js';
import { checkDependencies } from './checks.js';
import { runApp } from './menu.js';
import { log } from './logger.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Last-resort guards: a utility CLI should explain, not crash with a stack trace.
process.on('uncaughtException', (err) => {
  log.fail(`Unexpected error: ${err?.message ?? err}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.fail(`Unexpected error: ${reason?.message ?? reason}`);
  process.exit(1);
});

printBanner(pkg.version);

const deps = await checkDependencies();
if (!deps.ytDlp.found) log.info('yt-dlp is missing — pick "Install missing tools" in the menu');
if (!deps.ffmpeg.found) log.info('ffmpeg is missing — pick "Install missing tools" in the menu');

await runApp(deps);
// A piped/raw stdin can keep the event loop alive after the menu closes.
process.exit(0);

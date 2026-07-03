import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { printBanner } from './banner.js';
import { checkDependencies, getActiveCommandPids } from './checks.js';
import { hasActiveStage, requestInterrupt, getActiveStagePid } from './downloader.js';
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

// Single Ctrl+C dispatcher: during a download/remux stage it opens the
// confirm-stop flow (stage children are detached and never see the signal);
// when idle it just exits. Clack prompts run stdin in raw mode and consume
// Ctrl+C themselves, so this never fires while a prompt is open.
process.on('SIGINT', () => {
  if (hasActiveStage()) {
    requestInterrupt();
    return;
  }
  log.blank();
  process.exit(0);
});

// Detached stage children survive our death by design (they must outlive an
// unconfirmed Ctrl+C), and runCommand children live in hidden consoles that
// console Ctrl+C never reaches — reap them all synchronously when we die.
process.on('exit', () => {
  if (process.platform !== 'win32') return;
  const pids = [getActiveStagePid(), ...getActiveCommandPids()].filter(Boolean);
  for (const pid of pids) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  }
});

// Closing the terminal window (CTRL_CLOSE_EVENT) or Ctrl+Break kills the
// process WITHOUT emitting 'exit' unless handlers exist to turn them into
// signals — route both through exit() so the reaper above always runs
// (Windows grants ~5s after a console close, plenty for a sync taskkill).
for (const signal of ['SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => process.exit(0));
}

printBanner(pkg.version);

const deps = await checkDependencies();
if (!deps.ytDlp.found) log.info('yt-dlp is missing — pick "Install missing tools" in the menu');
if (!deps.ffmpeg.found) log.info('ffmpeg is missing — pick "Install missing tools" in the menu');

await runApp(deps);
// A piped/raw stdin can keep the event loop alive after the menu closes.
process.exit(0);

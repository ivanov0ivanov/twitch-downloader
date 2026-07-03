import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { log } from './logger.js';

/**
 * Kill a child and its whole process tree. yt-dlp.exe is a PyInstaller
 * onefile launcher whose real worker is a child process — plain kill()
 * terminates only the launcher and the download keeps running.
 * Resolves when taskkill has finished, i.e. the whole tree got the kill
 * (file handles may need another beat to be released by the OS).
 */
export function killTree(child) {
  return new Promise((resolve) => {
    if (process.platform === 'win32' && child.pid) {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => resolve());
    } else {
      child.kill('SIGKILL');
      resolve();
    }
  });
}

/**
 * Children spawned by runCommand run in hidden consoles (windowsHide), so a
 * console Ctrl+C never reaches them — index.js reaps these PIDs on exit.
 */
const activeCommands = new Set();

/** PIDs of in-flight runCommand children, for the synchronous exit reaper. */
export function getActiveCommandPids() {
  return [...activeCommands].map((c) => c.pid).filter(Boolean);
}

/**
 * Run a command, capture stdout/stderr, never throw.
 * @returns {Promise<{code: number, stdout: string, stderr: string, missing: boolean}>}
 */
export function runCommand(cmd, args, { onStdout, onStderr, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timer;
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err), missing: true });
      return;
    }
    activeCommands.add(child);
    if (timeoutMs) {
      timer = setTimeout(() => killTree(child), timeoutMs);
    }
    child.stdout.on('data', (d) => {
      stdout += d;
      onStdout?.(d);
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      onStderr?.(d);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      activeCommands.delete(child);
      resolve({ code: -1, stdout, stderr: String(err), missing: err.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      activeCommands.delete(child);
      resolve({ code: code ?? -1, stdout, stderr, missing: false });
    });
  });
}

/** Read a PATH value from the Windows registry (returns [] on any failure). */
async function readRegistryPath(rootKey) {
  const res = await runCommand('reg', ['query', rootKey, '/v', 'Path'], { timeoutMs: 10000 });
  if (res.code !== 0) return [];
  const match = res.stdout.match(/\bPath\s+REG(?:_EXPAND)?_SZ\s+(.+)/i);
  if (!match) return [];
  // Expand %VAR% placeholders in REG_EXPAND_SZ values.
  const expanded = match[1].trim().replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`);
  return expanded.split(';').filter(Boolean);
}

/**
 * Make freshly installed tools visible without restarting the terminal:
 * winget portable packages append their folders to the *registry* PATH,
 * which a running process does not see until it re-reads it.
 */
async function refreshProcessPath() {
  const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const known = new Set(current.map((p) => p.toLowerCase()));
  const candidates = [
    ...(await readRegistryPath('HKCU\\Environment')),
    ...(await readRegistryPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')),
  ];
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
  }
  for (const dir of candidates) {
    if (!known.has(dir.toLowerCase())) {
      current.push(dir);
      known.add(dir.toLowerCase());
    }
  }
  process.env.PATH = current.join(path.delimiter);
}

/** @returns {Promise<{found: boolean, version: string|null}>} */
async function checkYtDlp() {
  const res = await runCommand('yt-dlp', ['--version'], { timeoutMs: 15000 });
  if (res.code !== 0) return { found: false, version: null };
  return { found: true, version: res.stdout.trim().split(/\r?\n/)[0] || 'unknown' };
}

/** @returns {Promise<{found: boolean, version: string|null}>} */
export async function checkFfmpeg() {
  const res = await runCommand('ffmpeg', ['-version'], { timeoutMs: 15000 });
  if (res.code !== 0) return { found: false, version: null };
  const m = res.stdout.match(/ffmpeg version (\S+)/);
  return { found: true, version: m ? m[1] : 'unknown' };
}

/**
 * Check both external tools, logging per the unified convention.
 * @returns {Promise<{ytDlp: {found, version}, ffmpeg: {found, version}}>}
 */
export async function checkDependencies({ quiet = false } = {}) {
  await refreshProcessPath();
  if (!quiet) log.step('Checking yt-dlp');
  const ytDlp = await checkYtDlp();
  if (!quiet) {
    if (ytDlp.found) log.ok(`yt-dlp ${ytDlp.version} found`);
    else log.warn('yt-dlp not found');
  }
  if (!quiet) log.step('Checking ffmpeg');
  const ffmpeg = await checkFfmpeg();
  if (!quiet) {
    if (ffmpeg.found) log.ok(`ffmpeg ${ffmpeg.version} found`);
    else log.warn('ffmpeg not found');
  }
  return { ytDlp, ffmpeg };
}

async function wingetInstall(id, label) {
  log.step(`Installing ${label} via winget`);
  const res = await runCommand('winget', [
    'install', '--id', id, '-e',
    '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity',
  ]);
  // winget returns 0 on success and a specific code when already installed.
  if (res.code === 0 || /already installed/i.test(res.stdout)) {
    log.ok(`${label} installed via winget`);
    return true;
  }
  log.warn(`winget could not install ${label} (exit ${res.code})`);
  return false;
}

/** Install yt-dlp: winget first, pip as fallback. @returns {Promise<boolean>} found afterwards */
export async function installYtDlp() {
  let ok = await wingetInstall('yt-dlp.yt-dlp', 'yt-dlp');
  if (!ok) {
    log.step('Trying pip fallback: python -m pip install --user yt-dlp');
    const pip = await runCommand('python', ['-m', 'pip', 'install', '--user', 'yt-dlp']);
    if (pip.code === 0) {
      log.ok('yt-dlp installed via pip');
      ok = true;
    } else {
      log.fail('pip fallback failed — install yt-dlp manually: https://github.com/yt-dlp/yt-dlp');
    }
  }
  await refreshProcessPath();
  const check = await checkYtDlp();
  if (ok && !check.found) {
    log.warn('yt-dlp installed but not visible in this terminal yet — restart the terminal if downloads fail');
  }
  return check.found;
}

/** Install ffmpeg via winget. @returns {Promise<boolean>} found afterwards */
export async function installFfmpeg() {
  const ok = await wingetInstall('Gyan.FFmpeg', 'ffmpeg');
  await refreshProcessPath();
  const check = await checkFfmpeg();
  if (ok && !check.found) {
    log.warn('ffmpeg installed but not visible in this terminal yet — restart the terminal if remux fails');
  }
  return check.found;
}

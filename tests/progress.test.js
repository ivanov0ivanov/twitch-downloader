import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseYtdlpProgress,
  parseFfmpegStats,
  parseFfmpegDuration,
  classifyLine,
  formatFfmpegProgress,
  createProgressRenderer,
} from '../src/progress.js';

// Real lines captured from stress runs.
const YT_MID = '[download]  99.1% of ~  84.12MiB at    1.19MiB/s ETA 00:01 (frag 321/324)';
const YT_DONE = '[download] 100% of   84.51MiB in 00:01:08 at 1.23MiB/s';
const FF_VIDEO = 'frame=  913 fps=0.0 q=-1.0 Lsize=    2310KiB time=00:00:30.31 bitrate= 624.2kbits/s speed=1.9e+03x elapsed=0:00:00.01';
const FF_AUDIO = 'size=   52736KiB time=00:43:56.16 bitrate= 163.9kbits/s speed=4.98e+03x elapsed=0:00:00.52';
const WARN_DISCONT = '[aist#0:0/aac @ 00000202a95677c0] timestamp discontinuity (stream id=256): -4010666, new offset= 4010666';
const NOISE_OPEN = "[hls @ 0000021] Opening 'https://usher.ttvnw.net/vod/2277656159.m3u8?allow_source=true&sig=deadbeef' for reading";
const NOISE_EXTRACT = '[twitch:vod] 2277656159: Downloading stream metadata GraphQL';

test('parses yt-dlp progress lines', () => {
  const p = parseYtdlpProgress(YT_MID);
  assert.equal(p.percent, 99.1);
  assert.equal(p.size, '84.12MiB');
  assert.equal(p.speed, '1.19MiB/s');
  assert.equal(p.eta, '00:01');
});

test('yt-dlp final line without ETA still parses', () => {
  const p = parseYtdlpProgress(YT_DONE);
  assert.equal(p.percent, 100);
  assert.equal(p.size, '84.51MiB');
});

test('parses ffmpeg stats lines (video and audio-only shapes)', () => {
  const v = parseFfmpegStats(FF_VIDEO);
  assert.equal(v.time, '00:00:30');
  assert.equal(v.size, '2310KiB');
  assert.equal(v.speedX, 1900, 'scientific-notation speed multipliers must parse');
  const a = parseFfmpegStats(FF_AUDIO);
  assert.equal(a.time, '00:43:56');
  assert.equal(a.bitrate, '163.9kbits/s');
  assert.equal(a.speedX, 4980);
});

test('parses the ffmpeg input Duration header; live "N/A" stays unknown', () => {
  assert.equal(parseFfmpegDuration('  Duration: 01:42:38.57, start: 0.083000, bitrate: 8123 kb/s'), 6158);
  assert.equal(parseFfmpegDuration('Duration: N/A, start: 0.000000, bitrate: N/A'), null);
  assert.equal(parseFfmpegDuration('[download] Destination: file.ts'), null);
});

test('classifyLine: yt-dlp progress becomes compact progress text', () => {
  const yt = classifyLine(YT_MID);
  assert.equal(yt.kind, 'progress');
  assert.ok(yt.text.includes('99.1% of 84.12MiB'));
});

test('classifyLine: ffmpeg stats become structured progress data', () => {
  const ff = classifyLine(FF_VIDEO);
  assert.equal(ff.kind, 'progress');
  assert.equal(ff.ffmpeg.sizeBytes, 2310 * 1024);
  assert.equal(ff.ffmpeg.time, '00:00:30');
  assert.equal(ff.ffmpeg.timeSec, 30);
  assert.equal(ff.ffmpeg.speedX, 1900);
});

test('classifyLine: ffmpeg Duration header classifies as duration, N/A as noise', () => {
  const d = classifyLine('  Duration: 01:42:38.57, start: 0.083000, bitrate: 8123 kb/s');
  assert.equal(d.kind, 'duration');
  assert.equal(d.seconds, 6158);
  assert.equal(classifyLine('Duration: N/A, start: 0.000000, bitrate: N/A').kind, 'noise');
});

test('formatFfmpegProgress: record mode shows a REC timer, size and average speed', () => {
  const line = formatFfmpegProgress(
    { sizeBytes: 15466496, sizeLabel: '15104KiB', time: '00:21:14', timeSec: 1274, speedX: 1 },
    { mode: 'record', elapsedMs: 21000 },
  );
  // 15466496 B / 21 s = 719KiB/s; recording length replaces wall elapsed (they duplicate)
  assert.equal(line, 'REC 00:21:14 · 14.75MiB · 719KiB/s');
});

test('formatFfmpegProgress: record mode omits speed while the average is still noise', () => {
  const line = formatFfmpegProgress(
    { sizeBytes: 122880, sizeLabel: '120KiB', time: '00:00:01', timeSec: 1, speedX: 1 },
    { mode: 'record', elapsedMs: 800 },
  );
  assert.equal(line, 'REC 00:00:01 · 120KiB');
});

test('formatFfmpegProgress: remux with known duration mirrors the yt-dlp line (percent · speed · ETA · elapsed)', () => {
  const line = formatFfmpegProgress(
    { sizeBytes: 3221225472, sizeLabel: '3145728KiB', time: '00:51:19', timeSec: 3079, speedX: 80 },
    { mode: 'remux', durationSec: 6158, totalBytes: 8589934592, elapsedMs: 30000 },
  );
  // 3079/6158 = 50.0%; ETA = (6158-3079)/80 ≈ 38 s; speed = 3 GiB / 30 s
  assert.equal(line, '50.0% of ~8.00GiB · 102.40MiB/s · ETA 00:38 · 30s');
});

test('formatFfmpegProgress: remux percent works without a size estimate; hour-long ETAs get an hour digit', () => {
  const line = formatFfmpegProgress(
    { sizeBytes: null, sizeLabel: '10KiB', time: '00:00:10', timeSec: 10, speedX: 1 },
    { mode: 'remux', durationSec: 7210, totalBytes: null, elapsedMs: 5000 },
  );
  assert.equal(line, '0.1% · ETA 2:00:00 · 5s');
});

test('formatFfmpegProgress: remux without duration falls back to size · speed · elapsed', () => {
  const line = formatFfmpegProgress(
    { sizeBytes: 2147483648, sizeLabel: '2097152KiB', time: '00:10:00', timeSec: 600, speedX: null },
    { mode: 'remux', durationSec: null, totalBytes: 8589934592, elapsedMs: 10000 },
  );
  assert.equal(line, '2.00GiB · 204.80MiB/s · 10s');
});

test('classifyLine: warnings are short and URL-free', () => {
  const w = classifyLine(WARN_DISCONT);
  assert.equal(w.kind, 'warning');
  assert.ok(w.text.length <= 140);
  assert.ok(!w.text.includes('00000202a95677c0'), 'memory address prefix must be stripped');
  const corrupt = classifyLine('corrupt input packet in stream 1');
  assert.equal(corrupt.kind, 'warning');
  // requirement: long URLs must never reach the UI
  const withUrl = classifyLine(
    "corrupt input packet at https://usher.ttvnw.net/vod/2277656159.m3u8?sig=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&token=bbbbbbbbbbbbbbbbbbbb",
  );
  assert.equal(withUrl.kind, 'warning');
  assert.ok(withUrl.text.includes('<url>'));
  assert.ok(!withUrl.text.includes('https://'));
});

test('classifyLine: fatal ERROR lines are noise (surfaced once via error mapping, not as warnings)', () => {
  assert.equal(classifyLine('ERROR: Requested format is not available').kind, 'noise');
  assert.equal(classifyLine('ERROR: [twitch:vod] 123: Video 123 does not exist').kind, 'noise');
});

test('classifyLine: chatter with long URLs is noise', () => {
  assert.equal(classifyLine(NOISE_OPEN).kind, 'noise');
  assert.equal(classifyLine(NOISE_EXTRACT).kind, 'noise');
  assert.equal(classifyLine('').kind, 'noise');
  assert.equal(classifyLine('   ').kind, 'noise');
});

test('classifyLine: resume and already-downloaded notes surface as info', () => {
  const done = classifyLine('[download] D:\\dl\\file.ts has already been downloaded');
  assert.equal(done.kind, 'info');
  assert.ok(!done.text.includes('D:\\'), 'info text must not leak paths');
  const resume = classifyLine('[download] Resuming download at byte 98304123');
  assert.equal(resume.kind, 'info');
});

function fakeStream(tty) {
  return {
    isTTY: tty,
    chunks: [],
    write(s) {
      this.chunks.push(s);
    },
  };
}

test('renderer (TTY): update redraws in place, pause clears, resume redraws, finish leaves clean', () => {
  const s = fakeStream(true);
  const r = createProgressRenderer({ stream: s, prefix: '⬇' });
  r.update('42% of 1GiB');
  assert.ok(s.chunks.at(-1).startsWith('\r\x1b[K'));
  assert.ok(s.chunks.at(-1).includes('42% of 1GiB'));
  r.pause();
  assert.equal(s.chunks.at(-1), '\r\x1b[K', 'pause must clear the line for prompts');
  const before = s.chunks.length;
  r.update('50% of 1GiB'); // while paused — remembered, not drawn
  assert.equal(s.chunks.length, before);
  r.resume();
  assert.ok(s.chunks.at(-1).includes('50% of 1GiB'), 'resume redraws the latest progress');
  r.finish();
  assert.equal(s.chunks.at(-1), '\r\x1b[K');
});

test('renderer (non-TTY): throttles to at most one line per interval', () => {
  const s = fakeStream(false);
  const r = createProgressRenderer({ stream: s, prefix: '⬇' });
  r.update('1%');
  r.update('2%');
  r.update('3%');
  const progressLines = s.chunks.filter((c) => c.includes('%'));
  assert.equal(progressLines.length, 1, 'immediate consecutive updates must collapse to one line');
  assert.ok(progressLines[0].endsWith('\n'));
});

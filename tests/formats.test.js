import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFormatList, sortFormats, buildQualityOptions } from '../src/formats.js';

const VOD_OUTPUT = `[twitch:vod] Extracting URL: https://www.twitch.tv/videos/2158043818
[twitch:vod] 2158043818: Downloading stream metadata GraphQL
[twitch:vod] 2158043818: Downloading m3u8 information
[info] Available formats for v2158043818:
ID               EXT RESOLUTION FPS │   FILESIZE   TBR PROTO │ VCODEC        VBR ACODEC      ABR
─────────────────────────────────────────────────────────────────────────────────────────────────
sb1              mhtml 110x62     0 │                  mhtml │ images
sb0              mhtml 220x124    0 │                  mhtml │ images
Audio_Only       mp4 audio only     │ ~ 55.71MiB  128k m3u8  │ audio only        mp4a.40.2 128k
160p             mp4 284x160     30 │ ~101.42MiB  233k m3u8  │ avc1.4D400C  233k mp4a.40.2
360p             mp4 640x360     30 │ ~278.42MiB  640k m3u8  │ avc1.4D401E  640k mp4a.40.2
480p             mp4 852x480     30 │ ~582.77MiB 1340k m3u8  │ avc1.4D401F 1340k mp4a.40.2
720p60           mp4 1280x720    60 │ ~  1.42GiB 3348k m3u8  │ avc1.4D4020 3348k mp4a.40.2
1080p60__source_ mp4 1920x1080   60 │ ~  2.83GiB 6669k m3u8  │ avc1.64002A 6669k mp4a.40.2
`;

const LIVE_OUTPUT = `[twitch:stream] Extracting URL: https://www.twitch.tv/monstercat
[info] Available formats for 40000000000:
ID           EXT RESOLUTION FPS │ FILESIZE   TBR PROTO │ VCODEC     VBR ACODEC
──────────────────────────────────────────────────────────────────────────────
audio_only   mp4 audio only     │           128k m3u8  │ audio only     mp4a.40.2
160p         mp4 284x160     30 │           230k m3u8  │ avc1       230k mp4a.40.2
720p60       mp4 1280x720    60 │          3400k m3u8  │ avc1      3400k mp4a.40.2
1080p60      mp4 1920x1080   60 │          6600k m3u8  │ avc1      6600k mp4a.40.2
`;

test('parses a Twitch VOD format table and skips storyboard rows', () => {
  const formats = parseFormatList(VOD_OUTPUT);
  assert.equal(formats.length, 6);
  const ids = formats.map((f) => f.id);
  assert.ok(ids.includes('Audio_Only'));
  assert.ok(ids.includes('1080p60__source_'));
  assert.ok(!ids.includes('sb0'));
  assert.ok(!ids.includes('sb1'));
});

test('extracts approximate sizes in bytes', () => {
  const formats = parseFormatList(VOD_OUTPUT);
  const p720 = formats.find((f) => f.id === '720p60');
  assert.ok(Math.abs(p720.sizeBytes - 1.42 * 1024 ** 3) < 1024);
  const p160 = formats.find((f) => f.id === '160p');
  assert.ok(Math.abs(p160.sizeBytes - 101.42 * 1024 ** 2) < 1024);
});

test('detects source and audio-only rows, heights and fps', () => {
  const formats = parseFormatList(VOD_OUTPUT);
  const source = formats.find((f) => f.id === '1080p60__source_');
  assert.equal(source.isSource, true);
  assert.equal(source.height, 1080);
  assert.equal(source.fps, 60);
  const audio = formats.find((f) => f.id === 'Audio_Only');
  assert.equal(audio.isAudioOnly, true);
});

test('parses a live format table without filesizes', () => {
  const formats = parseFormatList(LIVE_OUTPUT);
  assert.equal(formats.length, 4);
  assert.ok(formats.every((f) => f.id !== ''));
  const p1080 = formats.find((f) => f.id === '1080p60');
  assert.equal(p1080.sizeBytes, null);
  assert.equal(p1080.height, 1080);
});

test('empty or garbage input yields no formats', () => {
  assert.deepEqual(parseFormatList(''), []);
  assert.deepEqual(parseFormatList('ERROR: something broke'), []);
  assert.deepEqual(parseFormatList(undefined), []);
});

test('sortFormats puts source first and audio-only last', () => {
  const sorted = sortFormats(parseFormatList(VOD_OUTPUT));
  assert.equal(sorted[0].id, '1080p60__source_');
  assert.equal(sorted.at(-1).id, 'Audio_Only');
  assert.equal(sorted[1].id, '720p60');
});

test('buildQualityOptions starts with Best (auto)', () => {
  const options = buildQualityOptions(parseFormatList(VOD_OUTPUT));
  assert.equal(options[0].label, 'Best (auto)');
  assert.equal(options[0].value, null);
  assert.equal(options.length, 7);
  assert.equal(options[1].value, '1080p60__source_');
});

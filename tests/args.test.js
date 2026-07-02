import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BEST_FORMAT,
  nativeExtFor,
  escapeOutputTemplate,
  buildMetaArgs,
  buildFormatListArgs,
  buildStage1Args,
  buildRemuxArgs,
  targetPathFor,
  planStages,
} from '../src/args.js';

const URL = 'https://www.twitch.tv/videos/123456789';

test('native container: ts for VODs/channels, mp4 for clips', () => {
  assert.equal(nativeExtFor('vod'), 'ts');
  assert.equal(nativeExtFor('channel'), 'ts');
  assert.equal(nativeExtFor('clip'), 'mp4');
});

test('percent signs are escaped for -o templates', () => {
  assert.equal(escapeOutputTemplate('D:\\100% legit\\file.ts'), 'D:\\100%% legit\\file.ts');
});

test('meta args print the fields and the computed filename', () => {
  const args = buildMetaArgs({ url: URL, downloadsDir: 'D:\\dl', nativeExt: 'ts' });
  assert.ok(args.includes('--windows-filenames'));
  assert.ok(args.includes('--trim-filenames'));
  const o = args[args.indexOf('-o') + 1];
  assert.equal(o, 'D:\\dl\\%(uploader)s - %(title)s - %(id)s.ts');
  assert.equal(args.at(-1), URL);
  assert.ok(args.includes('filename'));
});

test('format list args use -F', () => {
  assert.deepEqual(buildFormatListArgs(URL), ['-F', '--no-warnings', URL]);
});

test('stage 1 VOD args: native download, no fixup, resume-friendly', () => {
  const args = buildStage1Args({ url: URL, formatId: '720p60', outputPath: 'D:\\dl\\x.ts', isLive: false });
  assert.equal(args[args.indexOf('-f') + 1], '720p60');
  assert.equal(args[args.indexOf('--fixup') + 1], 'never');
  assert.ok(args.includes('--continue'));
  assert.ok(args.includes('-N'));
  assert.ok(!args.includes('--no-part'));
  assert.equal(args[args.indexOf('--retries') + 1], '10');
  assert.equal(args[args.indexOf('--fragment-retries') + 1], '10');
  assert.equal(args.at(-1), URL);
});

test('stage 1 uses Best (auto) selector when no format id chosen', () => {
  const args = buildStage1Args({ url: URL, formatId: null, outputPath: 'D:\\dl\\x.ts', isLive: false });
  assert.equal(args[args.indexOf('-f') + 1], BEST_FORMAT);
});

test('stage 1 live args write directly to the final file', () => {
  const args = buildStage1Args({ url: URL, formatId: null, outputPath: 'D:\\dl\\x.ts', isLive: true });
  assert.ok(args.includes('--no-part'));
  assert.ok(!args.includes('-N'));
  assert.ok(!args.includes('--continue'));
});

test('stage 1 escapes % in the output path', () => {
  const args = buildStage1Args({ url: URL, formatId: null, outputPath: 'D:\\dl\\50% off.ts', isLive: false });
  assert.equal(args[args.indexOf('-o') + 1], 'D:\\dl\\50%% off.ts');
});

test('remux args are a pure stream copy that drops data streams', () => {
  const args = buildRemuxArgs({ inputPath: 'a.ts', outputPath: 'a.mp4' });
  assert.equal(args[args.indexOf('-i') + 1], 'a.ts');
  assert.equal(args[args.indexOf('-c') + 1], 'copy');
  assert.ok(args.includes('-map'));
  // Twitch timed_id3 data stream must never reach the mp4 muxer
  assert.ok(args.includes('-dn'));
  // genpts must be an input option (before -i) to heal live-recording PTS gaps
  assert.ok(args.indexOf('-fflags') < args.indexOf('-i'));
  assert.equal(args[args.indexOf('-fflags') + 1], '+genpts');
  assert.equal(args.at(-1), 'a.mp4');
});

test('targetPathFor swaps only the extension', () => {
  assert.equal(targetPathFor('D:\\dl\\a b - c.ts', 'mp4'), 'D:\\dl\\a b - c.mp4');
  assert.equal(targetPathFor('D:\\dl.v2\\clip.mp4', 'mkv'), 'D:\\dl.v2\\clip.mkv');
});

test('planStages: quality × format × keep combinations', () => {
  // ts chosen on a ts-native VOD → single stage, nothing to delete
  assert.deepEqual(planStages({ chosenExt: 'ts', nativeExt: 'ts', keepNative: true }), {
    needsRemux: false,
    targetExt: 'ts',
    deleteNativeAfter: false,
  });
  // mp4 on VOD, delete intermediate after a successful remux
  assert.deepEqual(planStages({ chosenExt: 'mp4', nativeExt: 'ts', keepNative: false }), {
    needsRemux: true,
    targetExt: 'mp4',
    deleteNativeAfter: true,
  });
  // mkv on VOD, keep intermediate
  assert.deepEqual(planStages({ chosenExt: 'mkv', nativeExt: 'ts', keepNative: true }), {
    needsRemux: true,
    targetExt: 'mkv',
    deleteNativeAfter: false,
  });
  // mp4 on a clip (already native mp4) → single stage even with keep=false
  assert.deepEqual(planStages({ chosenExt: 'mp4', nativeExt: 'mp4', keepNative: false }), {
    needsRemux: false,
    targetExt: 'mp4',
    deleteNativeAfter: false,
  });
});

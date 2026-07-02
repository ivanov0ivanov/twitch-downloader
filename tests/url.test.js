import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl } from '../src/url.js';

test('VOD URL with query params is classified and canonicalized', () => {
  const r = classifyUrl('https://www.twitch.tv/videos/2158043818?t=1h2m30s&collection=x');
  assert.equal(r.type, 'vod');
  assert.equal(r.id, '2158043818');
  assert.equal(r.url, 'https://www.twitch.tv/videos/2158043818');
});

test('VOD URL without scheme and www', () => {
  const r = classifyUrl('twitch.tv/videos/123456789');
  assert.equal(r.type, 'vod');
  assert.equal(r.id, '123456789');
});

test('legacy /<chan>/video/<id> URL maps to vod', () => {
  const r = classifyUrl('https://www.twitch.tv/somechannel/video/987654321');
  assert.equal(r.type, 'vod');
  assert.equal(r.id, '987654321');
});

test('clips.twitch.tv slug is a clip', () => {
  const r = classifyUrl('https://clips.twitch.tv/AwkwardSlickCatKappa-x1Y2z3');
  assert.equal(r.type, 'clip');
  assert.equal(r.slug, 'AwkwardSlickCatKappa-x1Y2z3');
});

test('channel-page clip URL is a clip and canonicalizes to clips.twitch.tv', () => {
  const r = classifyUrl('https://www.twitch.tv/somechan/clip/FunnySlug-abc?featured=false');
  assert.equal(r.type, 'clip');
  assert.equal(r.url, 'https://clips.twitch.tv/FunnySlug-abc');
});

test('bare channel URL is a channel (lowercased)', () => {
  const r = classifyUrl('https://www.twitch.tv/MonsterCat');
  assert.equal(r.type, 'channel');
  assert.equal(r.login, 'monstercat');
  assert.equal(r.url, 'https://www.twitch.tv/monstercat');
});

test('m.twitch.tv channel URL is accepted', () => {
  assert.equal(classifyUrl('https://m.twitch.tv/lirik').type, 'channel');
});

test('youtube link is rejected as not-twitch', () => {
  assert.equal(classifyUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ').type, 'not-twitch');
});

test('empty and whitespace-only input', () => {
  assert.equal(classifyUrl('').type, 'empty');
  assert.equal(classifyUrl('   ').type, 'empty');
  assert.equal(classifyUrl(undefined).type, 'empty');
});

test('garbage and URLs with inner spaces are invalid', () => {
  assert.equal(classifyUrl('twitch tv videos').type, 'invalid');
  assert.equal(classifyUrl('https://www.twitch.tv/videos/123 456').type, 'invalid');
});

test('leading/trailing whitespace is tolerated', () => {
  assert.equal(classifyUrl('  https://www.twitch.tv/videos/123456789  ').type, 'vod');
});

test('non-downloadable twitch pages are unknown', () => {
  assert.equal(classifyUrl('https://www.twitch.tv/directory/category/just-chatting').type, 'unknown');
  assert.equal(classifyUrl('https://www.twitch.tv/videos/').type, 'unknown');
  assert.equal(classifyUrl('https://www.twitch.tv/videos/notanumber').type, 'unknown');
});

test('reserved path roots are not channels', () => {
  assert.equal(classifyUrl('https://www.twitch.tv/downloads').type, 'unknown');
  assert.equal(classifyUrl('https://www.twitch.tv/directory').type, 'unknown');
});

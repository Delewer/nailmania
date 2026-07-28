import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampLikeTerm,
  likeContainsPattern,
  SQLITE_LIKE_PATTERN_MAX_BYTES,
} from '../functions/_lib/search-pattern.js';

const byteLength = (value) => new TextEncoder().encode(value).byteLength;

test('ASCII and Cyrillic contains patterns fit SQLite LIKE_PATTERN_LENGTH', () => {
  const asciiTerm = clampLikeTerm('a'.repeat(100));
  const asciiPattern = likeContainsPattern('a'.repeat(100));
  assert.equal(asciiTerm.length, 48);
  assert.equal(byteLength(asciiPattern), SQLITE_LIKE_PATTERN_MAX_BYTES);

  const cyrillicTerm = clampLikeTerm('я'.repeat(100));
  const cyrillicPattern = likeContainsPattern('я'.repeat(100));
  assert.equal([...cyrillicTerm].length, 24);
  assert.equal(byteLength(cyrillicPattern), SQLITE_LIKE_PATTERN_MAX_BYTES);
});

test('escaped wildcard searches and astral symbols are clamped by encoded pattern bytes', () => {
  const escaped = likeContainsPattern('%_\\'.repeat(100), { escape: true });
  assert.ok(byteLength(escaped) <= SQLITE_LIKE_PATTERN_MAX_BYTES);
  assert.match(escaped, /^%\\%\\_\\\\/);

  const emoji = likeContainsPattern('💅'.repeat(100));
  assert.equal([...emoji.slice(1, -1)].length, 12);
  assert.equal(byteLength(emoji), SQLITE_LIKE_PATTERN_MAX_BYTES);
  assert.equal(emoji.includes('\uFFFD'), false);
});

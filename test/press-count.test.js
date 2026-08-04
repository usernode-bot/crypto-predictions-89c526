'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { normalizePressCount } = require('../press-count');

test('normalizePressCount defaults omitted counts to one', () => {
  assert.equal(normalizePressCount(undefined), 1);
});

test('normalizePressCount accepts only integer counts of one or two', () => {
  assert.equal(normalizePressCount(1), 1);
  assert.equal(normalizePressCount(2), 2);

  for (const value of [null, 0, 3, 1.5, '1', '2']) {
    assert.equal(normalizePressCount(value), null);
  }
});

test('the press controls use the shared request flow with their respective counts', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  assert.match(html, /id="press-btn"/);
  assert.match(html, /id="double-press-btn"/);
  assert.match(html, />\s*Double press\s*</);
  assert.match(html, /addEventListener\('click', \(\) => submitPress\(1\)\)/);
  assert.match(html, /addEventListener\('click', \(\) => submitPress\(2\)\)/);
});

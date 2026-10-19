import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slugify } from '../src/text.js'

test('slugify lowercases and trims dashes', () => {
  assert.equal(slugify('  Hello, World! '), 'hello-world')
  assert.equal(slugify('Already-Slugged'), 'already-slugged')
  assert.equal(slugify('--a--b--'), 'a-b')
})

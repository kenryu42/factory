import assert from 'node:assert/strict'
import { test } from 'node:test'
import { wordCount } from '../src/text.js'

test('wordCount splits on any whitespace run', () => {
  assert.equal(wordCount('one  two'), 2)
  assert.equal(wordCount(' one\ttwo\nthree '), 3)
  assert.equal(wordCount(''), 0)
  assert.equal(wordCount('   '), 0)
})

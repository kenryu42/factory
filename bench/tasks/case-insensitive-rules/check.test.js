import assert from 'node:assert/strict'
import { test } from 'node:test'
import { categorize } from '../src/categories.js'

test('rules match regardless of case and the first match wins', () => {
  const rules = [{ match: 'starbucks', category: 'coffee' }, { match: 'STAR', category: 'other' }]
  assert.equal(categorize('STARBUCKS #1234', rules), 'coffee')
  assert.equal(categorize('Starbucks', [{ match: 'STARBUCKS', category: 'coffee' }]), 'coffee')
  assert.equal(categorize('Shell', rules), 'uncategorized')
})

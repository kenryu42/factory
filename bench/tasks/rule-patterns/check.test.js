import assert from 'node:assert/strict'
import { test } from 'node:test'
import { categorize } from '../src/categories.js'
import { loadTransactions } from '../src/transactions.js'

test('pattern rules ignore case and respect inclusive amount limits', () => {
  const rules = [
    { pattern: '^amzn\\b', max: 20, category: 'small-shopping' },
    { pattern: '^AMZN', category: 'shopping' },
    { match: 'Rent', min: 1000, category: 'housing' },
    { match: 'Rent', category: 'other' },
  ]
  assert.equal(categorize('AMZN Mktp', rules, 20), 'small-shopping')
  assert.equal(categorize('amzn mktp', rules, 20.01), 'shopping')
  assert.equal(categorize('Rent March', rules, 1000), 'housing')
  assert.equal(categorize('Rent garage', rules, 120), 'other')
  assert.equal(categorize('Shell', rules, 5), 'uncategorized')
})

test('loadTransactions passes the amount to the rules', () => {
  const txns = loadTransactions('date,description,amount\n2026-03-01,Rent,1450.00\n2026-03-02,Rent,50.00\n', [{ match: 'Rent', min: 1000, category: 'housing' }])
  assert.deepEqual(txns.map((t) => t.category), ['housing', 'uncategorized'])
})

test('an invalid pattern throws an error naming it', () => {
  assert.throws(() => categorize('x', [{ pattern: '([unclosed', category: 'c' }], 1), /\(\[unclosed/)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatMoney } from '../src/money.js'

test('negative amounts put the sign before the dollar sign', () => {
  assert.equal(formatMoney(-12), '-$12.00')
  assert.equal(formatMoney(-0.5), '-$0.50')
  assert.equal(formatMoney(4.5), '$4.50')
})

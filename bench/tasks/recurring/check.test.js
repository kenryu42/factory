import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findRecurring } from '../src/recurring.js'

test('same description and amount in two or more months is recurring', () => {
  const t = (date, description, amount) => ({ date, description, amount, category: 'x' })
  assert.deepEqual(findRecurring([
    t('2026-04-09', 'Netflix', 15.49),
    t('2026-03-09', 'Netflix', 15.49),
    t('2026-03-20', 'Netflix', 15.49),
    t('2026-03-01', 'Rent', 1450),
    t('2026-04-01', 'Rent', 1450),
    t('2026-05-01', 'Rent', 1500),
    t('2026-03-02', 'Gym', 30),
    t('2026-03-12', 'Store', -12),
    t('2026-04-12', 'Store', -12),
  ]), [
    { description: 'Netflix', amount: 15.49, months: ['2026-03', '2026-04'] },
    { description: 'Rent', amount: 1450, months: ['2026-03', '2026-04'] },
  ])
})

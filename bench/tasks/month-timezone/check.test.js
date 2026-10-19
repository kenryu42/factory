import assert from 'node:assert/strict'
import { test } from 'node:test'

test('month keys come from the date string in any timezone', async () => {
  for (const tz of ['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
    process.env.TZ = tz
    const { summarizeByMonth } = await import('../src/summary.js?' + tz)
    const months = summarizeByMonth([
      { date: '2026-03-01', amount: 10, category: 'housing' },
      { date: '2026-03-31', amount: 5, category: 'food' },
    ])
    assert.deepEqual(Object.keys(months), ['2026-03'], tz)
  }
})

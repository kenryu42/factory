import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REDACTED, scrub } from '../src/scrub.ts'

const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'

test('removes a secret in plain, base64 and URL-encoded form', () => {
  const b64 = Buffer.from(key).toString('base64')
  const text = `env: ${key}\nencoded: ${b64}\nurl: ?k=${encodeURIComponent(key)}`
  const out = scrub(text, [key])
  assert.ok(!out.includes(key))
  assert.ok(!out.includes(b64))
  assert.equal(out.split(REDACTED).length - 1, 3)
})

test('leaves text without secrets unchanged', () => {
  const text = '{"type":"result","result":"Fixed add()"}'
  assert.equal(scrub(text, [key]), text)
})

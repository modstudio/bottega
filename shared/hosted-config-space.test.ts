import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHostedConfigIdentity, writeHostedConfigIdentity } from './hosted-config-space.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('hosted config bootstrap atomically persists the initialized user and space once', () => {
  const root = mkdtempSync(join(tmpdir(), 'hosted-space-'))
  roots.push(root)
  const env = { BOTTEGA_CONFIG_HOME: root }
  const identity = {
    spaceId: '01990000-0000-7000-8000-000000000001',
    userId: '01990000-0000-7000-8000-000000000002',
  }
  expect(readHostedConfigIdentity(env)).toBeNull()
  writeHostedConfigIdentity(identity, env)
  expect(readHostedConfigIdentity(env)).toEqual(identity)
  expect(statSync(join(root, 'hosted-config-space')).mode & 0o777).toBe(0o600)
  expect(() =>
    writeHostedConfigIdentity({ ...identity, userId: crypto.randomUUID() }, env),
  ).toThrow('EEXIST')
  expect(readHostedConfigIdentity(env)).toEqual(identity)

  chmodSync(join(root, 'hosted-config-space'), 0o644)
  expect(() => readHostedConfigIdentity(env)).toThrow('permissions are wider than 0600')
})

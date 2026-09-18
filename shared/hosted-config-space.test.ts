import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHostedConfigSpace, writeHostedConfigSpace } from './hosted-config-space.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('hosted config bootstrap persists the initialized space', () => {
  const root = mkdtempSync(join(tmpdir(), 'hosted-space-'))
  roots.push(root)
  const env = { BOTTEGA_CONFIG_HOME: root }
  expect(readHostedConfigSpace(env)).toBeNull()
  writeHostedConfigSpace('01990000-0000-7000-8000-000000000001', env)
  expect(readHostedConfigSpace(env)).toBe('01990000-0000-7000-8000-000000000001')
})

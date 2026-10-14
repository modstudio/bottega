import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { register } from './ratchet.ts'

function parse(args: string[]) {
  const program = new Command().exitOverride()
  register(program)
  return program.parseAsync(['node', 'orch', 'ratchet', '--format', 'phpcs', ...args])
}

test('ratchet refuses a command combined with report flags with reports-mode usage', async () => {
  await expect(
    parse(['--head-report', 'head.json', '--base-report', 'base.json', 'phpcs', '{files}']),
  ).rejects.toThrow(`usage: ${PLATFORM_SLUG} gate ratchet`)
})

test('ratchet refuses an incomplete report pair with reports-mode usage', async () => {
  await expect(parse(['--head-report', 'head.json'])).rejects.toThrow(
    `usage: ${PLATFORM_SLUG} gate ratchet`,
  )
})

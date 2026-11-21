import { expect, test } from 'bun:test'
import {
  type CheckoutCliFreshnessFacts,
  decideCliBinaryFreshness,
} from './checkout-cli-freshness.ts'

const HEAD_SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)

const current: CheckoutCliFreshnessFacts = {
  headSha: HEAD_SHA,
  stampContents: `head=${HEAD_SHA}\nsize=42\nmtime=100\ninode=7\n`,
  binaryStat: { size: 42, mtime: 100, inode: 7 },
  readError: false,
}

test('checkout CLI freshness accepts current host facts', () => {
  expect(decideCliBinaryFreshness(current)).toBe(true)
})

test.each([
  ['HEAD moved', { ...current, headSha: OTHER_SHA }],
  ['unresolved HEAD', { ...current, headSha: null }],
  ['missing stamp', { ...current, stampContents: null }],
  [
    'stat mismatch',
    { ...current, binaryStat: { ...current.binaryStat!, inode: current.binaryStat!.inode + 1 } },
  ],
  ['read error', { ...current, readError: true }],
] satisfies Array<[string, CheckoutCliFreshnessFacts]>)('%s is not current', (_name, facts) => {
  expect(decideCliBinaryFreshness(facts)).toBe(false)
})

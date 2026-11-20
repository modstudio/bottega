import { expect, test } from 'bun:test'
import {
  type CheckoutCliFreshnessFacts,
  decideCliBinaryFreshness,
} from './checkout-cli-freshness.ts'

const current: CheckoutCliFreshnessFacts = {
  headSha: 'abc123',
  refSha: 'abc123',
  stampContents: 'head=abc123\nsize=42\nmtime=100\ninode=7\n',
  binaryStat: { size: 42, mtime: 100, inode: 7 },
  readError: false,
}

test('checkout CLI freshness accepts current host facts', () => {
  expect(decideCliBinaryFreshness(current)).toBe(true)
})

test.each([
  ['HEAD moved', { ...current, headSha: 'def456', refSha: 'def456' }],
  ['detached HEAD', { ...current, refSha: null }],
  ['packed refs only', { ...current, headSha: null, refSha: null }],
  ['missing stamp', { ...current, stampContents: null }],
  [
    'stat mismatch',
    { ...current, binaryStat: { ...current.binaryStat!, inode: current.binaryStat!.inode + 1 } },
  ],
  ['read error', { ...current, readError: true }],
] satisfies Array<[string, CheckoutCliFreshnessFacts]>)('%s is not current', (_name, facts) => {
  expect(decideCliBinaryFreshness(facts)).toBe(false)
})

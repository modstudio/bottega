import { expect, test } from 'bun:test'
import {
  type CheckoutCliFreshnessFacts,
  decideCliBinaryFreshness,
} from './checkout-cli-freshness.ts'

const HEAD_SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const HEAD_REF = 'refs/heads/main'

const current: CheckoutCliFreshnessFacts = {
  headSha: null,
  refSha: HEAD_SHA,
  headRef: HEAD_REF,
  packedRefsContents: null,
  symbolicHead: true,
  stampContents: `head=${HEAD_SHA}\nsize=42\nmtime=100\ninode=7\n`,
  binaryStat: { size: 42, mtime: 100, inode: 7 },
  readError: false,
}

test('checkout CLI freshness accepts current host facts', () => {
  expect(decideCliBinaryFreshness(current)).toBe(true)
})

test('checkout CLI freshness accepts a matching detached HEAD', () => {
  expect(
    decideCliBinaryFreshness({
      ...current,
      symbolicHead: false,
      headSha: HEAD_SHA,
      refSha: null,
      headRef: null,
    }),
  ).toBe(true)
})

test('checkout CLI freshness accepts a matching packed ref', () => {
  expect(
    decideCliBinaryFreshness({
      ...current,
      refSha: null,
      packedRefsContents:
        `# pack-refs with: peeled fully-peeled sorted\n${HEAD_SHA} ${HEAD_REF}\n` +
        `^${OTHER_SHA}\n`,
    }),
  ).toBe(true)
})

test('a loose ref wins over a conflicting packed ref', () => {
  expect(
    decideCliBinaryFreshness({
      ...current,
      packedRefsContents: `${OTHER_SHA} ${HEAD_REF}\n`,
    }),
  ).toBe(true)
})

test.each([
  ['HEAD moved', { ...current, refSha: OTHER_SHA }],
  [
    'detached HEAD mismatch',
    { ...current, symbolicHead: false, refSha: null, headRef: null, headSha: OTHER_SHA },
  ],
  [
    'packed ref mismatch',
    { ...current, refSha: null, packedRefsContents: `${OTHER_SHA} ${HEAD_REF}\n` },
  ],
  [
    'malformed packed refs',
    { ...current, refSha: null, packedRefsContents: `not-a-sha ${HEAD_REF}\n` },
  ],
  ['missing stamp', { ...current, stampContents: null }],
  [
    'stat mismatch',
    { ...current, binaryStat: { ...current.binaryStat!, inode: current.binaryStat!.inode + 1 } },
  ],
  ['read error', { ...current, readError: true }],
] satisfies Array<[string, CheckoutCliFreshnessFacts]>)('%s is not current', (_name, facts) => {
  expect(decideCliBinaryFreshness(facts)).toBe(false)
})

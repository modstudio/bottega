import { expect, test } from 'bun:test'
import { artifactName } from '../../../shared/release-artifacts.ts'
import {
  candidateStoreDecision,
  decideCurrentReleaseUpdate,
  downloadBaseUrlRefusal,
  normalizeReleaseVersion,
  predatesUpdateRefusal,
  resolveReleaseVersion,
  storeAheadRefusal,
  unreadableJournalSchemaRefusal,
  unsupportedTargetRefusal,
  verifyArchiveDigest,
} from './release-update-decision.ts'

const target = 'linux-x64'
const digest = 'a'.repeat(64)
const sums = (names: string[]) => names.map((name) => `${digest}  ${name}`).join('\n')
const journal = [
  { idx: 0, when: 10, tag: 'first', hash: '1'.repeat(64), compatibility: 'additive' },
  { idx: 1, when: 20, tag: 'second', hash: '2'.repeat(64), compatibility: 'additive' },
]

test('latest release resolution requires exactly one target artifact', () => {
  const asset = artifactName('1.2.3', target)
  expect(
    resolveReleaseVersion({
      sums: sums([asset]),
      target,
      currentVersion: '1.0.0',
      sumsUrl: 'file:///sums',
    }),
  ).toEqual({
    action: 'install',
    version: '1.2.3',
    asset,
    digest,
  })
  expect(() =>
    resolveReleaseVersion({
      sums: sums([artifactName('1.2.3', 'darwin-arm64')]),
      target,
      currentVersion: '1.0.0',
      sumsUrl: 'file:///sums',
    }),
  ).toThrow('exactly one')
  expect(() =>
    resolveReleaseVersion({
      sums: sums([asset, artifactName('1.2.4', target)]),
      target,
      currentVersion: '1.0.0',
      sumsUrl: 'file:///sums',
    }),
  ).toThrow('exactly one')
})

test('named release resolution accepts an edge-normalized version and requires its artifact', () => {
  const asset = artifactName('1.2.3', target)
  expect(normalizeReleaseVersion('v1.2.3')).toBe('1.2.3')
  expect(
    resolveReleaseVersion({
      sums: sums([asset]),
      target,
      requestedVersion: '1.2.3',
      currentVersion: '1.0.0',
      sumsUrl: 'https://example/sums',
    }),
  ).toMatchObject({ action: 'install', version: '1.2.3' })
  expect(() =>
    resolveReleaseVersion({
      sums: sums([asset]),
      target,
      requestedVersion: '1.2.4',
      currentVersion: '1.0.0',
      sumsUrl: 'https://example/sums',
    }),
  ).toThrow('1.2.4 is not available')
})

test('same version is a no-op with a remedy', () => {
  const asset = artifactName('1.2.3', target)
  expect(
    resolveReleaseVersion({
      sums: sums([asset]),
      target,
      currentVersion: '1.2.3',
      sumsUrl: 'file:///sums',
    }),
  ).toEqual({
    action: 'current',
    version: '1.2.3',
  })
})

test('current release chooses a no-op or interrupted-update migration', () => {
  expect(decideCurrentReleaseUpdate('1.2.3', false)).toEqual({
    action: 'no-op',
    message: 'already at 1.2.3; name a version to install another',
  })
  expect(decideCurrentReleaseUpdate('1.2.3', true)).toEqual({
    action: 'migrate',
    message: 'migrated the store to 1.2.3',
  })
})

test('download URLs require an absolute supported scheme', () => {
  expect(downloadBaseUrlRefusal('file:///tmp/releases')).toBeNull()
  expect(downloadBaseUrlRefusal('/tmp/releases')).toContain('absolute download URL')
  expect(downloadBaseUrlRefusal('ftp://example.test/releases')).toContain('ftp:')
})

test('archive digest verification accepts a match and refuses a mismatch', () => {
  const bytes = new TextEncoder().encode('release')
  const expected = 'a4d451ec23463726f72c43d64c710968f6b602cd653b4de8adee1b556240a829'
  expect(verifyArchiveDigest(bytes, { asset: 'release.tar.gz', digest: expected })).toBeNull()
  expect(verifyArchiveDigest(bytes, { asset: 'release.tar.gz', digest })).toContain(
    'digest mismatch for release.tar.gz',
  )
})

test('specific release refusals preserve diagnostics and remedies', () => {
  expect(predatesUpdateRefusal('1.2.3', 2, 'missing command\nmore')).toContain(
    'probe exit 2; stderr: missing command',
  )
  expect(unreadableJournalSchemaRefusal('1.2.3', 0, 'new schema\nmore')).toContain(
    'probe exit 0; stderr: new schema',
  )
  expect(storeAheadRefusal('1.1.0', '1.2.0')).toContain('install 1.2.0 or newer')
  expect(unsupportedTargetRefusal('win32', 'x64')).toContain('supported platform')
})

test('candidate store position handles prefix, equal, ahead, divergent, and empty stores', () => {
  expect(candidateStoreDecision([{ when: 10, hash: '1'.repeat(64) }], journal)).toMatchObject({
    state: 'positioned',
    position: 1,
  })
  expect(
    candidateStoreDecision(
      [
        { when: 10, hash: '1'.repeat(64) },
        { when: 20, hash: '2'.repeat(64) },
      ],
      journal,
    ),
  ).toMatchObject({ state: 'positioned', position: 2 })
  expect(
    candidateStoreDecision(
      [...journal.map(({ when, hash }) => ({ when, hash })), { when: 30, hash: '3'.repeat(64) }],
      journal,
    ),
  ).toEqual({ state: 'ahead' })
  expect(candidateStoreDecision([{ when: 10, hash: '9'.repeat(64) }], journal)).toEqual({
    state: 'ahead',
  })
  expect(candidateStoreDecision([], journal)).toMatchObject({ state: 'positioned', position: 0 })
})

test('candidate journal drives additive, fenced, and no-pending drain decisions', () => {
  expect(candidateStoreDecision([], journal)).toMatchObject({ drain: { action: 'apply-now' } })
  expect(candidateStoreDecision([], [{ ...journal[0]!, compatibility: 'fenced' }])).toMatchObject({
    drain: { action: 'fence', migration: 'first' },
  })
  expect(
    candidateStoreDecision(
      journal.map(({ when, hash }) => ({ when, hash })),
      journal,
    ),
  ).toMatchObject({ drain: { action: 'apply-now' } })
})

import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  artifactName,
  DOWNLOAD_BASE_URL_ENV,
  parseSha256Sums,
  releaseTarget,
} from '../../../shared/release-artifacts.ts'
import {
  candidateStoreDecision,
  decideUpdatePath,
  digestMismatchRefusal,
  predatesUpdateRefusal,
  resolveReleaseVersion,
  storeAheadRefusal,
  unsupportedDownloadSchemeRefusal,
} from './release-update-decision.ts'

const target = 'linux-x64'
const digest = 'a'.repeat(64)
const sums = (names: string[]) => names.map((name) => `${digest}  ${name}`).join('\n')
const journal = [
  { idx: 0, when: 10, tag: 'first', compatibility: 'additive' },
  { idx: 1, when: 20, tag: 'second', compatibility: 'additive' },
]

test('update path chooses checkout and distribution and refuses a checkout version', () => {
  expect(decideUpdatePath('checkout')).toEqual({ action: 'checkout' })
  expect(decideUpdatePath('distribution')).toEqual({ action: 'distribution' })
  expect(decideUpdatePath('checkout', '1.2.3')).toEqual({
    action: 'refuse',
    reason: expect.stringContaining(`run ${PLATFORM_SLUG} machine update`),
  })
})

test('release targets cover supported hosts and reject unsupported hosts', () => {
  expect(releaseTarget('darwin', 'arm64')).toBe('darwin-arm64')
  expect(releaseTarget('darwin', 'x64')).toBe('darwin-x64')
  expect(releaseTarget('linux', 'x64')).toBe('linux-x64')
  expect(releaseTarget('linux', 'arm64')).toBe('linux-arm64')
  expect(releaseTarget('win32', 'x64')).toBeNull()
})

test('SHA256SUMS parser accepts valid text and refuses malformed lines', () => {
  expect(parseSha256Sums(`${digest.toUpperCase()}  file.tar.gz\n`)).toEqual(
    new Map([['file.tar.gz', digest]]),
  )
  expect(() => parseSha256Sums(`${digest} file.tar.gz`)).toThrow('invalid SHA256SUMS line')
})

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

test('named release resolution normalizes v and requires the named artifact', () => {
  const asset = artifactName('1.2.3', target)
  expect(
    resolveReleaseVersion({
      sums: sums([asset]),
      target,
      requestedVersion: 'v1.2.3',
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
    message: 'already at 1.2.3; name a version to install another',
  })
})

test('release refusals name remedies', () => {
  const refusals = [
    predatesUpdateRefusal('1.2.3'),
    storeAheadRefusal('1.2.3'),
    digestMismatchRefusal('asset', digest, 'b'.repeat(64)),
    'already at 1.2.3; name a version to install another',
    unsupportedDownloadSchemeRefusal('ftp:'),
  ]
  expect(
    refusals.every((value) =>
      /install|update|retry|name a version|set BOTTEGA_DOWNLOAD_BASE_URL/.test(value),
    ),
  ).toBe(true)
  expect(refusals.at(-1)).toContain(DOWNLOAD_BASE_URL_ENV)
})

test('candidate store position handles prefix, equal, ahead, divergent, and empty stores', () => {
  expect(candidateStoreDecision([{ when: 10, tag: 'first' }], journal)).toMatchObject({
    state: 'positioned',
    position: 1,
  })
  expect(
    candidateStoreDecision(
      [
        { when: 10, tag: 'first' },
        { when: 20, tag: 'second' },
      ],
      journal,
    ),
  ).toMatchObject({ state: 'positioned', position: 2 })
  expect(
    candidateStoreDecision(
      [...journal.map(({ when, tag }) => ({ when, tag })), { when: 30, tag: 'third' }],
      journal,
    ),
  ).toEqual({ state: 'ahead' })
  expect(candidateStoreDecision([{ when: 10, tag: 'different' }], journal)).toEqual({
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
      journal.map(({ when, tag }) => ({ when, tag })),
      journal,
    ),
  ).toMatchObject({ drain: { action: 'apply-now' } })
})

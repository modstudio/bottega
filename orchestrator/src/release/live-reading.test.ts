import { describe, expect, test } from 'bun:test'
import { gitAt } from '../../../shared/git.ts'
import {
  jsonStringAtPath,
  type LiveReadingCapture,
  type VersionCommitReader,
  mappedVersionCommit,
  newestVersionIntroduction,
  RELEASE_LIVE_READING_TIMEOUT_MS,
  readLiveCommit,
  readLiveVersion,
  unmappedVersionFailure,
  versionIntroducedAtCommit,
} from './live-reading.ts'

const fullCommit = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01'

function read(capture: LiveReadingCapture) {
  return readLiveCommit('read-live', '/project', (command, cwd, timeoutMs) => {
    expect({ command, cwd, timeoutMs }).toEqual({
      command: 'read-live',
      cwd: '/project',
      timeoutMs: RELEASE_LIVE_READING_TIMEOUT_MS,
    })
    return capture
  })
}

describe('release live reading', () => {
  test('accepts exactly one full commit and lowercases it', () => {
    expect(read({ exitCode: 0, output: ` ${fullCommit}\n`, timedOut: false })).toEqual({
      ok: true,
      commit: fullCommit.toLowerCase(),
    })
  })

  test.each(['', `${fullCommit}\nextra`, 'abcdef0'])(
    'rejects output that is not one full commit: %j',
    (output) => {
      expect(read({ exitCode: 0, output, timedOut: false })).toMatchObject({
        ok: false,
        kind: 'invalid-output',
      })
    },
  )

  test('distinguishes a nonzero exit', () => {
    expect(read({ exitCode: 7, output: 'unavailable', timedOut: false })).toEqual({
      ok: false,
      kind: 'nonzero-exit',
      failure: 'live command failed (exit 7): unavailable',
    })
  })

  test('distinguishes a timeout from other failures', () => {
    expect(read({ exitCode: 1, output: 'partial', timedOut: true })).toEqual({
      ok: false,
      kind: 'timeout',
      failure: 'live reading timed out',
    })
  })

  test('withholds secret-shaped failure output', () => {
    const secret = 'password=fixture-not-a-real-secret'
    const reading = read({ exitCode: 2, output: secret, timedOut: false })
    expect(reading).toMatchObject({ ok: false, kind: 'nonzero-exit' })
    expect(reading).not.toEqual(
      expect.objectContaining({ failure: expect.stringContaining(secret) }),
    )
  })
})

describe('release live version decisions', () => {
  const versionFile = JSON.stringify({ package: { release: { version: '0.48.0' } } })
  const settings = { file: 'package.json', key: 'package.version' }

  function fakeVersionReader(facts: {
    log?: { code: number; stdout: string }
    blobs?: Record<string, string | null>
    ancestors?: string[]
  }): VersionCommitReader {
    return {
      log: (_cwd: string, _args: string[]) => facts.log ?? { code: 0, stdout: '' },
      blob: (_cwd: string, commit: string, _file: string, _maxBytes: number) =>
        facts.blobs?.[commit] ?? null,
      isAncestor: (_cwd: string, commit: string, _branchRef: string) =>
        facts.ancestors?.includes(commit) ?? false,
    }
  }

  test('reads a string through a dot path', () => {
    expect(jsonStringAtPath(versionFile, 'package.release.version')).toBe('0.48.0')
    expect(jsonStringAtPath(versionFile, 'package.version')).toBeNull()
  })

  test('rejects a removal hit and confirms an introduction', () => {
    expect(
      versionIntroducedAtCommit({
        current: JSON.stringify({ version: '0.49.0' }),
        firstParent: JSON.stringify({ version: '0.48.0' }),
        key: 'version',
        version: '0.48.0',
      }),
    ).toBe(false)
    expect(
      versionIntroducedAtCommit({
        current: JSON.stringify({ version: '0.48.0' }),
        firstParent: JSON.stringify({ version: '0.47.0' }),
        key: 'version',
        version: '0.48.0',
      }),
    ).toBe(true)
  })

  test('chooses the newest confirmed introduction after a re-introduction', () => {
    expect(
      newestVersionIntroduction([
        { commit: 'reintroduced', introduced: true, branchAncestor: true },
        { commit: 'removal', introduced: false, branchAncestor: true },
        { commit: 'original', introduced: true, branchAncestor: true },
      ]),
    ).toBe('reintroduced')
  })

  test('returns the unmapped-version outcome when no introduction matches', () => {
    expect(newestVersionIntroduction([])).toBeNull()
    expect(unmappedVersionFailure('0.48.0', 'package.json', 'main')).toEqual({
      ok: false,
      kind: 'unmapped-version',
      failure: 'served version 0.48.0 is not introduced in package.json on main',
    })
  })

  test('maps the newest confirmed ancestor after a revert and re-introduction', () => {
    const logCalls: { cwd: string; args: string[] }[] = []
    const ancestorCalls: { cwd: string; commit: string; branchRef: string }[] = []
    const reader = fakeVersionReader({
      log: { code: 0, stdout: 'reintroduced\nremoval\nother-branch\noriginal\n' },
      blobs: {
        reintroduced: JSON.stringify({ package: { version: '0.48.0' } }),
        'reintroduced^': JSON.stringify({ package: { version: '0.47.0' } }),
        removal: JSON.stringify({ package: { version: '0.49.0' } }),
        'removal^': JSON.stringify({ package: { version: '0.48.0' } }),
        'other-branch': JSON.stringify({ package: { version: '0.48.0' } }),
        'other-branch^': JSON.stringify({ package: { version: '0.47.0' } }),
        original: JSON.stringify({ package: { version: '0.48.0' } }),
        'original^': JSON.stringify({ package: { version: '0.47.0' } }),
      },
      ancestors: ['reintroduced', 'removal', 'original'],
    })
    reader.log = (cwd, args) => {
      logCalls.push({ cwd, args })
      return { code: 0, stdout: 'reintroduced\nremoval\nother-branch\noriginal\n' }
    }
    reader.isAncestor = (cwd, commit, branchRef) => {
      ancestorCalls.push({ cwd, commit, branchRef })
      return ['reintroduced', 'removal', 'original'].includes(commit)
    }

    expect(mappedVersionCommit('/project', 'main', settings, '0.48.0', reader)).toBe(
      'reintroduced',
    )
    expect(logCalls).toEqual([
      {
        cwd: '/project',
        args: [
          'log',
          '--format=%H',
          '-S"version": "0.48.0"',
          'origin/main',
          '--',
          'package.json',
        ],
      },
    ])
    expect(ancestorCalls).toContainEqual({
      cwd: '/project',
      commit: 'reintroduced',
      branchRef: 'origin/main',
    })
  })

  test('does not map a log hit whose blob does not confirm the version', () => {
    const reader = fakeVersionReader({
      log: { code: 0, stdout: 'removal\n' },
      blobs: {
        removal: JSON.stringify({ package: { version: '0.49.0' } }),
        'removal^': JSON.stringify({ package: { version: '0.48.0' } }),
      },
      ancestors: ['removal'],
    })
    expect(mappedVersionCommit('/project', 'main', settings, '0.48.0', reader)).toBeNull()
  })

  test('does not map a confirmed introduction outside the branch ancestry', () => {
    const reader = fakeVersionReader({
      log: { code: 0, stdout: 'other-branch\n' },
      blobs: {
        'other-branch': JSON.stringify({ package: { version: '0.48.0' } }),
        'other-branch^': JSON.stringify({ package: { version: '0.47.0' } }),
      },
    })
    expect(mappedVersionCommit('/project', 'main', settings, '0.48.0', reader)).toBeNull()
  })

  test('does not map a version when the git log read fails', () => {
    const reader = fakeVersionReader({ log: { code: 128, stdout: 'ignored' } })
    expect(mappedVersionCommit('/project', 'main', settings, '0.48.0', reader)).toBeNull()
  })

  test('returns the candidate when its served version has no introducing commit', () => {
    const candidate = gitAt(process.cwd(), ['rev-parse', 'HEAD']).stdout.trim()
    const candidateVersion = jsonStringAtPath(
      gitAt(process.cwd(), ['show', `${candidate}:package.json`]).stdout,
      'version',
    )!

    expect(
      readLiveVersion(
        { command: 'read-live-version', file: 'package.json', key: 'version' },
        process.cwd(),
        candidate,
        'branch-with-no-version-introduction',
        () => ({ exitCode: 0, output: `${candidateVersion}\n`, timedOut: false }),
      ),
    ).toEqual({
      ok: true,
      commit: candidate,
      version: candidateVersion,
      candidateVersion,
      matchesCandidate: true,
    })
  })
})

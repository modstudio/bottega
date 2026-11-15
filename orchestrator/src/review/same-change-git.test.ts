import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { changeIdentity, zeroContextChangeIdentity } from './change-identity.ts'
import type { CoverageGitResult, CoverageGitRunner } from './review-types.ts'
import { gatherSameChange } from './same-change-git.ts'

const encoder = new TextEncoder()

function fixtureCommit(
  ref: string,
  mark: number,
  parent: number | null,
  message: string,
  body: string,
) {
  return `commit refs/heads/${ref}
mark :${mark}
author Fixture <fixture@example.com> 1700000000 +0000
committer Fixture <fixture@example.com> 1700000000 +0000
data ${message.length}
${message}
${parent === null ? '' : `from :${parent}\n`}deleteall
M 100644 inline app.txt
data ${Buffer.byteLength(body)}
${body}
`
}

const hashBytes = (bytes: Uint8Array): string => {
  let hash = 2_166_136_261
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16_777_619)
  return (hash >>> 0).toString(16).padStart(8, '0')
}

test('gatherSameChange recomputes old identities and falls back to a real trivial replay', () => {
  const repo = mkdtempSync(join(tmpdir(), 'orch-same-change-'))
  let spawns = 0
  const spawnedGit = (args: string[], stdin?: Uint8Array) => {
    spawns += 1
    const result = spawnFixtureGitSync(args, { cwd: repo, stdin })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result
  }
  try {
    spawnedGit(['init', '-b', 'main'])
    const base = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n'
    const stream = [
      fixtureCommit('base', 1, null, 'base', base),
      fixtureCommit(
        'a-reviewed',
        2,
        1,
        'reviewed a',
        base.replace('two', 'shared-two').replace('seven', 'branch-seven'),
      ),
      fixtureCommit('a-new-base', 3, 1, 'trunk landed part', base.replace('two', 'shared-two')),
      fixtureCommit(
        'a-tip',
        4,
        3,
        'rebased a',
        base.replace('two', 'shared-two').replace('seven', 'branch-seven'),
      ),
      fixtureCommit('e-reviewed', 5, 1, 'reviewed e', base.replace('seven', 'branch-seven')),
      fixtureCommit('e-new-base', 6, 1, 'nearby trunk', base.replace('four', 'trunk-four')),
      fixtureCommit(
        'e-tip',
        7,
        6,
        'rebased e',
        base.replace('four', 'trunk-four').replace('seven', 'branch-seven'),
      ),
      fixtureCommit('b-reviewed', 8, 1, 'reviewed b', base.replace('two', 'branch-two')),
      fixtureCommit('b-new-base', 9, 1, 'conflicting trunk', base.replace('two', 'trunk-two')),
      fixtureCommit('b-tip', 10, 9, 'resolved b', base.replace('two', 'resolved-two')),
      fixtureCommit('c-reviewed', 11, 1, 'reviewed c', `${base}reviewed-c\n`),
      fixtureCommit('c-tip', 12, 1, 'edited c', `${base}reviewed-c\npost-review-edit\n`),
    ].join('')
    spawnedGit(['fast-import', '--quiet'], encoder.encode(stream))
    const names = [
      'base',
      'a-reviewed',
      'a-new-base',
      'a-tip',
      'e-reviewed',
      'e-new-base',
      'e-tip',
      'b-reviewed',
      'b-new-base',
      'b-tip',
      'c-reviewed',
      'c-tip',
      'a-tip^{tree}',
      'b-tip^{tree}',
      'c-tip^{tree}',
      'e-tip^{tree}',
    ]
    const resolved = spawnedGit(['rev-parse', ...names])
      .stdout.toString()
      .trim()
      .split('\n')
    const refs = new Map(names.map((name, index) => [name, resolved[index]!]))
    const syntheticDiffs = new Map([
      [`${refs.get('base')}..${refs.get('c-reviewed')}`, 'reviewed c diff'],
      [`${refs.get('base')}..${refs.get('c-tip')}`, 'edited c diff'],
    ])
    const cache = new Map<string, CoverageGitResult>()
    const mergeTreeCalls: string[][] = []
    const runner: CoverageGitRunner = (args, stdin) => {
      if (args[0] === 'cat-file') {
        const missing = args[2]?.startsWith('0000000000000000000000000000000000000000')
        return { ok: !missing, out: '', stdout: new Uint8Array(), err: missing ? 'missing' : '' }
      }
      if (args[0] === 'patch-id') {
        const normalized = encoder.encode(
          new TextDecoder()
            .decode(stdin ?? new Uint8Array())
            .split('\n')
            .filter((line) => !line.startsWith('index '))
            .join('\n'),
        )
        const out = `${hashBytes(normalized)} fixture`
        return { ok: true, out, stdout: encoder.encode(out), err: '' }
      }
      if (args[0] === 'diff') {
        const synthetic = syntheticDiffs.get(args.at(-1) ?? '')
        if (synthetic) {
          return { ok: true, out: synthetic, stdout: encoder.encode(synthetic), err: '' }
        }
      }
      const key = `${JSON.stringify(args)}\0${hashBytes(stdin ?? new Uint8Array())}`
      const existing = cache.get(key)
      if (existing) return existing
      if (args[0] === 'merge-tree') mergeTreeCalls.push(args)
      const result = spawnFixtureGitSync(args, { cwd: repo, stdin })
      spawns += 1
      const ok = result.exitCode === 0
      let out = result.stdout.toString().trim()
      if (ok && args[0] === 'merge-tree') out += '\nfixture diagnostic'
      const value = {
        ok,
        out,
        stdout: new Uint8Array(result.stdout),
        err: result.stderr.toString().trim() || `exit ${result.exitCode}`,
      }
      cache.set(key, value)
      return value
    }
    const identity = (from: string, to: string) => ({
      patchId: changeIdentity(runner, from, to),
      zeroContextPatchId: zeroContextChangeIdentity(runner, from, to),
      paths: ['app.txt'],
      message: null,
    })
    const ref = (name: string) => refs.get(name)!

    const replay = gatherSameChange({
      runner,
      reviewed: { ...identity(ref('base'), ref('a-reviewed')), zeroContextPatchId: null },
      reviewedCommit: ref('a-reviewed'),
      oldBase: ref('base'),
      current: { paths: ['app.txt'], message: null },
      tip: ref('a-tip'),
      tipTree: ref('a-tip^{tree}'),
      newBase: ref('a-new-base'),
    })
    expect(replay.decision).toMatchObject({ same: true, basis: 'replay', reason: null })

    const conflict = gatherSameChange({
      runner,
      reviewed: identity(ref('base'), ref('b-reviewed')),
      reviewedCommit: ref('b-reviewed'),
      oldBase: ref('base'),
      current: { paths: ['app.txt'], message: null },
      tip: ref('b-tip'),
      tipTree: ref('b-tip^{tree}'),
      newBase: ref('b-new-base'),
    })
    expect(conflict.decision).toMatchObject({
      same: false,
      basis: 'different',
      reason: 'change replay conflicted',
    })

    const edited = gatherSameChange({
      runner,
      reviewed: identity(ref('base'), ref('c-reviewed')),
      reviewedCommit: ref('c-reviewed'),
      oldBase: ref('base'),
      current: { paths: ['app.txt'], message: null },
      tip: ref('c-tip'),
      tipTree: ref('c-tip^{tree}'),
      newBase: ref('base'),
    })
    expect(edited.decision).toMatchObject({
      same: false,
      basis: 'different',
      reason: 'change identity differs',
    })

    const missingCommit = '0000000000000000000000000000000000000000'
    const unavailable = gatherSameChange({
      runner,
      reviewed: { patchId: 'old', zeroContextPatchId: null, paths: ['app.txt'], message: null },
      reviewedCommit: missingCommit,
      oldBase: ref('base'),
      current: { paths: ['app.txt'], message: null },
      tip: ref('c-tip'),
      tipTree: ref('c-tip^{tree}'),
      newBase: ref('base'),
    })
    expect(unavailable.decision).toMatchObject({
      same: false,
      basis: 'different',
      reason: `reviewed commit ${missingCommit} is missing`,
    })

    const recomputed = gatherSameChange({
      runner,
      reviewed: { ...identity(ref('base'), ref('e-reviewed')), zeroContextPatchId: null },
      reviewedCommit: ref('e-reviewed'),
      oldBase: ref('base'),
      current: { paths: ['app.txt'], message: null },
      tip: ref('e-tip'),
      tipTree: ref('e-tip^{tree}'),
      newBase: ref('e-new-base'),
    })
    expect(recomputed.decision).toMatchObject({
      same: true,
      basis: 'zero-context',
      reason: null,
    })
    expect(mergeTreeCalls[0]).toEqual([
      'merge-tree',
      '--write-tree',
      `--merge-base=${ref('base')}`,
      ref('a-new-base'),
      ref('a-reviewed'),
    ])
    expect(spawns).toBeLessThanOrEqual(20)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

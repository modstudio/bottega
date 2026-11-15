import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { measureChangeIdentity } from './review-pins.ts'

const git = (repo: string, ...args: string[]) => {
  const result = spawnFixtureGitSync(args, { cwd: repo })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

test('zero-context identity ignores nearby trunk context and pins Git diff configuration', () => {
  const repo = mkdtempSync(join(tmpdir(), 'orch-change-identity-'))
  try {
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.email', 'fixture@example.com')
    git(repo, 'config', 'user.name', 'Fixture')
    writeFileSync(join(repo, 'app.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n')
    git(repo, 'add', 'app.txt')
    git(repo, 'commit', '-m', 'base')
    const base = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '-b', 'change')
    writeFileSync(join(repo, 'app.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nbranch\nseven\neight\n')
    git(repo, 'commit', '-am', 'reviewed change')
    const reviewed = git(repo, 'rev-parse', 'HEAD')
    const before = measureChangeIdentity(repo, base, reviewed)!
    git(repo, 'checkout', 'main')
    writeFileSync(join(repo, 'app.txt'), 'one\ntwo\nthree\ntrunk\nfive\nsix\nseven\neight\n')
    git(repo, 'commit', '-am', 'nearby trunk edit')
    git(repo, 'checkout', 'change')
    git(repo, 'rebase', 'main')
    const afterBase = git(repo, 'merge-base', 'main', 'HEAD')
    const after = measureChangeIdentity(repo, afterBase, 'HEAD')!

    expect(after.patchId).not.toBe(before.patchId)
    expect(after.zeroContextPatchId).toBe(before.zeroContextPatchId)
    git(repo, 'config', 'diff.noprefix', 'true')
    git(repo, 'config', 'diff.mnemonicPrefix', 'true')
    git(repo, 'config', 'diff.renames', 'true')
    expect(measureChangeIdentity(repo, afterBase, 'HEAD')!.zeroContextPatchId).toBe(
      after.zeroContextPatchId,
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('zero-context identity re-owes whitespace, mode, and binary edits', () => {
  const repo = mkdtempSync(join(tmpdir(), 'orch-verbatim-identity-'))
  try {
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.email', 'fixture@example.com')
    git(repo, 'config', 'user.name', 'Fixture')
    writeFileSync(join(repo, 'script.sh'), '#!/bin/sh\necho ok\n')
    writeFileSync(join(repo, 'asset.bin'), new Uint8Array([0, 1, 2, 3]))
    git(repo, 'add', 'script.sh', 'asset.bin')
    git(repo, 'commit', '-m', 'base')
    const base = git(repo, 'rev-parse', 'HEAD')
    writeFileSync(join(repo, 'script.sh'), '#!/bin/sh\necho changed\n')
    git(repo, 'commit', '-am', 'reviewed')
    const reviewed = git(repo, 'rev-parse', 'HEAD')
    const before = measureChangeIdentity(repo, base, reviewed)!.zeroContextPatchId
    writeFileSync(join(repo, 'script.sh'), '#!/bin/sh\necho changed \n')
    git(repo, 'commit', '-am', 'whitespace')
    expect(measureChangeIdentity(repo, base, 'HEAD')!.zeroContextPatchId).not.toBe(before)
    const whitespace = measureChangeIdentity(repo, base, 'HEAD')!.zeroContextPatchId
    git(repo, 'update-index', '--chmod=+x', 'script.sh')
    git(repo, 'commit', '-m', 'mode')
    expect(measureChangeIdentity(repo, base, 'HEAD')!.zeroContextPatchId).not.toBe(whitespace)
    const mode = measureChangeIdentity(repo, base, 'HEAD')!.zeroContextPatchId
    writeFileSync(join(repo, 'asset.bin'), new Uint8Array([0, 1, 2, 4]))
    git(repo, 'add', 'asset.bin')
    git(repo, 'commit', '-m', 'binary')
    expect(measureChangeIdentity(repo, base, 'HEAD')!.zeroContextPatchId).not.toBe(mode)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

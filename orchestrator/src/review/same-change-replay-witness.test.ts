import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import type { CoverageGitResult, CoverageGitRunner } from './review-types.ts'
import { replayWitnessesForCurrent } from './same-change-git.ts'

const encoder = new TextEncoder()

const result = (ok: boolean, out = ''): CoverageGitResult => ({
  ok,
  out,
  stdout: encoder.encode(out),
  err: ok ? '' : 'fixture refusal',
})

const row = {
  tip: 'reviewed-tip',
  patchId: 'reviewed-patch',
  zeroContextPatchId: 'reviewed-zero',
  pathSet: '["src/change.ts"]',
}

const current = {
  patchId: 'current-patch',
  zeroContextPatchId: 'current-zero',
  pathSet: '["src/change.ts"]',
  base: 'current-base',
  tip: 'current-tip',
  tree: 'current-tree',
}

test('a row on the current tree matches without replaying it', () => {
  const calls: string[][] = []
  const runner: CoverageGitRunner = (args) => {
    calls.push(args)
    expect(args).toEqual(['rev-parse', '--verify', 'reviewed-tip^{tree}'])
    return result(true, current.tree)
  }

  expect(
    replayWitnessesForCurrent({ runner, rows: [row], current, trunk: 'trunk' })[0]
      ?.replayMatchesCurrent,
  ).toBe(true)
  expect(calls).toHaveLength(1)
})

test('an ancestor on a different tree is refused without replaying it', () => {
  const calls: string[][] = []
  const runner: CoverageGitRunner = (args) => {
    calls.push(args)
    if (args[0] === 'rev-parse') return result(true, 'reviewed-tree')
    expect(args).toEqual(['merge-base', '--is-ancestor', 'reviewed-tip', 'current-tip'])
    return result(true)
  }

  expect(
    replayWitnessesForCurrent({ runner, rows: [row], current, trunk: 'trunk' })[0]
      ?.replayMatchesCurrent,
  ).toBe(false)
  expect(calls).toEqual([
    ['rev-parse', '--verify', 'reviewed-tip^{tree}'],
    ['merge-base', '--is-ancestor', 'reviewed-tip', 'current-tip'],
  ])
})

test('two consumers sharing a witness memo replay one tip once', () => {
  const calls: string[][] = []
  const runner: CoverageGitRunner = (args, _stdin, stdinFile) => {
    calls.push(args)
    if (args[0] === 'rev-parse') return result(true, 'reviewed-tree')
    if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return result(false)
    if (args[0] === 'merge-base') return result(true, 'reviewed-base')
    if (args[0] === 'diff') {
      const output = args.find((arg) => arg.startsWith('--output='))
      if (output) writeFileSync(output.slice('--output='.length), 'fixture diff')
      return result(true)
    }
    if (args[0] === 'patch-id') {
      expect(stdinFile).toBeTruthy()
      return result(
        true,
        args.includes('--verbatim') ? 'current-zero fixture' : 'current-patch fixture',
      )
    }
    if (args[0] === 'cat-file') return result(true)
    if (args[0] === 'merge-tree') return result(true, current.tree)
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  }
  const witnesses = new Map<string, boolean>()
  const input = { runner, rows: [row], current, trunk: 'trunk', witnesses }

  expect(replayWitnessesForCurrent(input)[0]?.replayMatchesCurrent).toBe(true)
  expect(replayWitnessesForCurrent(input)[0]?.replayMatchesCurrent).toBe(true)
  expect(calls.filter(([command]) => command === 'merge-tree')).toHaveLength(1)
  expect(calls.filter(([command]) => command === 'rev-parse')).toHaveLength(1)
})

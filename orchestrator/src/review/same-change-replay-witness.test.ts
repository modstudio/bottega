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

const replayingRunner =
  (calls: string[][], oldBase = 'reviewed-base'): CoverageGitRunner =>
  (args, _stdin, stdinFile) => {
    calls.push(args)
    if (args[0] === 'rev-parse') return result(true, current.tree)
    if (args[0] === 'merge-base') return result(true, oldBase)
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

test('equal tip and current trees still replay when the base moved', () => {
  const calls: string[][] = []
  const runner = replayingRunner(calls)

  expect(
    replayWitnessesForCurrent({ runner, rows: [row], current, trunk: 'trunk' })[0]
      ?.replayMatchesCurrent,
  ).toBe(true)
  expect(calls.filter(([command]) => command === 'merge-tree')).toHaveLength(1)
})

test('a differing identity on the same base is refused without merge-tree', () => {
  const calls: string[][] = []
  const runner = replayingRunner(calls, current.base)

  expect(
    replayWitnessesForCurrent({ runner, rows: [row], current, trunk: 'trunk' })[0]
      ?.replayMatchesCurrent,
  ).toBe(false)
  expect(calls).toEqual([['merge-base', 'reviewed-tip', 'trunk']])
})

test('two consumers sharing a witness memo replay one tip once', () => {
  const calls: string[][] = []
  const runner = replayingRunner(calls)
  const witnesses = new Map<string, boolean>()
  const input = { runner, rows: [row], current, trunk: 'trunk', witnesses }

  expect(replayWitnessesForCurrent(input)[0]?.replayMatchesCurrent).toBe(true)
  expect(replayWitnessesForCurrent(input)[0]?.replayMatchesCurrent).toBe(true)
  expect(calls.filter(([command]) => command === 'merge-tree')).toHaveLength(1)
})

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { link, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decideStateFileMove, renameStateFiles, stateFileMoveDecision } from './setup-state-file.ts'

const pair = { oldPath: '/state/old.db', newPath: '/state/orchestrator.db' }
const absentFiles = { store: false, wal: false, shm: false, journal: false }
const knownNoHolders = { kind: 'known' as const, holders: [] }

test('moves legacy state and leaves current or fresh state alone', () => {
  expect(
    stateFileMoveDecision(pair, {
      explicitPath: false,
      old: { ...absentFiles, store: true, wal: true, shm: true },
      current: absentFiles,
      holders: knownNoHolders,
    }),
  ).toEqual({ kind: 'move', suffixes: ['', '-wal', '-shm'] })
  expect(
    stateFileMoveDecision(pair, {
      explicitPath: false,
      old: absentFiles,
      current: { ...absentFiles, store: true },
      holders: knownNoHolders,
    }),
  ).toEqual({ kind: 'noop' })
  expect(
    stateFileMoveDecision(pair, {
      explicitPath: false,
      old: absentFiles,
      current: absentFiles,
      holders: knownNoHolders,
    }),
  ).toEqual({ kind: 'noop' })
})

test('refuses collisions, holders, and unknown holder inventory', () => {
  const legacyOnly = { ...absentFiles, store: true }
  expect(
    stateFileMoveDecision(pair, {
      explicitPath: false,
      old: legacyOnly,
      current: { ...absentFiles, store: true },
      holders: knownNoHolders,
    }),
  ).toEqual(
    expect.objectContaining({ kind: 'refuse', reason: expect.stringContaining(pair.oldPath) }),
  )
  expect(
    stateFileMoveDecision(pair, {
      explicitPath: false,
      old: legacyOnly,
      current: absentFiles,
      holders: { kind: 'known', holders: [{ pid: 42, command: 'mcp serve' }] },
    }),
  ).toEqual(
    expect.objectContaining({
      kind: 'refuse',
      reason: expect.stringContaining('pid 42 (mcp serve)'),
    }),
  )
  expect(
    stateFileMoveDecision(pair, {
      explicitPath: false,
      old: legacyOnly,
      current: absentFiles,
      holders: { kind: 'unknown', reason: 'lsof unavailable' },
    }),
  ).toEqual(
    expect.objectContaining({
      kind: 'refuse',
      reason: expect.stringContaining('lsof unavailable'),
    }),
  )
})

test.each(['wal', 'shm'] as const)(
  'refuses a lone destination %s sidecar even when the legacy family lacks it',
  (sidecar) => {
    expect(
      stateFileMoveDecision(pair, {
        explicitPath: false,
        old: { ...absentFiles, store: true },
        current: { ...absentFiles, [sidecar]: true },
        holders: knownNoHolders,
      }),
    ).toEqual(
      expect.objectContaining({
        kind: 'refuse',
        reason: expect.stringContaining(`${pair.newPath}-${sidecar}`),
      }),
    )
  },
)

test('completes an interrupted move when the current store and legacy WAL remain', async () => {
  const root = mkdtempSync(join(tmpdir(), 'state-file-interrupted-'))
  const oldPath = join(root, 'old.db')
  const newPath = join(root, 'new.db')
  writeFileSync(newPath, 'store')
  writeFileSync(`${oldPath}-wal`, 'committed WAL frames')
  try {
    const decision = await decideStateFileMove({ oldPath, newPath }, () => knownNoHolders)
    expect(decision).toEqual({ kind: 'move', suffixes: ['-wal'] })
    if (decision.kind !== 'move') throw new Error('expected interrupted move to complete')
    await renameStateFiles({ oldPath, newPath }, decision.suffixes)
    expect(readFileSync(newPath, 'utf8')).toBe('store')
    expect(readFileSync(`${newPath}-wal`, 'utf8')).toBe('committed WAL frames')
    expect(() => readFileSync(`${oldPath}-wal`)).toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an interrupted move refuses a matching destination sidecar without advising its removal', () => {
  const decision = stateFileMoveDecision(pair, {
    explicitPath: false,
    old: { ...absentFiles, wal: true },
    current: { ...absentFiles, store: true, wal: true },
    holders: knownNoHolders,
  })
  expect(decision).toEqual(
    expect.objectContaining({
      kind: 'refuse',
      reason: expect.stringContaining('preserve it under the destination name'),
    }),
  )
  if (decision.kind !== 'refuse') throw new Error('expected matching sidecars to refuse')
  expect(decision.reason).not.toContain('remove the other')
})

test('leaves an explicit operator path alone', () => {
  expect(
    stateFileMoveDecision(pair, {
      explicitPath: true,
      old: { ...absentFiles, store: true },
      current: absentFiles,
      holders: { kind: 'unknown', reason: 'not inspected' },
    }),
  ).toEqual({ kind: 'leave-explicit' })
})

test.each([0, 1, 2, 3])(
  'a state-file rename failure at step %i rolls back earlier moves',
  async (failure) => {
    const root = mkdtempSync(join(tmpdir(), 'state-file-rollback-'))
    const oldPath = join(root, 'old.db')
    const newPath = join(root, 'new.db')
    const suffixes = ['', '-wal', '-shm', '-journal'] as const
    mkdirSync(root, { recursive: true })
    for (const suffix of suffixes) writeFileSync(`${oldPath}${suffix}`, `contents${suffix}`)
    let calls = 0
    try {
      await expect(
        renameStateFiles({ oldPath, newPath }, [...suffixes], async (source, destination) => {
          if (calls++ === failure) throw new Error(`injected failure ${failure}`)
          await link(source, destination)
          await unlink(source)
        }),
      ).rejects.toThrow(`${oldPath} to ${newPath}`)
      for (const suffix of suffixes) {
        expect(readFileSync(`${oldPath}${suffix}`, 'utf8')).toBe(`contents${suffix}`)
        expect(() => readFileSync(`${newPath}${suffix}`)).toThrow()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test('a destination created during the move is not overwritten and the source stays intact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'state-file-no-clobber-'))
  const oldPath = join(root, 'old.db')
  const newPath = join(root, 'new.db')
  writeFileSync(oldPath, 'legacy')
  try {
    await expect(
      renameStateFiles({ oldPath, newPath }, [''], async (source, destination) => {
        writeFileSync(destination, 'concurrent destination')
        await link(source, destination)
        await unlink(source)
      }),
    ).rejects.toThrow('state-file rename failed')
    expect(readFileSync(oldPath, 'utf8')).toBe('legacy')
    expect(readFileSync(newPath, 'utf8')).toBe('concurrent destination')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { applyStagedRelease, releaseUpdatePriorBinaryPath } from './release-update.ts'

const before = { orchestrator: 10, hub: 20 }

function stagedReleaseTest(): { root: string; staged: string; target: string; prior: string } {
  const root = mkdtempSync(join(tmpdir(), 'release-update.'))
  const staged = join(root, 'staged')
  const target = join(root, 'target')
  const prior = releaseUpdatePriorBinaryPath(target)
  writeFileSync(staged, 'new')
  writeFileSync(target, 'original')
  return { root, staged, target, prior }
}

test('a failed migration with unchanged positions restores the prior binary', () => {
  const paths = stagedReleaseTest()
  let cleared = false
  try {
    expect(() =>
      applyStagedRelease({
        ...paths,
        migrate: () => {
          throw new Error('migration broke')
        },
        positions: () => before,
        writeIntent: () => {},
        clearIntent: () => {
          cleared = true
        },
      }),
    ).toThrow('the prior binary was restored')
    expect(readFileSync(paths.target, 'utf8')).toBe('original')
    expect(existsSync(paths.prior)).toBe(false)
    expect(existsSync(paths.staged)).toBe(false)
    expect(cleared).toBe(true)
  } finally {
    rmSync(paths.root, { recursive: true, force: true })
  }
})

test('a failed migration after a position moves keeps the new binary', () => {
  const paths = stagedReleaseTest()
  let cleared = false
  let reads = 0
  try {
    expect(() =>
      applyStagedRelease({
        ...paths,
        migrate: () => {
          throw new Error('migration broke')
        },
        positions: () => (++reads === 1 ? before : { ...before, hub: before.hub + 1 }),
        writeIntent: () => {},
        clearIntent: () => {
          cleared = true
        },
      }),
    ).toThrow(`rerun ${PLATFORM_SLUG} machine update`)
    expect(readFileSync(paths.target, 'utf8')).toBe('new')
    expect(existsSync(paths.prior)).toBe(false)
    expect(cleared).toBe(true)
  } finally {
    rmSync(paths.root, { recursive: true, force: true })
  }
})

test('a successful migration removes the prior binary', () => {
  const paths = stagedReleaseTest()
  let cleared = false
  try {
    applyStagedRelease({
      ...paths,
      migrate: () => {},
      positions: () => before,
      writeIntent: () => {},
      clearIntent: () => {
        cleared = true
      },
    })
    expect(readFileSync(paths.target, 'utf8')).toBe('new')
    expect(existsSync(paths.prior)).toBe(false)
    expect(cleared).toBe(true)
  } finally {
    rmSync(paths.root, { recursive: true, force: true })
  }
})

test('a failed restore leaves the intent and names the manual rename paths', () => {
  const paths = stagedReleaseTest()
  let cleared = false
  try {
    expect(() =>
      applyStagedRelease({
        ...paths,
        migrate: () => {
          rmSync(paths.prior)
          mkdirSync(paths.prior)
          writeFileSync(join(paths.prior, 'occupied'), 'block restore')
          throw new Error('migration broke')
        },
        positions: () => before,
        writeIntent: () => {},
        clearIntent: () => {
          cleared = true
        },
      }),
    ).toThrow(`manually rename ${paths.prior} to ${paths.target}`)
    expect(cleared).toBe(false)
  } finally {
    rmSync(paths.root, { recursive: true, force: true })
  }
})

test('unreadable positions refuse before either binary moves', () => {
  const paths = stagedReleaseTest()
  try {
    expect(() =>
      applyStagedRelease({
        ...paths,
        positions: () => null,
        writeIntent: () => {},
        clearIntent: () => {},
      }),
    ).toThrow('store journal positions could not be read before update')
    expect(readFileSync(paths.target, 'utf8')).toBe('original')
    expect(readFileSync(paths.staged, 'utf8')).toBe('new')
    expect(existsSync(paths.prior)).toBe(false)
  } finally {
    rmSync(paths.root, { recursive: true, force: true })
  }
})

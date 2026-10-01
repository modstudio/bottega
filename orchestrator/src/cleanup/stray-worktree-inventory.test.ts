import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { dir } from '../../test/fixtures/store.ts'
import {
  archiveStrayWorktreeDirectory,
  inventoryStrayWorktreeDirectories,
  type StrayWorktreeDirectory,
} from './stray-worktree-inventory.ts'

test('inventory preserves a pointer claim when its target disappears during resolution', () => {
  const projectPath = join(dir, 'stray-pointer-race')
  const root = join(projectPath, '.claude', 'worktrees')
  const candidate = join(root, 'claimed')
  mkdirSync(candidate, { recursive: true })
  const initialized = Bun.spawnSync(['git', 'init', '-q', projectPath])
  expect(initialized.exitCode).toBe(0)
  const database = {
    query: () => ({ all: () => [{ path: candidate }] }),
  } as unknown as Database

  try {
    const inventory = inventoryStrayWorktreeDirectories({
      project: { name: 'example', path: projectPath },
      database,
      canonicalizePointer: () => {
        throw new Error('pointer disappeared')
      },
    })
    expect(inventory.errors).toEqual([])
    expect(inventory.directories).toHaveLength(1)
    expect(inventory.directories[0]?.claimed).toBe(true)
    expect(inventory.directories[0]?.decision).toBe('keep-claimed')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('archive refuses a destination escaped by a dot-segment project name', () => {
  const fixture = join(dir, 'stray-archive-escape')
  const root = join(fixture, 'project', '.claude', 'worktrees')
  const source = join(root, 'stray')
  const runsDirectory = join(fixture, 'state', 'orchestrator', 'runs')
  mkdirSync(source, { recursive: true })
  const directory: StrayWorktreeDirectory = {
    project: '../../outside',
    root,
    path: source,
    name: 'stray',
    modifiedMs: 0,
    ageMs: Number.MAX_SAFE_INTEGER,
    claimed: false,
    established: true,
    reason: null,
    decision: 'archive',
  }

  try {
    const result = archiveStrayWorktreeDirectory({
      directory,
      runsDirectory,
      now: new Date('2026-10-01T12:00:00.000Z'),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('is not strictly inside')
    expect(existsSync(source)).toBe(true)
    expect(existsSync(join(fixture, 'state', 'archive', 'outside'))).toBe(false)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

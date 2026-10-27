import { afterAll, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyWalWriteLockSamples,
  probeWalWriteLock,
  sampleWalWriteLock,
} from './store-write-lock.ts'

const dir = mkdtempSync(join(tmpdir(), 'store-write-lock-test-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('WAL write-lock samples distinguish free, contended, and held', () => {
  expect(classifyWalWriteLockSamples([null, null, null])).toEqual({
    classification: 'free',
    holderPid: null,
  })
  expect(classifyWalWriteLockSamples([null, 41, null])).toEqual({
    classification: 'contended',
    holderPid: 41,
  })
  expect(classifyWalWriteLockSamples([41, 42, 42])).toEqual({
    classification: 'contended',
    holderPid: 42,
  })
  expect(classifyWalWriteLockSamples([41, 41, 41])).toEqual({
    classification: 'held',
    holderPid: 41,
  })
})

test('a missing shared-memory file has no WAL write-lock holder', async () => {
  const path = join(dir, 'missing-lock-store.db')
  const probe = probeWalWriteLock(path)
  if (probe !== null && typeof probe === 'object') {
    expect(probe.reason).toContain('unsupported')
    return
  }
  expect(probe).toBeNull()
  expect(await sampleWalWriteLock(path, 2, 0)).toEqual({
    supported: true,
    classification: 'free',
    holderPid: null,
    sampleCount: 2,
    samples: [null, null],
  })
})

test('a free WAL store has no write-lock holder', () => {
  const path = join(dir, 'free-lock-store.db')
  const store = new Database(path)
  try {
    store.exec('PRAGMA journal_mode = WAL;')
    store.exec('CREATE TABLE probe (id INTEGER)')
    store.exec('INSERT INTO probe VALUES (1)')
    const probe = probeWalWriteLock(path)
    if (probe !== null && typeof probe === 'object') {
      expect(probe.reason).toContain('unsupported')
      return
    }
    expect(probe).toBeNull()
  } finally {
    store.close()
  }
})

test('an unopenable shared-memory file is an unsupported probe instead of an exception', () => {
  const path = join(dir, 'unopenable-lock-store.db')
  mkdirSync(`${path}-shm`)
  try {
    const probe = probeWalWriteLock(path)
    if (probe !== null && typeof probe === 'object' && probe.reason.includes('unsupported on')) {
      expect(probe.reason).toContain('unsupported')
      return
    }
    expect(probe).toEqual({
      unsupported: true,
      reason: expect.stringContaining(`cannot open ${path}-shm`),
    })
  } finally {
    rmSync(`${path}-shm`, { recursive: true })
  }
})

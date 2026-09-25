import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { dir } from '../../test/preload.ts'
import { db } from './db.ts'
import {
  classifyWalWriteLockSamples,
  probeWalWriteLock,
  sampleWalWriteLock,
} from './store-write-lock.ts'

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
  db()
  const probe = probeWalWriteLock(process.env.ORCH_DB!)
  if (probe !== null && typeof probe === 'object') {
    expect(probe.reason).toContain('unsupported')
    return
  }
  expect(probe).toBeNull()
})

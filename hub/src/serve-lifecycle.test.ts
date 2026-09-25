import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATE_HOME_ENV } from '../../shared/state-directory.ts'
import {
  type ServeRecord,
  serveDownDecision,
  serveRecordPath,
  serveStopDecision,
} from './serve-lifecycle.ts'

const record: ServeRecord = {
  pid: 123,
  port: 7778,
  checkout: '/worktrees/this-one',
  startTime: 'Mon Jan 01 00:00:00 2024',
  startedAt: '2024-01-01T00:00:00.000Z',
}

const checkout = '/worktrees/this-one'
const ownOwner = {
  pid: 123,
  command: 'bun --no-env-file hub/src/cli.ts serve --port 7778',
  cwd: checkout,
  startTime: record.startTime,
}

describe('serve down decisions', () => {
  test('passes only when the connection is positively refused', () => {
    expect(serveDownDecision('refused', null, checkout, record)).toEqual({
      kind: 'down',
      owners: [],
    })
  })

  test("fails for this checkout's listener", () => {
    expect(serveDownDecision('accepted', [ownOwner], checkout, record).kind).toBe('own')
    expect(serveDownDecision('inconclusive', [ownOwner], checkout, record).kind).toBe('own')
  })

  test('passes and retains the owner note for a foreign listener', () => {
    const foreign = {
      ...ownOwner,
      pid: 456,
      command: 'postgres -D /data',
      cwd: '/data',
    }
    expect(serveDownDecision('accepted', [foreign], checkout, record)).toEqual({
      kind: 'foreign',
      owners: [foreign],
    })
  })

  test("does not treat another checkout's matching serve record as its own", () => {
    const foreign = {
      ...ownOwner,
      command: 'bun hub/src/cli.ts serve',
      cwd: '/worktrees/other',
    }
    expect(
      serveDownDecision('accepted', [foreign], checkout, {
        ...record,
        checkout: '/worktrees/other',
      }),
    ).toEqual({ kind: 'foreign', owners: [foreign] })
  })

  test('fails when a listener owner cannot be identified', () => {
    expect(serveDownDecision('accepted', null, checkout, record).kind).toBe('unknown')
    expect(serveDownDecision('inconclusive', null, checkout, record).kind).toBe('unknown')
    expect(
      serveDownDecision(
        'accepted',
        [{ ...ownOwner, pid: 456, command: null, cwd: null, startTime: null }],
        checkout,
        record,
      ).kind,
    ).toBe('unknown')
  })
})

describe('serve stop decisions', () => {
  test('distinguishes absence, exit, owned identity, and a foreign process', () => {
    expect(serveStopDecision(null, false, null)).toBe('none')
    expect(serveStopDecision(record, false, null)).toBe('exited')
    expect(serveStopDecision(record, true, record.startTime)).toBe('stop')
    expect(serveStopDecision(record, true, 'Tue Jan 02 00:00:00 2024')).toBe('foreign')
    expect(serveStopDecision(record, true, null)).toBe('foreign')
  })
})

test('the serve record belongs to the explicit state root, not the working directory', () => {
  const original = process.cwd()
  const elsewhere = mkdtempSync(join(tmpdir(), 'hub-serve-path-'))
  const env = { [STATE_HOME_ENV]: join(elsewhere, 'state') }
  const before = serveRecordPath(7778, env)
  try {
    process.chdir(elsewhere)
    expect(serveRecordPath(7778, env)).toBe(before)
  } finally {
    process.chdir(original)
    rmSync(elsewhere, { recursive: true })
  }
  expect(before).toBe(join(elsewhere, 'state', 'hub', '.serve', '7778.json'))
})

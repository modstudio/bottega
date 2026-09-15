import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ServeRecord,
  servePortIsFree,
  serveRecordPath,
  serveStopDecision,
} from './serve-lifecycle.ts'

const record: ServeRecord = {
  pid: 123,
  port: 7778,
  startTime: 'Mon Jan 01 00:00:00 2024',
  startedAt: '2024-01-01T00:00:00.000Z',
}

describe('serve stop decisions', () => {
  test('distinguishes absence, exit, owned identity, and a foreign process', () => {
    expect(serveStopDecision(null, false, null)).toBe('none')
    expect(serveStopDecision(record, false, null)).toBe('exited')
    expect(serveStopDecision(record, true, record.startTime)).toBe('stop')
    expect(serveStopDecision(record, true, 'Tue Jan 02 00:00:00 2024')).toBe('foreign')
    expect(serveStopDecision(record, true, null)).toBe('foreign')
  })
})

test('the serve record belongs to the module checkout, not the working directory', () => {
  const original = process.cwd()
  const elsewhere = mkdtempSync(join(tmpdir(), 'hub-serve-path-'))
  const before = serveRecordPath(7778)
  try {
    process.chdir(elsewhere)
    expect(serveRecordPath(7778)).toBe(before)
  } finally {
    process.chdir(original)
    rmSync(elsewhere, { recursive: true })
  }
  expect(before).toEndWith('/hub/.serve/7778.json')
})

test('the port check observes an in-process listener going down', async () => {
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data() {} },
  })
  const port = listener.port
  try {
    expect(await servePortIsFree(port)).toBe(false)
  } finally {
    listener.stop(true)
  }
  expect(await servePortIsFree(port)).toBe(true)
})

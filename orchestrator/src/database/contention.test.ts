import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { insertContention } from './contention.ts'
import { db } from './db.ts'

describe('contention ledger', () => {
  test('contention writes enqueue their record', () => {
    insertContention(db(), {
      resourceKind: 'cpu',
      resourceKey: 'fixture',
      eventKind: 'timeout',
      durationMs: 5,
    })
    expect(
      db()
        .query("SELECT resource_kind, event_kind FROM contention WHERE resource_key='fixture'")
        .get(),
    ).toEqual({ resource_kind: 'cpu', event_kind: 'timeout' })
    const outbox = db()
      .query<{ kind: string; payload: string }, []>(
        "SELECT kind,payload FROM outbox WHERE kind='contention' ORDER BY id DESC LIMIT 1",
      )
      .get()!
    expect(outbox.kind).toBe('contention')
    expect(JSON.parse(outbox.payload)).toMatchObject({
      resourceKind: 'cpu',
      resourceKey: 'fixture',
      eventKind: 'timeout',
    })
  })
})

describe('one-shot contention writes honor the stale-schema invariant', () => {
  test('a busy_timeout-0 write after another process bumped user_version records nothing', () => {
    expect(db()).toBeDefined()
    const { tryWriteContention, DB_PATH: path } = require('./db.ts') as typeof import('./db.ts')
    const other = new Database(path, { readwrite: true, create: false })
    const before = (other.query('PRAGMA user_version').get() as { user_version: number })
      .user_version
    try {
      other.exec(`PRAGMA user_version = ${before + 1}`)
      tryWriteContention(
        {
          sessionId: 'stale-writer',
          resourceKind: 'lock',
          resourceKey: 'landing',
          eventKind: 'timeout',
          cause: 'stale schema probe',
        },
        { busyTimeoutMs: 0 },
      )
      expect(
        db().query("SELECT 1 FROM contention WHERE session_id='stale-writer'").get(),
      ).toBeNull()
      other.exec(`PRAGMA user_version = ${before}`)
      tryWriteContention(
        {
          sessionId: 'current-writer',
          resourceKind: 'lock',
          resourceKey: 'landing',
          eventKind: 'timeout',
          cause: 'current schema probe',
        },
        { busyTimeoutMs: 0 },
      )
      expect(
        db().query("SELECT 1 FROM contention WHERE session_id='current-writer'").get(),
      ).not.toBeNull()
    } finally {
      other.close()
    }
  })
})

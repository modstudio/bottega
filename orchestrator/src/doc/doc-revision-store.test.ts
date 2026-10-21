import { afterEach, describe, expect, test } from 'bun:test'
import type { SecurityRunner } from '../../../shared/keychain.ts'
import { db } from '../database/db.ts'
import { RECORD_SESSION_KEY } from '../record/record-auth.ts'
import { rememberSignedInRecordUser } from '../record/record-session.ts'
import { decideDocRevisionAuthor } from './doc-revision-store.ts'
import { listDocRevisions, setDoc } from './docs.ts'

const SECURITY_RUNNER_KEY = Symbol.for('orch.security-runner')
const securityHolder = globalThis as typeof globalThis & {
  [SECURITY_RUNNER_KEY]?: SecurityRunner
}

afterEach(() => {
  delete securityHolder[SECURITY_RUNNER_KEY]
})

describe('document revision author', () => {
  test('uses the session when nobody is signed in', () => {
    expect(decideDocRevisionAuthor({ signedInUserId: null, session: 'session-1' })).toBe(
      'session-1',
    )
  })

  test('uses unknown when nobody is signed in and there is no session', () => {
    expect(decideDocRevisionAuthor({ signedInUserId: null, session: null })).toBe('unknown')
  })

  test('the real write path stores the signed-in user and session while preserving an explicit author', async () => {
    let keychainToken: string | null = 'fixture-record-token'
    securityHolder[SECURITY_RUNNER_KEY] = (argv, stdin) => {
      if (argv[1] === 'find-generic-password') {
        return keychainToken
          ? {
              exitCode: 0,
              stdout: new TextEncoder().encode(`${keychainToken}\n`),
              stderr: new Uint8Array(),
            }
          : { exitCode: 44, stdout: new Uint8Array(), stderr: new Uint8Array() }
      }
      keychainToken = new TextDecoder().decode(stdin).trim().split('\n')[0] ?? null
      return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }
    }
    db()
      .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
      .run(RECORD_SESSION_KEY, 'fixture-record-token')
    rememberSignedInRecordUser({
      id: 'user-1',
      name: 'Ada Lovelace',
      email: 'ada@example.test',
    })
    process.env.CLAUDE_CODE_SESSION_ID = 'harness-session'

    const created = await setDoc({
      scope: 'global',
      subject: null,
      slug: 'revision-author',
      title: 'Revision author',
      body: 'First.',
      delivery: 'demand',
      reason: 'created',
    })
    await setDoc({
      scope: 'global',
      subject: null,
      slug: created.slug,
      title: created.title,
      body: 'Second.',
      delivery: created.delivery,
      reason: 'updated',
      author: 'Release operator',
      expectedRevision: created.revision!,
    })

    expect(listDocRevisions('global', null, created.slug).map(({ author }) => author)).toEqual([
      'Release operator',
      'user-1',
    ])
    expect(
      db()
        .query<{ author: string; session_id: string | null }, [string]>(
          'SELECT author, session_id FROM doc_revision WHERE slug=? ORDER BY number',
        )
        .all(created.slug),
    ).toEqual([
      { author: 'user-1', session_id: 'harness-session' },
      { author: 'Release operator', session_id: 'harness-session' },
    ])
  })
})

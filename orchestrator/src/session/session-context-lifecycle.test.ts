import { afterEach, expect, test } from 'bun:test'
import { encodeContextItem } from '../../test/fixtures/context-item.ts'
import { setDoc } from '../../test/fixtures/docs.ts'
import { db } from '../database/db.ts'
import { sessionContextItems } from '../doc/context-service.ts'
import { CONTEXT_FACTS_PORTS_KEY, type ContextFactsPorts } from '../doc/context-write-adapter.ts'
import { closeOutSessionContext } from './session-context-lifecycle.ts'

const globals = globalThis as typeof globalThis & {
  [CONTEXT_FACTS_PORTS_KEY]?: ContextFactsPorts
}

afterEach(() => {
  delete globals[CONTEXT_FACTS_PORTS_KEY]
})

async function addSessionFact(session: string): Promise<void> {
  globals[CONTEXT_FACTS_PORTS_KEY] = {
    tasks: async () => [],
    task: async () => null,
    pointer: async () => null,
  }
  const previous = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = session
  try {
    await setDoc({
      scope: 'context',
      subject: `session:${session}`,
      slug: 'fact',
      title: 'fact',
      body: encodeContextItem({ kind: 'fact', source: 'test', body: 'carry this fact' }),
    })
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = previous
  }
}

test('ordinary close-out empties the session holder', async () => {
  const session = 'ordinary-context-close-out'
  await addSessionFact(session)

  const report = await closeOutSessionContext({
    session,
    dryRun: false,
    resume: false,
    database: db(),
  })

  expect(report.process).toEqual([])
  expect(sessionContextItems(session, db())).toEqual([])
})

test('resume keeps the session holder', async () => {
  const session = 'resume-context-close-out'
  await addSessionFact(session)

  const report = await closeOutSessionContext({
    session,
    dryRun: false,
    resume: true,
    database: db(),
  })

  expect(report.kept).toEqual([`context session:${session}/fact (fact)`])
  expect(sessionContextItems(session, db())).toHaveLength(1)
})

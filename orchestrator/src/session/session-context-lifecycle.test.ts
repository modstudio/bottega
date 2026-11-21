import { afterEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
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

async function addSessionItem(
  session: string,
  kind: 'fact' | 'ruling' = 'fact',
  source = 'test',
  body = 'carry this fact',
): Promise<void> {
  globals[CONTEXT_FACTS_PORTS_KEY] = {
    task: async () => null,
    lookup: async () => null,
    record: async () => null,
    children: async () => [],
    pointer: async () => null,
  }
  const previous = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = session
  try {
    await setDoc({
      scope: 'context',
      subject: `session:${session}`,
      slug: kind,
      title: kind,
      body: encodeContextItem({ kind, source, body }),
    })
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = previous
  }
}

const addSessionFact = (session: string) => addSessionItem(session)

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
  expect(await sessionContextItems(session, db())).toEqual([])
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
  expect(await sessionContextItems(session, db())).toHaveLength(1)
})

test('a ruling item produces only its exact refusal process line', async () => {
  const session = 'ruling-context-close-out'
  await addSessionItem(session, 'ruling', 'q6600', 'Keep the refusal distinct.')

  const report = await closeOutSessionContext({
    session,
    dryRun: false,
    resume: false,
    database: db(),
  })

  expect(report.process).toEqual([
    {
      item: `context session:${session}/ruling (ruling)`,
      reason: 'session close-out refused because ruling must move to a task or epic',
      evidence: 'Keep the refusal distinct.',
      remedy: `${PLATFORM_SLUG} agent context set --task <KEY> --kind ruling --id ruling --source "q6600" "Keep the refusal distinct." && ${PLATFORM_SLUG} agent context drop --session ${session} --id ruling`,
    },
  ])
})

test('reports the exact ordinary item inserted after the drop loop', async () => {
  const session = 'remaining-context-close-out'
  await addSessionFact(session)

  const closing = closeOutSessionContext({
    session,
    dryRun: false,
    resume: false,
    database: db(),
  })
  db()
    .query(
      `INSERT INTO context_item
      (record_id,holder_kind,holder_id,slug,kind,body,source,created_at,updated_at)
     VALUES (?,'session',?,'late','fact','arrived after drops','test','2026-11-15','2026-11-15')`,
    )
    .run(crypto.randomUUID(), session)
  const report = await closing

  expect(report.process).toEqual([
    {
      item: `context session:${session}`,
      reason: 'session close-out left 1 context item on the session holder',
      evidence: 'late (fact)',
      remedy: `${PLATFORM_SLUG} agent context show --session ${session}`,
    },
  ])
})

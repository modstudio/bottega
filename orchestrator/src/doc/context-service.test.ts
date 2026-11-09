import { afterEach, describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { removeDoc, setDoc } from '../../test/fixtures/docs.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import type { SecretScanner } from '../secret-scan/secret-scan.ts'
import { encodeContextItem } from './context-item-codec.ts'
import { getContext, setContextItem } from './context-service.ts'
import {
  CONTEXT_FACTS_PORTS_KEY,
  type ContextFactsPorts,
  resolveContextTask,
} from './context-write-adapter.ts'
import { DOC_SECRET_SCANNER_KEY } from './doc-secret-scan.ts'
import { importDoc, listDocMetadata, listDocs } from './docs.ts'

const globals = globalThis as typeof globalThis & {
  [CONTEXT_FACTS_PORTS_KEY]?: ContextFactsPorts
  [DOC_SECRET_SCANNER_KEY]?: SecretScanner
}
const task = { key: 'DEV-1844', record_id: newRecordId(), project: PLATFORM_SLUG }
const tasks: ContextFactsPorts = {
  tasks: async (project) => (project === PLATFORM_SLUG ? [task] : []),
  task: async () => null,
  pointer: async () => null,
}

afterEach(() => {
  delete globals[CONTEXT_FACTS_PORTS_KEY]
  globals[DOC_SECRET_SCANNER_KEY] = () => ({ status: 'clean' })
})

describe('context document integration', () => {
  test('refuses a key whose prefix no registered project declares', async () => {
    await expect(resolveContextTask('UNKNOWN-1')).rejects.toThrow(
      `task key prefix "UNKNOWN" is not declared by exactly one registered project; inspect prefixes with ${PLATFORM_SLUG} project list --json`,
    )
  })

  test('resolves a mirror hit without pulling and pulls a single task after a mirror miss', async () => {
    upsertProject({
      recordId: newRecordId(),
      name: 'resolution-fixture',
      path: '/tmp/resolution-fixture',
      settings: { keyPrefixes: ['MIR'] },
    })
    const mirrored = { key: 'MIR-1', record_id: newRecordId(), project: 'resolution-fixture' }
    const pulled = { key: 'MIR-2', record_id: newRecordId(), project: 'resolution-fixture' }
    const pulledKeys: string[] = []
    const ports: ContextFactsPorts = {
      tasks: async () => [mirrored],
      task: async (_project, key) => {
        pulledKeys.push(key)
        return key === pulled.key ? pulled : null
      },
      pointer: async () => null,
    }
    expect(await resolveContextTask(mirrored.key, db(), ports)).toEqual(mirrored)
    expect(pulledKeys).toEqual([])
    expect(await resolveContextTask(pulled.key, db(), ports)).toEqual(pulled)
    expect(pulledKeys).toEqual([pulled.key])
  })

  test('a failed fresh pull refuses without writing context', async () => {
    upsertProject({
      recordId: newRecordId(),
      name: 'pull-failure',
      path: '/tmp/pull-failure',
      settings: { keyPrefixes: ['FAIL'] },
    })
    globals[CONTEXT_FACTS_PORTS_KEY] = {
      tasks: async () => [],
      task: async () => {
        throw new Error('tracker unavailable')
      },
      pointer: async () => null,
    }
    await expect(
      setContextItem({
        task: 'FAIL-1',
        id: 'next',
        kind: 'next-action',
        source: 'run:1',
        body: 'Continue.',
      }),
    ).rejects.toThrow(
      `could not read task data for project pull-failure: tracker unavailable; retry: ${PLATFORM_SLUG} task show FAIL-1 --project pull-failure --fresh --json`,
    )
    expect(listDocs({ scope: 'context' })).toEqual([])
  })

  test('uses per-item compare-and-set and names the stale item and revision', async () => {
    globals[CONTEXT_FACTS_PORTS_KEY] = tasks
    const body = encodeContextItem({
      kind: 'next-action',
      source: 'run:1',
      body: 'Continue the slice.',
    })
    const first = await setDoc({
      scope: 'context',
      subject: `task:${task.record_id}`,
      slug: 'next',
      title: 'next',
      body,
      delivery: 'demand',
      contextTask: task,
    })
    const second = await setDoc({
      scope: 'context',
      subject: `task:${task.record_id}`,
      slug: 'next',
      title: 'next',
      body: body.replace('Continue', 'Finish'),
      delivery: 'demand',
      expectedRevision: first.revision!,
      contextTask: task,
    })
    await expect(
      setDoc({
        scope: 'context',
        subject: `task:${task.record_id}`,
        slug: 'next',
        title: 'next',
        body,
        delivery: 'demand',
        expectedRevision: first.revision!,
        contextTask: task,
      }),
    ).rejects.toThrow(new RegExp(`context item next:.*current revision ${second.revision}`, 's'))
    await expect(
      setDoc({
        scope: 'context',
        subject: `task:${task.record_id}`,
        slug: 'next',
        title: 'next',
        body,
        delivery: 'demand',
        contextTask: task,
      }),
    ).rejects.toThrow(`context set --id next --expected-revision ${second.revision}`)
  })

  test('every write verb applies the context policy, not only set', async () => {
    globals[CONTEXT_FACTS_PORTS_KEY] = tasks
    await setDoc({
      scope: 'context',
      subject: `task:${task.record_id}`,
      slug: 'next',
      title: 'next',
      body: encodeContextItem({ kind: 'next-action', source: 'run:1', body: 'Continue.' }),
      delivery: 'demand',
      contextTask: task,
    })
    await expect(
      removeDoc('context', `task:${task.record_id}`, 'next', {
        reason: 'test delete',
        contextTask: task,
      }),
    ).rejects.toThrow('cannot remove the last required next-action item')
    await expect(
      importDoc({
        scope: 'context',
        subject: `task:${task.record_id}`,
        slug: 'raw',
        title: 'raw',
        body: 'No frontmatter.',
        reason: 'test import',
        contextTask: task,
      }),
    ).rejects.toThrow('requires YAML frontmatter')
  })

  test('document writes cannot bypass resolved task-holder identity', async () => {
    globals[CONTEXT_FACTS_PORTS_KEY] = tasks
    const holder = `task:${task.record_id}`
    const body = encodeContextItem({ kind: 'fact', source: 'test', body: 'Cannot bypass.' })
    const write = (contextTask?: typeof task) =>
      setDoc({
        scope: 'context',
        subject: holder,
        slug: 'bypass',
        title: 'bypass',
        body,
        delivery: 'demand',
        contextTask,
      })

    await expect(write()).rejects.toThrow(`${PLATFORM_SLUG} agent context set --task <KEY>`)
    await expect(write({ ...task, record_id: newRecordId() })).rejects.toThrow(
      `${PLATFORM_SLUG} agent context set --task <KEY>`,
    )
    expect(listDocs({ scope: 'context' })).toEqual([])
  })

  test("a session write skips an unreadable claimed task's project", async () => {
    const owner = newRecordId()
    const previousSession = process.env.CLAUDE_CODE_SESSION_ID
    process.env.CLAUDE_CODE_SESSION_ID = owner
    const project = `unreadable-claim-${newRecordId()}`
    upsertProject({
      recordId: newRecordId(),
      name: project,
      path: `/tmp/${project}`,
      settings: { keyPrefixes: ['UNREADABLE'] },
    })
    const now = Date.now()
    db()
      .query(
        `INSERT INTO board_claim
         (record_id,project,subject_kind,subject_value,holder_kind,holder_session,duration_ms,taken_at,renewed_at,lapses_at,closed_at,close_reason)
         VALUES (?,?,'task','UNREADABLE-1','architect',?,3600000,?,?,?,NULL,NULL)`,
      )
      .run(
        newRecordId(),
        project,
        owner,
        new Date(now - 1_000).toISOString(),
        new Date(now - 1_000).toISOString(),
        new Date(now + 3_600_000).toISOString(),
      )
    globals[CONTEXT_FACTS_PORTS_KEY] = {
      ...tasks,
      tasks: async (readProject) => {
        if (readProject === project) throw new Error('tracker unavailable')
        return []
      },
    }

    try {
      const written = await setContextItem({
        session: owner,
        id: 'session-fact',
        kind: 'fact',
        source: 'test',
        body: 'Keep this session fact.',
      })

      expect(written).toMatchObject({ holder: `session:${owner}`, id: 'session-fact' })
    } finally {
      if (previousSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = previousSession
    }
  })

  test('fails closed for context while ordinary docs warn and write', async () => {
    globals[CONTEXT_FACTS_PORTS_KEY] = tasks
    globals[DOC_SECRET_SCANNER_KEY] = () => ({ status: 'unavailable', reason: 'scanner offline' })
    await expect(
      setDoc({
        scope: 'context',
        subject: `task:${task.record_id}`,
        slug: 'next',
        title: 'next',
        body: encodeContextItem({ kind: 'next-action', source: 'run:1', body: 'Continue.' }),
        delivery: 'demand',
        contextTask: task,
      }),
    ).rejects.toThrow('context writes fail closed')

    upsertProject({ recordId: newRecordId(), name: 'context-secret-warning', path: '/tmp/project' })
    const ordinary = await setDoc({
      scope: 'project',
      subject: 'context-secret-warning',
      slug: 'ordinary',
      title: 'Ordinary',
      body: 'Allowed with warning.',
    })
    expect(ordinary.writeWarnings?.[0]).toContain('write allowed unchecked')
  })

  test('stores and shows another registered project task by record id while displaying its key', async () => {
    const star = { key: 'STAR-6450', record_id: newRecordId(), project: 'starship' }
    const child = {
      key: 'STAR-6451',
      record_id: newRecordId(),
      project: 'starship',
      parent_key: star.key,
    }
    upsertProject({
      recordId: newRecordId(),
      name: 'starship',
      path: '/tmp/starship',
      settings: { keyPrefixes: ['STAR'] },
    })
    globals[CONTEXT_FACTS_PORTS_KEY] = {
      ...tasks,
      tasks: async (project) => (project === 'starship' ? [star, child] : []),
    }
    const written = await setContextItem({
      task: star.key,
      id: 'next',
      kind: 'next-action',
      source: 'run:1',
      body: 'Continue.',
    })
    expect(written).toMatchObject({ holder: `task:${star.record_id}`, task: star.key })
    expect(await getContext({ task: star.key })).toMatchObject({
      holder: `task:${star.record_id}`,
      task: star.key,
      profile: 'epic',
      items: [{ id: 'next', holder: `task:${star.record_id}` }],
    })
  })

  test('legacy key-shaped context remains removable through the document verb', async () => {
    const body = encodeContextItem({ kind: 'fact', source: 'legacy', body: 'Move this by hand.' })
    const documentId = newRecordId()
    const revisionId = newRecordId()
    const at = new Date().toISOString()
    db()
      .query(
        `INSERT INTO doc
         (record_id,scope,subject,slug,title,body,delivery,audiences,created_at,updated_at)
         VALUES (?,'context','task:DEV-OLD','legacy','legacy',?,'demand','["technical"]',?,?)`,
      )
      .run(documentId, body, at, at)
    db()
      .query(
        `INSERT INTO doc_revision
         (record_id,number,doc_record_id,scope,subject,slug,op,title,body,delivery,author,reason,at,audiences)
         VALUES (?,1,?,'context','task:DEV-OLD','legacy','create','legacy',?,'demand','test','legacy fixture',?,'["technical"]')`,
      )
      .run(revisionId, documentId, body, at)
    expect(
      await removeDoc('context', 'task:DEV-OLD', 'legacy', {
        reason: 'move legacy context',
        expectedRevision: revisionId,
      }),
    ).toBe(true)
  })

  test('refuses a write to a session holder by any other session', async () => {
    globals[CONTEXT_FACTS_PORTS_KEY] = tasks
    const other = newRecordId()
    await expect(
      setDoc({
        scope: 'context',
        subject: `session:${other}`,
        slug: 'next',
        title: 'next',
        body: encodeContextItem({ kind: 'next-action', source: 'run:1', body: 'Continue.' }),
        delivery: 'demand',
      }),
    ).rejects.toThrow(`only owning session ${other} may write session:${other}`)
  })

  test('default document listing excludes context', async () => {
    globals[CONTEXT_FACTS_PORTS_KEY] = tasks
    await setDoc({
      scope: 'context',
      subject: `task:${task.record_id}`,
      slug: 'next',
      title: 'next',
      body: encodeContextItem({ kind: 'next-action', source: 'run:1', body: 'Continue.' }),
      delivery: 'demand',
      contextTask: task,
    })
    expect(listDocMetadata().some((doc) => doc.scope === 'context')).toBe(false)
    expect(listDocs().some((doc) => doc.scope === 'context')).toBe(false)
    expect(listDocs({ scope: 'context' })).toHaveLength(1)
    expect(listDocMetadata({ scope: 'context' })).toHaveLength(1)
  })
})

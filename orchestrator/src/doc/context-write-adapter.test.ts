import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { fixtureProjectRecordId, migratedTestDatabase } from '../database/test-database.fixture.ts'
import { RecordApiRequestError } from '../record/record-api-client.ts'
import { productionWorkflowTextDocumentPorts } from '../workflow/workflow-text-copy.ts'
import {
  type ContextFactsPorts,
  type PointerTargetPorts,
  resolveContextTaskByRecordId,
  resolveContextTaskWithChildren,
  resolvedPointerTarget,
  taskProfile,
} from './context-write-adapter.ts'

function ports(document: PointerTargetPorts['document'] = async () => {}): PointerTargetPorts {
  return {
    document,
    task: async (key) => ({
      key,
      record_id: newRecordId(),
      project: PLATFORM_SLUG,
      commentIds: ['4'],
    }),
    taskDocument: async (pointer) => pointer,
    commit: (reference) => `resolved-${reference}`,
  }
}

test('context pointers dispatch the workflow evidence forms through the shared parser', async () => {
  const database = migratedTestDatabase()
  const projectId = fixtureProjectRecordId(database)
  const runId = newRecordId()
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id)
       VALUES (?,42,'2026-01-01','codex','implement','sha',1,'head','ok',?)`,
    )
    .run(runId, projectId)
  database
    .query(
      `INSERT INTO pull_request_ci
       (record_id,project,project_record_id,pr_number,record_kind,complete,recorded_at)
       VALUES (?,'run-fixture',?,91,'collection',1,'2026-01-01')`,
    )
    .run(newRecordId(), projectId)
  const probeId = newRecordId()
  database
    .query(
      `INSERT INTO probe
       (record_id,command,cwd,exit_code,output_tail,created_at,kind)
       VALUES (?,'[]','/fixture',0,'','2026-01-01','probe')`,
    )
    .run(probeId)
  const attachedTextId = newRecordId()
  database.exec('PRAGMA foreign_keys=OFF')
  database
    .query(
      `INSERT INTO workflow_step_text
       (record_id,cursor_record_id,step_ordinal,step_slug,body,created_at)
       VALUES (?,? ,0,'fixture','body','2026-01-01')`,
    )
    .run(attachedTextId, newRecordId())
  database.exec('PRAGMA foreign_keys=ON')

  const adapter = ports()
  await expect(resolvedPointerTarget('42', database, adapter)).resolves.toBe(runId)
  await expect(resolvedPointerTarget('#91', database, adapter)).resolves.toBe('91')
  await expect(resolvedPointerTarget('abc1234', database, adapter)).resolves.toBe(
    'resolved-abc1234',
  )
  await expect(resolvedPointerTarget('task:DEV-2473', database, adapter)).resolves.toBe(
    'task:DEV-2473',
  )
  await expect(resolvedPointerTarget('task:DEV-2473#comment:4', database, adapter)).resolves.toBe(
    'task:DEV-2473#comment:4',
  )
  await expect(resolvedPointerTarget('task:DEV-2473#comment:5', database, adapter)).rejects.toThrow(
    'not visible in task DEV-2473; pass a comment id on that task',
  )
  await expect(resolvedPointerTarget(`probe:${probeId}`, database, adapter)).resolves.toBe(
    `probe:${probeId}`,
  )
  await expect(resolvedPointerTarget(`probe:${newRecordId()}`, database, adapter)).rejects.toThrow(
    'not visible in this machine; pass the UUID of a visible record',
  )
  await expect(resolvedPointerTarget(`exec:${probeId}`, database, adapter)).rejects.toThrow(
    'not visible in this machine; pass the UUID of a visible record',
  )
  await expect(
    resolvedPointerTarget(`attached-text:${attachedTextId}`, database, adapter),
  ).resolves.toBe(`attached-text:${attachedTextId}`)
  await expect(
    resolvedPointerTarget(`attached-text:${newRecordId()}`, database, adapter),
  ).rejects.toThrow('not visible in this machine; pass the UUID of a visible record')
  await expect(resolvedPointerTarget('DEV-2473/6', database, adapter)).resolves.toBe('DEV-2473/6')
  await expect(resolvedPointerTarget('dev-2473/6', database, adapter)).resolves.toBe('DEV-2473/6')
  await expect(
    resolvedPointerTarget(`doc:project/${PLATFORM_SLUG}/identity`, database, adapter),
  ).resolves.toBe(`doc:project/${PLATFORM_SLUG}/identity`)

  await expect(resolvedPointerTarget('91', database, adapter)).rejects.toThrow(
    'pass #<n> for a pull request',
  )
  await expect(resolvedPointerTarget('92', database, adapter)).rejects.toThrow(
    'for a commit, pass the full SHA',
  )
  await expect(resolvedPointerTarget('run:92', database, adapter)).rejects.not.toThrow(
    'for a commit, pass the full SHA',
  )
  await expect(resolvedPointerTarget('run:91', database, adapter)).rejects.not.toThrow(
    'pass #<n> for a pull request',
  )
  for (const pointer of ['#92', 'https://github.com/example/project/pull/92'])
    await expect(resolvedPointerTarget(pointer, database, adapter)).rejects.toThrow(
      'reference is not visible in this project; no pull request #92 is recorded for this project; check the number',
    )
  database.close()
})

test('a missing task document keeps the not-visible refusal distinct', async () => {
  const database = migratedTestDatabase()
  const list = productionWorkflowTextDocumentPorts.list
  productionWorkflowTextDocumentPorts.list = async () => [
    { reference: 'DEV-2473/5', title: 'rulings' },
  ]
  try {
    await expect(resolvedPointerTarget('DEV-2473/6', database)).rejects.toThrow(
      `reference is not visible in task DEV-2473; pass a document number that \`${PLATFORM_SLUG} task doc list DEV-2473\` shows`,
    )
  } finally {
    productionWorkflowTextDocumentPorts.list = list
    database.close()
  }
})

test('an unreachable document store keeps the could-not-reach refusal distinct', async () => {
  const database = migratedTestDatabase()
  await expect(
    resolvedPointerTarget(
      `doc:project/${PLATFORM_SLUG}/identity`,
      database,
      ports(async () => {
        throw new Error('network unavailable')
      }),
    ),
  ).rejects.toThrow('could not reach the document store')
  database.close()
})

test('a document-store destination refusal preserves its remedy as a context refusal', async () => {
  const database = migratedTestDatabase()
  await expect(
    resolvedPointerTarget(
      `doc:project/${PLATFORM_SLUG}/identity`,
      database,
      ports(async () => {
        throw new RecordApiRequestError(
          'project has no declared record space; declare one before retrying',
          'refused',
          409,
        )
      }),
    ),
  ).rejects.toThrow('project has no declared record space; declare one before retrying')
  await expect(
    resolvedPointerTarget(
      `doc:project/${PLATFORM_SLUG}/identity`,
      database,
      ports(async () => {
        throw new RecordApiRequestError('membership is required; join the space', 'refused', 403)
      }),
    ),
  ).rejects.not.toThrow('could not reach')
  database.close()
})

test('a comment pointer refuses distinctly when the tracker cannot report comment ids', async () => {
  const database = migratedTestDatabase()
  const adapter = ports()
  adapter.task = async (key) => ({
    key,
    record_id: newRecordId(),
    project: PLATFORM_SLUG,
    commentIds: [],
    commentsVerifiable: false,
  })
  await expect(resolvedPointerTarget('task:DEV-2473#comment:4', database, adapter)).rejects.toThrow(
    "cannot be verified because this tracker's task read does not report comment ids; use task:DEV-2473",
  )
  database.close()
})

function contextFacts(record: ContextFactsPorts['record']): ContextFactsPorts {
  return {
    task: async () => null,
    lookup: async () => null,
    record,
    children: async () => [],
    pointer: async () => null,
  }
}

test('a missing task record returns null without a read failure', async () => {
  const database = migratedTestDatabase()
  const recordId = newRecordId()
  const result = await resolveContextTaskByRecordId(
    recordId,
    database,
    contextFacts(async () => {
      throw new Error(`no task record ${recordId.toUpperCase()}`)
    }),
  )

  expect(result).toEqual({ task: null, failure: null })
  database.close()
})

test('a task-record transport failure preserves its cause', async () => {
  const database = migratedTestDatabase()
  fixtureProjectRecordId(database)
  const result = await resolveContextTaskByRecordId(
    newRecordId(),
    database,
    contextFacts(async () => {
      throw new Error('record service unavailable')
    }),
  )

  expect(result.task).toBeNull()
  expect(result.failure).toBe('record service unavailable')
  database.close()
})

test('one task resolves by lookup and profiles only its direct children', async () => {
  const database = migratedTestDatabase()
  database
    .query(
      `INSERT INTO project (record_id,name,path,canon,settings)
       VALUES (?,'context-fixture','/tmp/context-fixture',0,'{"keyPrefixes":["CTX"]}')`,
    )
    .run(newRecordId())
  const calls = { pull: 0, lookup: [] as string[], children: [] as string[] }
  const parent = {
    key: 'CTX-1',
    record_id: newRecordId(),
    project: 'context-fixture',
  }
  const child = {
    key: 'CTX-2',
    record_id: newRecordId(),
    project: 'context-fixture',
    parent_key: parent.key,
  }
  const adapter: ContextFactsPorts = {
    task: async () => {
      calls.pull++
      return null
    },
    lookup: async (project, key) => {
      calls.lookup.push(`${project}:${key}`)
      return parent
    },
    record: async () => null,
    children: async (project, key) => {
      calls.children.push(`${project}:${key}`)
      return [child]
    },
    pointer: async () => null,
  }

  const resolved = await resolveContextTaskWithChildren('ctx-1', database, adapter)

  expect(resolved).toEqual({ task: parent, children: [child] })
  expect(taskProfile(resolved.task.key, resolved.children)).toBe('epic')
  expect(calls).toEqual({
    pull: 0,
    lookup: ['context-fixture:CTX-1'],
    children: ['context-fixture:CTX-1'],
  })
  database.close()
})

test('a direct-children read failure is a task read refusal', async () => {
  const database = migratedTestDatabase()
  database
    .query(
      `INSERT INTO project (record_id,name,path,canon,settings)
       VALUES (?,'context-fixture','/tmp/context-fixture',0,'{"keyPrefixes":["CTX"]}')`,
    )
    .run(newRecordId())
  const adapter = contextFacts(async () => null)
  adapter.lookup = async () => ({
    key: 'CTX-1',
    record_id: newRecordId(),
    project: 'context-fixture',
  })
  adapter.children = async () => {
    throw new Error('children unavailable')
  }

  await expect(resolveContextTaskWithChildren('CTX-1', database, adapter)).rejects.toThrow(
    'could not read task data for project context-fixture: children unavailable',
  )
  database.close()
})

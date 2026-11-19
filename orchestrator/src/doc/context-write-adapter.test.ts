import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { fixtureProjectRecordId, migratedTestDatabase } from '../database/test-database.fixture.ts'
import { type PointerTargetPorts, resolvedPointerTarget } from './context-write-adapter.ts'

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
  await expect(resolvedPointerTarget('DEV-2473/6', database, adapter)).resolves.toBe('DEV-2473/6')
  await expect(
    resolvedPointerTarget(`doc:project/${PLATFORM_SLUG}/identity`, database, adapter),
  ).resolves.toBe(`doc:project/${PLATFORM_SLUG}/identity`)

  await expect(resolvedPointerTarget('91', database, adapter)).rejects.toThrow(
    'pass #<n> for a pull request',
  )
  await expect(resolvedPointerTarget('92', database, adapter)).rejects.toThrow(
    'for a commit, pass the full SHA',
  )
  for (const pointer of ['#92', 'https://github.com/example/project/pull/92'])
    await expect(resolvedPointerTarget(pointer, database, adapter)).rejects.toThrow(
      'reference is not visible in this project; no pull request #92 is recorded for this project; check the number',
    )
  database.close()
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
  await expect(
    resolvedPointerTarget(
      `doc:project/${PLATFORM_SLUG}/identity`,
      database,
      ports(async () => {
        throw new Error('network unavailable')
      }),
    ),
  ).rejects.not.toThrow('does not resolve')
  database.close()
})

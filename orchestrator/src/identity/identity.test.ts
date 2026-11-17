import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { installRecordApiClient } from '../../test/fixtures/record-api.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import type { RecordApiClient } from '../record/record-api-client.ts'
import { type IdentityContext, resolve } from './identity.ts'
import { resolveLocalRun } from './identity-local-run.ts'

const addProject = (name: string): string => {
  const id = newRecordId()
  db()
    .query('INSERT INTO project(record_id,name,path,settings) VALUES (?,?,?,?)')
    .run(id, name, `/tmp/${name}`, '{}')
  return id
}

const addQuestion = (runId: string, number: number): string => {
  const id = newRecordId()
  db()
    .query(
      "INSERT INTO question(record_id,number,run_record_id,asked_at,question) VALUES (?,?,?,'2026-11-17','Which?')",
    )
    .run(id, number, runId)
  return id
}

test('resolver scopes labels to the caller project, crosses with a qualifier, and lets UUIDs resolve anywhere', async () => {
  const suffix = newRecordId().slice(-8)
  const alphaName = `alpha-${suffix}`
  const betaName = `beta-${suffix}`
  const alpha = addProject(alphaName)
  const beta = addProject(betaName)
  const alphaRun = addRun({ agent: 'codex', job: 'implement', projectRecordId: alpha })
  const betaRun = addRun({ agent: 'codex', job: 'implement', projectRecordId: beta })
  const alphaQuestion = addQuestion(alphaRun, 71_001)
  const betaQuestion = addQuestion(betaRun, 71_002)
  const context: IdentityContext = {
    database: db(),
    sessionId: 'caller',
    projectId: alpha,
    projectName: alphaName,
    machineNames: { shortName: 'mine', formerShortNames: ['old-mine'] },
    identityMap: new Map(),
  }

  expect((await resolve('q71001', context, 'question')).recordId).toBe(alphaQuestion)
  expect((await resolve(`${betaName}#q71002`, context, 'question')).recordId).toBe(betaQuestion)
  expect((await resolve(betaQuestion, context)).recordId).toBe(betaQuestion)
  await expect(resolve('q71002', context, 'question')).rejects.toThrow(
    `not visible in project ${alphaName}`,
  )
  await expect(resolve('other/q71001', context, 'question')).rejects.toThrow(
    'question references cannot use a machine qualifier; pass a <project>#q<number> reference',
  )
  await expect(resolve(`unregistered-${suffix}#q71001`, context, 'question')).rejects.toThrow(
    `project unregistered-${suffix} is not registered on this machine`,
  )
  await expect(resolve(`${betaName}#${betaQuestion}`, context)).rejects.toThrow(
    'a UUID takes no qualifier; pass it bare',
  )
  const missingId = newRecordId()
  await expect(resolve(missingId, context)).rejects.toThrow(
    'reference is not visible in any space you belong to',
  )
  await expect(resolve(missingId, context)).rejects.not.toThrow('pass the UUID')
})

test('a missing run UUID uses the UUID visibility refusal', () => {
  const missingId = newRecordId()
  expect(() => resolveLocalRun(db(), { kind: 'record-id', recordId: missingId })).toThrow(
    'reference is not visible in any space you belong to',
  )
})

test('resolver applies the existing machine-label decision before resolving runs', async () => {
  const runRecordId = addRun({ agent: 'codex', job: 'implement' })
  const { number } = db()
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(runRecordId)!
  const context: IdentityContext = {
    database: db(),
    sessionId: 'caller',
    projectId: null,
    projectName: null,
    machineNames: { shortName: 'mine', formerShortNames: ['old-mine'] },
    identityMap: new Map(),
  }

  await expect(resolve(`mine/r${number}`, context, 'run')).resolves.toMatchObject({
    kind: 'run',
    recordId: runRecordId,
  })
  await expect(resolve(`old-mine/r${number}`, context, 'run')).resolves.toMatchObject({
    recordId: runRecordId,
  })
  await expect(resolve(`other/r${number}`, context, 'run')).rejects.toThrow(
    "acts only on this machine's (`mine`) rows",
  )
  await expect(resolve(`project#r${number}`, context, 'run')).rejects.toThrow(
    'run references cannot use a project qualifier because run numbers are per machine',
  )
})

test('resolver uses a hosted cursor question project without a local cursor row', async () => {
  const suffix = newRecordId().slice(-8)
  const projectName = `hosted-${suffix}`
  const projectId = newRecordId()
  const questionId = newRecordId()
  const cursorId = newRecordId()
  const spaceId = newRecordId()
  db()
    .query('INSERT INTO project(record_id,name,path,settings) VALUES (?,?,?,?)')
    .run(projectId, projectName, `/tmp/${projectName}`, JSON.stringify({ space: projectName }))
  const previousRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  installRecordApiClient({
    whoami: async () => ({
      user: { id: newRecordId() },
      activeSpaceId: spaceId,
      personalSpaceId: null,
      memberships: [
        { space_id: spaceId, name: projectName, slug: projectName, permission: 'write' },
      ],
    }),
    readQuestions: async () => ({
      items: [
        {
          id: questionId,
          number: 71_003,
          workflow_cursor_record_id: cursorId,
          project_record_id: projectId,
        },
      ],
    }),
  } as unknown as RecordApiClient)
  try {
    const context: IdentityContext = {
      database: db(),
      sessionId: 'caller',
      projectId,
      projectName,
      machineNames: null,
      identityMap: new Map(),
    }
    expect(
      db().query('SELECT record_id FROM workflow_cursor WHERE record_id=?').get(cursorId),
    ).toBeNull()
    await expect(resolve('q71003', context, 'question')).resolves.toMatchObject({
      kind: 'question',
      recordId: questionId,
      projectId,
    })
  } finally {
    installRecordApiClient(null)
    if (previousRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = previousRecordApiUrl
  }
})

test('resolver keeps equal question numbers in their qualified project spaces', async () => {
  const suffix = newRecordId().slice(-8)
  const alphaName = `hosted-alpha-${suffix}`
  const betaName = `hosted-beta-${suffix}`
  const alphaProjectId = newRecordId()
  const betaProjectId = newRecordId()
  const alphaSpaceId = newRecordId()
  const betaSpaceId = newRecordId()
  const alphaQuestionId = newRecordId()
  const betaQuestionId = newRecordId()
  const number = 880_002
  for (const [projectId, projectName] of [
    [alphaProjectId, alphaName] as const,
    [betaProjectId, betaName] as const,
  ])
    db()
      .query('INSERT INTO project(record_id,name,path,settings) VALUES (?,?,?,?)')
      .run(projectId, projectName, `/tmp/${projectName}`, JSON.stringify({ space: projectName }))
  const previousRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  installRecordApiClient({
    whoami: async () => ({
      user: { id: newRecordId() },
      activeSpaceId: alphaSpaceId,
      personalSpaceId: null,
      memberships: [
        { space_id: alphaSpaceId, name: alphaName, slug: alphaName, permission: 'write' },
        { space_id: betaSpaceId, name: betaName, slug: betaName, permission: 'write' },
      ],
    }),
    readQuestions: async (
      _input: { read: string; number?: number },
      destination?: { destinationSpaceId: string },
    ) => ({
      items:
        destination?.destinationSpaceId === betaSpaceId
          ? [{ record_id: betaQuestionId, number, project_record_id: betaProjectId }]
          : [{ record_id: alphaQuestionId, number, project_record_id: alphaProjectId }],
    }),
  } as unknown as RecordApiClient)
  try {
    const context: IdentityContext = {
      database: db(),
      sessionId: 'caller',
      projectId: alphaProjectId,
      projectName: alphaName,
      machineNames: null,
      identityMap: new Map(),
    }
    await expect(resolve(`q${number}`, context, 'question')).resolves.toMatchObject({
      recordId: alphaQuestionId,
      projectId: alphaProjectId,
    })
    await expect(resolve(`${betaName}#q${number}`, context, 'question')).resolves.toMatchObject({
      recordId: betaQuestionId,
      projectId: betaProjectId,
    })
  } finally {
    installRecordApiClient(null)
    if (previousRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = previousRecordApiUrl
  }
})

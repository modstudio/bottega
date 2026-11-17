import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { type IdentityContext, resolve } from './identity.ts'

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
    identityMap: new Map(),
  }

  expect((await resolve('q71001', context, 'question')).recordId).toBe(alphaQuestion)
  expect((await resolve(`${betaName}#q71002`, context, 'question')).recordId).toBe(betaQuestion)
  expect((await resolve(betaQuestion, context)).recordId).toBe(betaQuestion)
  await expect(resolve('q71002', context, 'question')).rejects.toThrow(
    `not visible in project ${alphaName}`,
  )
  await expect(resolve('q71002', context, 'question')).rejects.not.toThrow('not found')
})

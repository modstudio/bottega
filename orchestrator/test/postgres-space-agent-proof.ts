import { expect, test } from 'bun:test'
import { newRecordId, RECORD_ACTOR_ROLE, RECORD_OWNER_ROLE } from '../../shared/record/schema.ts'
import {
  deleteRecordSpaceAgent,
  type RecordSpaceAgent,
  readRecordSpaceAgents,
  upsertRecordSpaceAgent,
} from '../src/record/record-space-agents.ts'
import { asSpace, migration, psql, succeeds } from './fixtures/postgres-rls.ts'

test('space agent migration forces row-level security', () => {
  expect(migration).toContain('ALTER TABLE "space_agent" FORCE ROW LEVEL SECURITY')
})

export function registerSpaceAgentRlsProof(spaceA: string, spaceB: string): void {
  test('space agent rows are tenant-confined and FORCE confines the table owner', () => {
    const idA = newRecordId()
    const idB = newRecordId()
    succeeds(
      'postgres',
      'postgres',
      `INSERT INTO space_agent
       (id,space_id,name,harness,backend,model,transport,route_metered,trains_on_inputs,operated_by,billing)
       VALUES
       ('${idA}','${spaceA}','space-a-agent','codex','vendor','proof','acp',false,false,'vendor','subscription'),
       ('${idB}','${spaceB}','space-b-agent','codex','vendor','proof','acp',false,false,'vendor','subscription');`,
    )

    const hidden = asSpace(
      RECORD_ACTOR_ROLE,
      'actor-password',
      spaceA,
      `SELECT name FROM space_agent WHERE id='${idB}';`,
    )
    expect(hidden.code, hidden.stderr).toBe(0)
    expect(hidden.stdout).toBe('')

    const crossed = asSpace(
      RECORD_ACTOR_ROLE,
      'actor-password',
      spaceA,
      `INSERT INTO space_agent
       (id,space_id,name,harness,backend,model,transport,route_metered,trains_on_inputs,operated_by,billing)
       VALUES
       ('${newRecordId()}','${spaceB}','crossed-agent','codex','vendor','proof','acp',false,false,'vendor','subscription');`,
    )
    expect(crossed.code).not.toBe(0)

    const owner = asSpace(
      RECORD_OWNER_ROLE,
      'owner-password',
      spaceA,
      'SELECT name FROM space_agent ORDER BY name;',
    )
    expect(owner.code, owner.stderr).toBe(0)
    expect(owner.stdout).toBe('space-a-agent')

    succeeds('postgres', 'postgres', `DELETE FROM space_agent WHERE id IN ('${idA}','${idB}');`)
  })

  test('space agent FORCE RLS is present', () => {
    const result = psql(
      'postgres',
      'postgres',
      `SELECT relforcerowsecurity FROM pg_class WHERE relname='space_agent';`,
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe('t')
  })
}

export function registerSpaceAgentServiceProof(input: {
  actorUrl: string
  spaceA: string
  spaceB: string
  userId: string
  otherUserId: string
}): void {
  const tenant = (spaceId: string) => ({
    url: input.actorUrl,
    spaceId,
    userId: input.userId,
  })
  const initial: RecordSpaceAgent = {
    name: 'service-proof-primary',
    harness: 'service-proof-harness-initial',
    backend: 'service-proof-backend-initial',
    model: 'service-proof-model-initial',
    baseUrl: 'https://initial.service-proof.example.test',
    transport: 'service-proof-transport-initial',
    provider: 'service-proof-provider-initial',
    apiKeySecret: 'SERVICE_PROOF_SECRET_INITIAL',
    requestSettings: { phase: 'initial-request', temperature: 0.25 },
    jobs: ['initial-job', { ordinal: 1 }],
    preferredJobs: { preferred: 'initial-preferred-job' },
    maxConcurrent: 17,
    routeMetered: true,
    trainsOnInputs: false,
    operatedBy: 'service-proof-operator-initial',
    billing: 'service-proof-billing-initial',
  }
  const changed: RecordSpaceAgent = {
    name: initial.name,
    harness: 'service-proof-harness-changed',
    backend: 'service-proof-backend-changed',
    model: 'service-proof-model-changed',
    baseUrl: 'https://changed.service-proof.example.test',
    transport: 'service-proof-transport-changed',
    provider: 'service-proof-provider-changed',
    apiKeySecret: 'SERVICE_PROOF_SECRET_CHANGED',
    requestSettings: { phase: 'changed-request', temperature: 0.75 },
    jobs: ['changed-job', { ordinal: 2 }],
    preferredJobs: { preferred: 'changed-preferred-job' },
    maxConcurrent: 29,
    routeMetered: false,
    trainsOnInputs: true,
    operatedBy: 'service-proof-operator-changed',
    billing: 'service-proof-billing-changed',
  }
  const nullable: RecordSpaceAgent = {
    name: 'service-proof-nullable',
    harness: 'service-proof-harness-nullable',
    backend: null,
    model: 'service-proof-model-nullable',
    baseUrl: 'https://nullable.service-proof.example.test',
    transport: 'service-proof-transport-nullable',
    provider: null,
    apiKeySecret: null,
    requestSettings: null,
    jobs: { kind: 'nullable-jobs' },
    preferredJobs: ['nullable-preferred-job'],
    maxConcurrent: null,
    routeMetered: false,
    trainsOnInputs: false,
    operatedBy: 'service-proof-operator-nullable',
    billing: 'service-proof-billing-nullable',
  }
  const spaceBDeclaration: RecordSpaceAgent = {
    ...initial,
    name: 'service-proof-space-b',
    model: 'service-proof-model-space-b',
  }

  test('space agent services preserve declarations, replace by name, delete, and confine reads', async () => {
    const spaceA = tenant(input.spaceA)
    const spaceB = tenant(input.spaceB)

    expect(await upsertRecordSpaceAgent({ ...spaceA, ...initial })).toEqual(initial)
    expect((await readRecordSpaceAgents(spaceA)).find(({ name }) => name === initial.name)).toEqual(
      initial,
    )
    expect(
      (await readRecordSpaceAgents({ ...spaceA, userId: input.otherUserId })).find(
        ({ name }) => name === initial.name,
      ),
    ).toEqual(initial)

    expect(await upsertRecordSpaceAgent({ ...spaceA, ...changed })).toEqual(changed)
    expect(
      (await readRecordSpaceAgents(spaceA)).filter(({ name }) => name === changed.name),
    ).toEqual([changed])

    expect(await upsertRecordSpaceAgent({ ...spaceA, ...nullable })).toEqual(nullable)
    expect(
      (await readRecordSpaceAgents(spaceA)).find(({ name }) => name === nullable.name),
    ).toEqual(nullable)

    expect(await upsertRecordSpaceAgent({ ...spaceB, ...spaceBDeclaration })).toEqual(
      spaceBDeclaration,
    )
    expect(
      (await readRecordSpaceAgents(spaceA)).some(({ name }) => name === spaceBDeclaration.name),
    ).toBe(false)

    expect(await deleteRecordSpaceAgent({ ...spaceA, name: changed.name })).toEqual({
      removed: true,
    })
    expect((await readRecordSpaceAgents(spaceA)).some(({ name }) => name === changed.name)).toBe(
      false,
    )
    expect(await deleteRecordSpaceAgent({ ...spaceA, name: changed.name })).toEqual({
      removed: false,
    })

    expect(await deleteRecordSpaceAgent({ ...spaceA, name: nullable.name })).toEqual({
      removed: true,
    })
    expect(await deleteRecordSpaceAgent({ ...spaceB, name: spaceBDeclaration.name })).toEqual({
      removed: true,
    })
  })
}

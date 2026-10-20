import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { rememberHostedRecord } from '../record/install-binding.ts'
import { BOUND_RECORD_WRITE_REFUSAL } from '../record/record-write-authority.ts'
import { selectProjectProfile, setLens, setProfile, showLens, showProfile } from './lenses.ts'

const HOSTED_SPACE = '01990000-0000-7000-8000-000000000002'

function installHostedCorrectness(): void {
  const local = db()
  local
    .query(`INSERT INTO lens (record_id,space_id,id,title,question,excludes,slots,version,enabled,requires_execution)
      SELECT ?,?,id,title,question,excludes,slots,version,enabled,requires_execution FROM lens
      WHERE id='correctness' AND space_id IS NULL`)
    .run(newRecordId(), HOSTED_SPACE)
  local
    .query(`INSERT INTO lens_profile (record_id,space_id,lens_id,axis,name,version,body,enabled)
      SELECT ?,?,lens_id,axis,name,version,body,enabled FROM lens_profile
      WHERE lens_id='correctness' AND axis='framework' AND name='default' AND space_id IS NULL`)
    .run(newRecordId(), HOSTED_SPACE)
}

test('a hosted lens failure leaves the local catalogue unchanged', async () => {
  const before = showLens('correctness')
  process.env.ORCH_RECORD_API_URL = 'https://record.example.test'
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    upsertLens: async () => {
      throw new Error('hosted lens write failed')
    },
  })
  try {
    await expect(
      setLens({
        id: 'correctness',
        title: 'Changed remotely first',
        question: before!.question,
        excludes: before!.excludes,
        slots: JSON.stringify(before!.slots),
        enabled: true,
        requiresExecution: false,
        reason: 'prove hosted ordering',
      }),
    ).rejects.toThrow('hosted lens write failed')
    expect(showLens('correctness')).toEqual(before)
  } finally {
    delete process.env.ORCH_RECORD_API_URL
    installRecordApiClient(createMemoryRecordApiClient())
  }
})

test('hosted profile failure is inert and success adopts hosted identities and versions', async () => {
  installHostedCorrectness()
  process.env.ORCH_RECORD_API_URL = 'https://record.example.test'
  const before = showProfile('correctness', 'framework', 'default', db(), HOSTED_SPACE)!
  const beforeRevisions = db()
    .query<{ n: number }, []>(
      'SELECT COUNT(*) AS n FROM lens_profile_revision WHERE space_id IS NOT NULL',
    )
    .get()!.n
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    upsertLensProfile: async () => {
      throw new Error('hosted profile write failed')
    },
  })
  await expect(
    setProfile({
      lensId: 'correctness',
      axis: 'framework',
      name: 'default',
      body: '{"framework_guidance":"Hosted.","commands":"bun test"}',
      enabled: true,
      reason: 'hosted profile ordering',
    }),
  ).rejects.toThrow('hosted profile write failed')
  expect(showProfile('correctness', 'framework', 'default', db(), HOSTED_SPACE)).toEqual(before)
  expect(
    db()
      .query<{ n: number }, []>(
        'SELECT COUNT(*) AS n FROM lens_profile_revision WHERE space_id IS NOT NULL',
      )
      .get()!.n,
  ).toBe(beforeRevisions)

  const profileId = newRecordId()
  const revisionId = newRecordId()
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    upsertLensProfile: async () => ({
      profile: {
        id: profileId,
        spaceId: HOSTED_SPACE,
        lensId: newRecordId(),
        axis: 'framework' as const,
        name: 'default',
        version: 2,
        body: '{"framework_guidance":"Hosted.","commands":"bun test"}',
        enabled: true,
        updatedAt: new Date().toISOString(),
      },
      revision: {
        id: revisionId,
        spaceId: HOSTED_SPACE,
        profileId,
        version: 1,
        priorBody: '{}',
        reason: 'hosted profile ordering',
        sessionId: null,
        at: new Date().toISOString(),
      },
    }),
  })
  try {
    const changed = await setProfile({
      lensId: 'correctness',
      axis: 'framework',
      name: 'default',
      body: '{"framework_guidance":"Hosted.","commands":"bun test"}',
      enabled: true,
      reason: 'hosted profile ordering',
    })
    expect(changed).toMatchObject({ record_id: before.record_id, version: 2 })
    expect(
      db().query('SELECT record_id FROM lens_profile WHERE record_id=?').get(before.record_id),
    ).toEqual({
      record_id: profileId,
    })
    expect(
      db().query('SELECT record_id FROM lens_profile_revision WHERE space_id=?').get(HOSTED_SPACE),
    ).toEqual({ record_id: revisionId })
  } finally {
    delete process.env.ORCH_RECORD_API_URL
    installRecordApiClient(createMemoryRecordApiClient())
  }
})

test('hosted selection failure is inert and success adopts hosted identities and versions', async () => {
  installHostedCorrectness()
  const projectId = newRecordId()
  upsertProject({ recordId: projectId, name: 'hosted-project', path: '/tmp/hosted', settings: {} })
  process.env.ORCH_RECORD_API_URL = 'https://record.example.test'
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    selectProjectLensProfile: async () => {
      throw new Error('hosted selection write failed')
    },
  })
  const input = {
    project: 'hosted-project',
    axis: 'framework',
    name: 'default',
    lensId: 'correctness',
    reason: 'hosted selection ordering',
  }
  await expect(selectProjectProfile(input)).rejects.toThrow('hosted selection write failed')
  expect(
    db().query('SELECT COUNT(*) AS n FROM project_lens_profile WHERE space_id=?').get(HOSTED_SPACE),
  ).toEqual({ n: 0 })
  expect(
    db()
      .query('SELECT COUNT(*) AS n FROM project_lens_profile_revision WHERE space_id=?')
      .get(HOSTED_SPACE),
  ).toEqual({ n: 0 })

  const selectionId = newRecordId()
  const revisionId = newRecordId()
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    selectProjectLensProfile: async () => ({
      selection: {
        id: selectionId,
        spaceId: HOSTED_SPACE,
        projectId,
        lensId: newRecordId(),
        axis: 'framework' as const,
        profileName: 'default',
        selectedVersion: null,
        selectionVersion: 1,
        updatedAt: new Date().toISOString(),
      },
      revision: {
        id: revisionId,
        spaceId: HOSTED_SPACE,
        selectionId,
        priorProfileName: null,
        priorSelectedVersion: null,
        reason: input.reason,
        sessionId: null,
        at: new Date().toISOString(),
      },
    }),
  })
  try {
    await selectProjectProfile(input)
    expect(
      db()
        .query('SELECT record_id,selection_version FROM project_lens_profile WHERE space_id=?')
        .get(HOSTED_SPACE),
    ).toEqual({ record_id: selectionId, selection_version: 1 })
    expect(
      db()
        .query('SELECT record_id FROM project_lens_profile_revision WHERE space_id=?')
        .get(HOSTED_SPACE),
    ).toEqual({ record_id: revisionId })
  } finally {
    delete process.env.ORCH_RECORD_API_URL
    installRecordApiClient(createMemoryRecordApiClient())
  }
})

test('lens writes stay local-authoritative without a record and refuse a bound missing endpoint', async () => {
  delete process.env.ORCH_RECORD_API_URL
  const created = await setLens({
    id: 'local-authoritative-lens',
    title: 'Local lens',
    question: 'Does local authority work?',
    excludes: 'Hosted behavior.',
    slots: '{"type":"object","properties":{},"additionalProperties":false}',
    enabled: true,
    requiresExecution: false,
    reason: 'prove local branch',
  })
  expect(created.id).toBe('local-authoritative-lens')
  rememberHostedRecord(db())
  try {
    await expect(
      setLens({
        id: 'local-authoritative-lens',
        title: 'Must not change',
        question: 'Does refusal work?',
        excludes: 'Nothing.',
        slots: '{"type":"object","properties":{},"additionalProperties":false}',
        enabled: true,
        requiresExecution: false,
        reason: 'prove refusal branch',
      }),
    ).rejects.toThrow(BOUND_RECORD_WRITE_REFUSAL)
    expect(showLens('local-authoritative-lens')!.title).toBe('Local lens')
  } finally {
    db().query('DELETE FROM record_install_binding').run()
  }
})

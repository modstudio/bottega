import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  type RecordApiClient,
  recordApiClientOver,
  recordApiRequest,
} from '../orchestrator/src/record/record-api-client.ts'
import { identity } from '../orchestrator/src/record/record-api-identity.fixture.ts'
import { registerRecordStorageRoute } from '../orchestrator/src/record/record-api-storage.ts'
import {
  CURRENT_CONTRACT_REPO_PATH,
  RELEASED_CONTRACT_REPO_DIRECTORY,
  releasedContractSnapshotPath,
} from '../orchestrator/src/release/release-client-contract.ts'
import { idleRecordApiDeps, idleSubjectDeps } from '../orchestrator/test/fixtures/record-api.ts'
import { recordApiTestApp } from '../orchestrator/test/fixtures/record-api-app.ts'
import { type ConfigClient, configClient } from '../shared/config-client.ts'
import { enumerateClientMethods } from './identity-client-enumeration.ts'
import { formatRecordClientContractJson } from './record-client-contract-json.ts'

export type RecordClientContractEntry = {
  sample: string
  method: string
  path: string
  query: Array<[string, string]>
  body: unknown | null
  recordSpace: boolean
  status: number
}

const ROOT = resolve(import.meta.dir, '..')
export const CURRENT_CONTRACT_PATH = resolve(ROOT, CURRENT_CONTRACT_REPO_PATH)
export const RELEASED_CONTRACT_DIRECTORY = resolve(ROOT, RELEASED_CONTRACT_REPO_DIRECTORY)

const SAMPLE_ID = '01990000-0000-7000-8000-000000000001'
const SAMPLE_KEY_ID = 'AAAAAAAAAAAAAAAAAAAAAA'
const SAMPLE_KEY_BYTES = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
export const CONTRACT_ORIGIN = 'https://record.example.test'
const SAMPLE_DESTINATION = { destinationSpaceId: 'space-a', projectId: SAMPLE_ID }
const SAMPLE_INPUT = {
  ...SAMPLE_DESTINATION,
  id: SAMPLE_ID,
  key: 'DEV-1',
  name: 'sample',
  slug: 'sample',
  project: 'sample',
  projectId: SAMPLE_ID,
  definition: 'sample',
  scope: 'user',
  subject: null,
  environment: 'default',
  expectedRowVersion: 1,
  expectedRevision: SAMPLE_ID,
  reason: 'contract sample',
  author: 'contract',
  ids: [SAMPLE_ID],
  wraps: [],
  payload: {},
  machineId: SAMPLE_ID,
  count: 1,
  cursor: '0',
  limit: 1,
}

const RECORD_SAMPLE_NAMES = [
  'abandonTaskFlow',
  'acceptBoardAnswer',
  'acceptInvitation',
  'addProjectSubject',
  'adoptTaskFlow',
  'advanceTaskFlow',
  'applySettingsAutoMode',
  'applySettingsPermission',
  'attachTaskFlowText',
  'awaitTaskFlowRuling',
  'blockOutsideAuthor',
  'cacheCounts',
  'completeBoardFilingLease',
  'composeTaskFlow',
  'consumeDoc',
  'copyTaskFlowText',
  'counts',
  'createOrganization',
  'defineProjectSubject',
  'deleteContextItem',
  'deleteDoc',
  'deleteSpace',
  'deleteSpaceAgent',
  'deleteTaskFlowText',
  'deleteTrialSpace',
  'draftWorkflow',
  'ensureSpaceBuiltIns',
  'failBoardFilingLease',
  'getBoardStatus',
  'getBoardThread',
  'getContextItem',
  'getDoc',
  'getDocRevision',
  'getPublicDoc',
  'grantConfigAccess',
  'handoffTaskFlow',
  'hideRow',
  'importCanon',
  'importDoc',
  'importLensCatalogue',
  'importPortCatalogue',
  'importQuestion',
  'importTaskFlow',
  'importWorkflowCatalogue',
  'inviteMember',
  'listBoardChanges',
  'listBoardClaims',
  'listBoardMessages',
  'listChanges',
  'listConfigAccess',
  'listContextHolders',
  'listContextItems',
  'listDocs',
  'listHidden',
  'listInvitations',
  'listLensCatalogue',
  'listOutsideBlocks',
  'listPortCatalogue',
  'listProjectSubjects',
  'listProjects',
  'listPublicDocs',
  'listRevisions',
  'listRoutingEvidence',
  'listScores',
  'listSnapshots',
  'listSpaceAgents',
  'listTaskFlowStages',
  'listWorkflowCatalogue',
  'noDestinationWrites',
  'openBoardStream',
  'pauseOutsideIntake',
  'postBoardMessage',
  'promoteWorkflow',
  'purgeProject',
  'putBoardReceipt',
  'putSnapshot',
  'readMembershipQuestions',
  'readQuestions',
  'readTaskFlow',
  'readTaskFlowObligation',
  'readTaskFlowPresence',
  'readTaskFlowProjectReferenceCounts',
  'readTaskFlowStage',
  'readTaskFlowStageSummaries',
  'readTaskFlowText',
  'releaseBoardClaim',
  'releaseBoardTaskClaims',
  'removeMember',
  'renameMachine',
  'renameProjectSubject',
  'renameSubject',
  'renewBoardClaim',
  'reorderDocs',
  'reorderProjectSubjects',
  'repinTaskFlow',
  'replyBoardMessage',
  'restoreDoc',
  'resumeOutsideIntake',
  'retireMachine',
  'retireProject',
  'retireProjectSubject',
  'retireWorkflow',
  'searchDocs',
  'searchPublicDocs',
  'selectProjectLensProfile',
  'setActiveOrganization',
  'setOutsideIntake',
  'showOutsideIntake',
  'storage',
  'sync',
  'takeBoardClaim',
  'takeBoardFilingLease',
  'takeBoardSuccessor',
  'unblockOutsideAuthor',
  'unhideRow',
  'updateTaskFlowStage',
  'upsertContextItem',
  'upsertDoc',
  'upsertLens',
  'upsertLensProfile',
  'upsertProject',
  'upsertSpaceAgent',
  'whoami',
  'withdrawBoardMessage',
  'withdrawConfigAccess',
  'writePort',
  'writeQuestion',
] as const

const CONFIG_SAMPLE_NAMES = [
  'addWraps',
  'allocateMachineJoinNameplate',
  'appendTrustLogEntry',
  'claimMachineKey',
  'createDataKey',
  'createMachineKeyClaimChallenge',
  'currentDataKey',
  'deleteCredentialPreference',
  'deleteEntry',
  'deleteSecret',
  'failMachineJoinNameplate',
  'getDataKey',
  'getEntry',
  'getSecret',
  'listCredentialPreferences',
  'listDataKeys',
  'listEntries',
  'listMachineKeys',
  'listSecrets',
  'postMachineJoinMessage',
  'putCredentialPreference',
  'putEntry',
  'putSecret',
  'readMachineJoinMessages',
  'readTrustLog',
  'registerMachineKey',
  'retireDataKey',
  'revokeMachineKey',
  'whoami',
] as const

const recordClientSamples = Object.fromEntries(
  RECORD_SAMPLE_NAMES.map((name) => [`record.${name}`, name]),
) as Record<string, keyof RecordApiClient>
const configClientSamples = Object.fromEntries(
  CONFIG_SAMPLE_NAMES.map((name) => [`config.${name}`, name]),
) as Record<string, keyof ConfigClient>

export function recordClientContractApp() {
  const unusedWrite = async () => ({})
  const app = recordApiTestApp(
    identity,
    { ...idleSubjectDeps(), ...idleRecordApiDeps() },
    {
      listBoardChanges: async () => ({ changes: [], cursor: '0' }),
      readSpaceAgents: async () => [],
      upsertSpaceAgent: async ({
        url: _url,
        userId: _userId,
        spaceId: _spaceId,
        spaceIds: _spaceIds,
        ...declaration
      }: Record<string, unknown>) => declaration,
      deleteSpaceAgent: async () => ({ removed: true }),
      listBoardMessages: unusedWrite,
      postBoardMessage: unusedWrite,
      replyBoardMessage: unusedWrite,
      withdrawBoardMessage: unusedWrite,
      acceptBoardAnswer: unusedWrite,
      takeBoardFilingLease: unusedWrite,
      completeBoardFilingLease: unusedWrite,
      failBoardFilingLease: unusedWrite,
      readBoardThread: unusedWrite,
      boardStatus: unusedWrite,
      putBoardReceipt: unusedWrite,
      takeBoardSuccessor: unusedWrite,
      takeBoardClaim: unusedWrite,
      renewBoardClaim: unusedWrite,
      releaseBoardClaim: unusedWrite,
      listBoardClaims: unusedWrite,
      releaseBoardTaskClaims: unusedWrite,
      createMachineKeyClaimChallenge: unusedWrite,
      claimMachineKey: unusedWrite,
      allocateMachineJoinNameplate: unusedWrite,
      postMachineJoinMessage: unusedWrite,
      failMachineJoinNameplate: unusedWrite,
      appendMachineTrustLogEntry: async () => new Uint8Array([1]),
      grantSpaceConfigAccess: unusedWrite,
      setSpaceMemberPermission: unusedWrite,
      withdrawSpaceConfigAccess: unusedWrite,
      setOutsideIntake: unusedWrite,
      pauseOutsideIntake: unusedWrite,
      resumeOutsideIntake: unusedWrite,
      listOutsideBlocks: async () => [],
      blockOutsideAuthor: unusedWrite,
      unblockOutsideAuthor: unusedWrite,
      hideRow: unusedWrite,
      unhideRow: unusedWrite,
      listHidden: async () => [],
      deleteTrialSpace: unusedWrite,
      deleteSpace: unusedWrite,
    },
  )
  registerRecordStorageRoute(app, {
    platformOwnerUserIds: () => [identity.user.id],
    readStorage: async () => [],
  })
  return app
}

function parsedBody(request: Request): Promise<unknown | null> {
  if (!request.body) return Promise.resolve(null)
  return request.text().then((text) => {
    if (!text) return null
    try {
      return JSON.parse(text) as unknown
    } catch {
      return null
    }
  })
}

function createRecordingTransport(
  entries: RecordClientContractEntry[],
  sampleName: () => string,
  app = recordClientContractApp(),
): typeof fetch {
  return (async (input, init) => {
    const request = new Request(input, init)
    const recordedRequest = request.clone()
    const url = new URL(request.url)
    const response = await Promise.resolve(app.request(request)).catch((error) =>
      Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      ),
    )
    entries.push({
      sample: sampleName(),
      method: request.method,
      path: url.pathname,
      query: [...url.searchParams.entries()].sort(([a, av], [b, bv]) =>
        a === b ? av.localeCompare(bv) : a.localeCompare(b),
      ),
      body: await parsedBody(recordedRequest),
      recordSpace: request.headers.has('x-record-space'),
      status: response.status,
    })
    return response
  }) as typeof fetch
}

function missingClientSamples(record: RecordApiClient, config: ConfigClient): string[] {
  const sampled = new Set([
    ...Object.keys(recordClientSamples),
    ...Object.keys(configClientSamples),
  ])
  return [
    ...enumerateClientMethods('record', record as unknown as Record<string, unknown>),
    ...enumerateClientMethods('config', config as unknown as Record<string, unknown>),
  ].filter((name) => !sampled.has(name))
}

type SampleMember = (typeof RECORD_SAMPLE_NAMES)[number] | (typeof CONFIG_SAMPLE_NAMES)[number]

const SAMPLE_ARGUMENTS = {
  abandonTaskFlow: () => [SAMPLE_INPUT, SAMPLE_DESTINATION],
  acceptInvitation: () => [SAMPLE_ID],
  addProjectSubject: () => [SAMPLE_INPUT, SAMPLE_DESTINATION],
  adoptTaskFlow: () => [SAMPLE_INPUT, SAMPLE_DESTINATION],
  advanceTaskFlow: () => [SAMPLE_INPUT, SAMPLE_DESTINATION],
  allocateMachineJoinNameplate: () => [SAMPLE_DESTINATION],
  attachTaskFlowText: () => [SAMPLE_INPUT, SAMPLE_DESTINATION],
  awaitTaskFlowRuling: () => [SAMPLE_INPUT, SAMPLE_DESTINATION],
  cacheCounts: () => [SAMPLE_DESTINATION],
  composeTaskFlow: () => [SAMPLE_INPUT, SAMPLE_DESTINATION],
  copyTaskFlowText: () => [SAMPLE_INPUT, SAMPLE_DESTINATION],
  counts: () => [SAMPLE_DESTINATION],
  createOrganization: () => [{ name: 'sample', slug: 'sample' }],
  defineProjectSubject: () => [SAMPLE_INPUT, SAMPLE_DESTINATION],
  deleteEntry: () => [
    'key',
    { scope: 'user', environment: 'default', expectedRowVersion: 1 },
    SAMPLE_DESTINATION,
  ],
  deleteSecret: () => [
    'key',
    { scope: 'user', environment: 'default', expectedRowVersion: 1 },
    SAMPLE_DESTINATION,
  ],
  deleteTaskFlowText: () => [SAMPLE_INPUT, SAMPLE_DESTINATION],
  ensureSpaceBuiltIns: () => [SAMPLE_DESTINATION],
  getDataKey: () => [SAMPLE_ID, SAMPLE_KEY_ID, SAMPLE_DESTINATION],
  grantConfigAccess: () => ['a@example.test', 'space-a'],
  handoffTaskFlow: () => [SAMPLE_INPUT, SAMPLE_DESTINATION],
  hideRow: () => [{ message: SAMPLE_ID, reason: 'spam' }, 'space-a'],
  importQuestion: () => [SAMPLE_INPUT, SAMPLE_DESTINATION],
  importTaskFlow: () => [SAMPLE_INPUT, SAMPLE_DESTINATION],
  importWorkflowCatalogue: () => [
    {
      dryRun: true,
      step_catalogue: [],
      step_catalogue_version: [],
      step_catalogue_event: [],
      workflow: [],
      workflow_version: [],
      workflow_event: [],
    },
    SAMPLE_DESTINATION,
  ],
  inviteMember: () => [{ email: 'a@example.test', role: 'member', organizationId: SAMPLE_ID }],
  listConfigAccess: () => ['space-a'],
  listCredentialPreferences: () => [SAMPLE_DESTINATION],
  listDataKeys: () => [SAMPLE_DESTINATION],
  listEntries: () => ['default', SAMPLE_DESTINATION],
  listHidden: () => [],
  listInvitations: () => [],
  listOutsideBlocks: () => [SAMPLE_DESTINATION],
  listMachineKeys: () => [SAMPLE_DESTINATION],
  listProjects: () => [],
  listPublicDocs: () => [],
  listSecrets: () => ['default', SAMPLE_DESTINATION],
  listSnapshots: () => [],
  listTaskFlowStages: () => [{ taskKey: 'DEV-1', limit: 1 }, SAMPLE_DESTINATION],
  noDestinationWrites: () => [],
  pauseOutsideIntake: () => [1, 'space-a'],
  readMembershipQuestions: () => [SAMPLE_INPUT],
  readQuestions: () => [SAMPLE_INPUT],
  readTrustLog: () => [SAMPLE_DESTINATION],
  readTaskFlowObligation: () => [SAMPLE_ID, SAMPLE_DESTINATION],
  readTaskFlowPresence: () => [SAMPLE_INPUT, SAMPLE_DESTINATION],
  readTaskFlowProjectReferenceCounts: () => [SAMPLE_ID, SAMPLE_DESTINATION],
  readTaskFlowStage: () => [SAMPLE_ID, SAMPLE_DESTINATION],
  readTaskFlowStageSummaries: () => [SAMPLE_INPUT, SAMPLE_DESTINATION],
  readTaskFlowText: () => [SAMPLE_ID, SAMPLE_DESTINATION],
  releaseBoardTaskClaims: () => [
    { project: 'sample', projectId: SAMPLE_ID, key: 'DEV-1' },
    SAMPLE_DESTINATION,
  ],
  removeMember: () => [{ email: 'a@example.test', organizationId: SAMPLE_ID }],
  renameMachine: () => [{ machineId: SAMPLE_ID, name: 'sample' }],
  renameProjectSubject: () => [SAMPLE_INPUT, SAMPLE_DESTINATION],
  reorderProjectSubjects: () => [SAMPLE_INPUT, SAMPLE_DESTINATION],
  repinTaskFlow: () => [SAMPLE_INPUT, SAMPLE_DESTINATION],
  restoreDoc: () => [
    SAMPLE_ID,
    { revisionId: SAMPLE_ID, reason: 'contract sample', author: 'contract' },
    SAMPLE_DESTINATION,
  ],
  resumeOutsideIntake: () => ['space-a'],
  retireMachine: () => ['sample'],
  retireProjectSubject: () => [SAMPLE_INPUT, SAMPLE_DESTINATION],
  searchDocs: () => [{ q: 'sample' }],
  searchPublicDocs: () => ['sample'],
  setActiveOrganization: () => [{ organizationId: SAMPLE_ID }],
  setOutsideIntake: () => ['sample', 'space-a'],
  showOutsideIntake: () => [],
  storage: () => [],
  sync: () => [SAMPLE_INPUT],
  unblockOutsideAuthor: () => [SAMPLE_ID, 'space-a'],
  unhideRow: () => [{ message: SAMPLE_ID }, 'space-a'],
  updateTaskFlowStage: () => [SAMPLE_INPUT, SAMPLE_DESTINATION],
  whoami: () => [],
  withdrawConfigAccess: () => ['a@example.test', 'space-a'],
  writeQuestion: () => ['sample', SAMPLE_INPUT, SAMPLE_DESTINATION],
  acceptBoardAnswer: () => [SAMPLE_ID, { replyId: SAMPLE_ID }, SAMPLE_DESTINATION],
  applySettingsAutoMode: () => [
    {
      target: { kind: 'user' },
      list: 'allow',
      rule: 'sample',
      operation: 'add',
      reason: 'contract sample',
      expectedRevision: SAMPLE_ID,
    },
    SAMPLE_DESTINATION,
  ],
  applySettingsPermission: () => [
    {
      target: { kind: 'user' },
      list: 'allow',
      rule: 'sample',
      operation: 'add',
      reason: 'contract sample',
      expectedRevision: SAMPLE_ID,
    },
    SAMPLE_DESTINATION,
  ],
  completeBoardFilingLease: () => [SAMPLE_ID, { noteId: SAMPLE_ID }, SAMPLE_DESTINATION],
  consumeDoc: () => [
    SAMPLE_ID,
    { reason: 'contract sample', author: 'contract' },
    SAMPLE_DESTINATION,
  ],
  deleteContextItem: () => [SAMPLE_ID, {}, SAMPLE_DESTINATION],
  deleteSpaceAgent: () => ['contract-agent', SAMPLE_DESTINATION],
  deleteDoc: () => [
    SAMPLE_ID,
    { reason: 'contract sample', author: 'contract' },
    SAMPLE_DESTINATION,
  ],
  deleteSpace: () => ['sample', 'sample'],
  deleteTrialSpace: () => ['sample'],
  draftWorkflow: () => [
    {
      kind: 'workflow',
      slug: 'sample',
      event: 'set',
      definition: '{}',
      author: 'contract',
      reason: 'contract sample',
    },
    SAMPLE_DESTINATION,
  ],
  failBoardFilingLease: () => [SAMPLE_ID, { error: 'sample' }, SAMPLE_DESTINATION],
  getBoardStatus: () => [SAMPLE_ID],
  getBoardThread: () => [SAMPLE_ID],
  getContextItem: () => ['task:DEV-1', 'sample', SAMPLE_DESTINATION],
  getDoc: () => [SAMPLE_ID, SAMPLE_DESTINATION],
  getDocRevision: () => [SAMPLE_ID],
  getPublicDoc: () => [SAMPLE_ID],
  importCanon: () => [
    {
      address: { kind: 'project', subject: 'sample', projectId: SAMPLE_ID },
      rows: [],
      expectedRevisions: {},
      reason: 'contract sample',
      author: 'contract',
    },
    SAMPLE_DESTINATION,
  ],
  importDoc: () => [
    {
      doc: {
        id: SAMPLE_ID,
        scope: 'project',
        subject: 'sample',
        slug: 'sample',
        title: 'Sample',
        body: 'sample',
        delivery: 'demand',
        audiences: ['technical'],
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        deletedAt: null,
      },
      revisions: [],
    },
    SAMPLE_DESTINATION,
  ],
  importLensCatalogue: () => [
    {
      dryRun: true,
      lens: [],
      lens_revision: [],
      lens_profile: [],
      lens_profile_revision: [],
      project_lens_profile: [],
      project_lens_profile_revision: [],
    },
    SAMPLE_DESTINATION,
  ],
  importPortCatalogue: () => [
    {
      dryRun: true,
      replace: false,
      port_doctrine: [],
      port_pair: [],
      port_baseline: [],
      port_ref: [],
      port_ref_source: [],
      port_skip: [],
    },
    SAMPLE_DESTINATION,
  ],
  listBoardClaims: () => ['sample', SAMPLE_ID],
  listBoardChanges: () => [{ after: '0' }, SAMPLE_DESTINATION],
  listBoardMessages: () => [{ kind: 'notice' }],
  listChanges: () => [{ wait: 0 }],
  blockOutsideAuthor: () => [{ message: SAMPLE_ID, hours: 1 }, 'space-a'],
  listContextItems: () => [['task:DEV-1'], SAMPLE_DESTINATION],
  listSpaceAgents: () => [SAMPLE_DESTINATION],
  listContextHolders: () => ['task', SAMPLE_DESTINATION],
  listDocs: () => [{ scope: 'project', limit: 1 }, SAMPLE_DESTINATION],
  listLensCatalogue: () => ['lens', { limit: 1 }, SAMPLE_DESTINATION],
  listPortCatalogue: () => ['port_doctrine', { limit: 1 }, SAMPLE_DESTINATION],
  listProjectSubjects: () => [{ project: 'sample', limit: 1 }, SAMPLE_DESTINATION],
  listRevisions: () => [SAMPLE_ID, SAMPLE_DESTINATION],
  listRoutingEvidence: () => [{ spaceId: SAMPLE_ID, limit: 1 }],
  listScores: () => [{ limit: 1 }],
  listWorkflowCatalogue: () => ['workflow', { limit: 1 }, SAMPLE_DESTINATION],
  openBoardStream: () => [],
  postBoardMessage: () => [
    {
      id: SAMPLE_ID,
      kind: 'notice',
      audience: 'architects',
      title: 'Sample',
      body: 'sample',
      expiresAt: '2025-01-01T00:00:00.000Z',
    },
    SAMPLE_DESTINATION,
  ],
  promoteWorkflow: () => [
    {
      kind: 'workflow',
      slug: 'sample',
      n: 1,
      expectedProductionVersion: null,
      author: 'contract',
      reason: 'contract sample',
    },
    SAMPLE_DESTINATION,
  ],
  purgeProject: () => [SAMPLE_ID, 'sample'],
  putBoardReceipt: () => [
    {
      messageId: SAMPLE_ID,
      readerSession: 'contract',
      audienceAtPosting: true,
      delivered: true,
    },
    SAMPLE_DESTINATION,
  ],
  putSnapshot: () => ['state', { machineId: SAMPLE_ID, payload: {} }, SAMPLE_DESTINATION],
  readTaskFlow: () => [{ taskKey: 'DEV-1' }, SAMPLE_DESTINATION],
  releaseBoardClaim: () => [SAMPLE_ID, SAMPLE_DESTINATION],
  renameSubject: () => [{ from: 'old', to: 'new', count: 1 }, SAMPLE_DESTINATION],
  renewBoardClaim: () => [SAMPLE_ID, SAMPLE_DESTINATION],
  reorderDocs: () => [
    { scope: 'project', subject: 'sample', parentId: null, orderedIds: [SAMPLE_ID] },
    SAMPLE_DESTINATION,
  ],
  replyBoardMessage: () => [SAMPLE_ID, { id: SAMPLE_ID, body: 'sample' }, SAMPLE_DESTINATION],
  retireProject: () => [SAMPLE_ID],
  retireWorkflow: () => [
    {
      kind: 'workflow',
      slug: 'sample',
      n: 1,
      expectedProductionVersion: 1,
      author: 'contract',
      reason: 'contract sample',
    },
    SAMPLE_DESTINATION,
  ],
  selectProjectLensProfile: () => [
    {
      projectId: SAMPLE_ID,
      lensKey: null,
      axis: 'framework',
      profileName: 'sample',
      selectedVersion: null,
      selectedVersionId: null,
      expectedSelectionVersion: null,
      reason: 'contract sample',
    },
    SAMPLE_DESTINATION,
  ],
  takeBoardClaim: () => [
    { id: SAMPLE_ID, project: 'sample', projectId: SAMPLE_ID, subject: 'task:DEV-1' },
    SAMPLE_DESTINATION,
  ],
  takeBoardFilingLease: () => [SAMPLE_ID, SAMPLE_DESTINATION],
  takeBoardSuccessor: () => [
    { messageId: SAMPLE_ID, candidateSession: 'contract' },
    SAMPLE_DESTINATION,
  ],
  upsertSpaceAgent: () => [
    {
      name: 'contract-agent',
      harness: 'codex',
      backend: null,
      model: 'contract-model',
      baseUrl: null,
      transport: 'acp',
      provider: null,
      apiKeySecret: 'CONTRACT_SECRET_NAME',
      requestSettings: null,
      jobs: null,
      preferredJobs: null,
      maxConcurrent: 1,
      routeMetered: false,
      trainsOnInputs: false,
      operatedBy: 'vendor',
      billing: 'subscription',
    },
    SAMPLE_DESTINATION,
  ],
  upsertContextItem: () => [
    {
      holderKind: 'task',
      holderId: 'DEV-1',
      slug: 'sample',
      kind: 'fact',
      body: 'sample',
      source: 'contract',
      questionNumber: null,
      target: null,
    },
    SAMPLE_DESTINATION,
  ],
  upsertDoc: () => [
    {
      scope: 'project',
      subject: 'sample',
      slug: 'sample',
      title: 'Sample',
      body: 'sample',
      delivery: 'demand',
      reason: 'contract sample',
      author: 'contract',
    },
    SAMPLE_DESTINATION,
  ],
  upsertLens: () => [
    {
      key: 'sample',
      title: 'Sample',
      question: 'Sample?',
      excludes: 'nothing',
      slots: '',
      enabled: true,
      requiresExecution: false,
      expectedVersion: null,
      reason: 'contract sample',
    },
    SAMPLE_DESTINATION,
  ],
  upsertLensProfile: () => [
    {
      lensKey: 'sample',
      axis: 'framework',
      name: 'sample',
      body: 'sample',
      enabled: true,
      expectedVersion: null,
      reason: 'contract sample',
    },
    SAMPLE_DESTINATION,
  ],
  upsertProject: () => [
    {
      id: SAMPLE_ID,
      name: 'sample',
      path: '/sample',
      stack: null,
      canon: false,
      settings: {},
      retiredAt: null,
      expectedRevision: null,
    },
  ],
  withdrawBoardMessage: () => [SAMPLE_ID, SAMPLE_DESTINATION, {}],
  writePort: () => [
    {
      action: 'add_doctrine',
      number: 1,
      title: 'Sample',
      body: 'sample',
      createdAt: '2025-01-01T00:00:00.000Z',
    },
    SAMPLE_DESTINATION,
  ],
  postMachineJoinMessage: () => [
    '1',
    '00000000000000000000000000000000',
    'phase',
    new Uint8Array([1]),
    SAMPLE_DESTINATION,
  ],
  appendTrustLogEntry: () => [null, new Uint8Array([1]), SAMPLE_DESTINATION],
  addWraps: () => [SAMPLE_ID, [], SAMPLE_DESTINATION],
  claimMachineKey: () => [SAMPLE_KEY_ID, SAMPLE_ID, SAMPLE_KEY_BYTES, SAMPLE_DESTINATION],
  createDataKey: () => [{ dekId: SAMPLE_ID, version: 1, wraps: [] }, SAMPLE_DESTINATION],
  createMachineKeyClaimChallenge: () => [SAMPLE_KEY_ID, SAMPLE_DESTINATION],
  currentDataKey: () => [SAMPLE_KEY_ID, SAMPLE_DESTINATION],
  deleteCredentialPreference: () => [
    {
      projectId: null,
      provider: 'provider',
      name: null,
      type: 'api-key',
      mode: 'default',
      environment: 'local',
      payer: 'personal',
      binding: 'space',
    },
    SAMPLE_DESTINATION,
  ],
  failMachineJoinNameplate: () => ['1', '00000000000000000000000000000000', SAMPLE_DESTINATION],
  getEntry: () => ['key', 'user', 'default', SAMPLE_DESTINATION],
  getSecret: () => ['key', 'user', 'default', SAMPLE_DESTINATION],
  putCredentialPreference: () => [
    {
      projectId: null,
      provider: 'provider',
      name: null,
      type: 'api-key',
      mode: 'default',
      environment: 'local',
      payer: 'personal',
      binding: 'space',
    },
    SAMPLE_DESTINATION,
  ],
  putEntry: () => [
    'key',
    { scope: 'user', environment: 'default', value: 'sample', expectedRowVersion: null },
    SAMPLE_DESTINATION,
  ],
  putSecret: () => [
    'key',
    {
      scope: 'user',
      environment: 'default',
      dekId: SAMPLE_ID,
      envelope: SAMPLE_KEY_BYTES,
      expectedRowVersion: null,
    },
    SAMPLE_DESTINATION,
  ],
  readMachineJoinMessages: () => ['1', '00000000000000000000000000000000', SAMPLE_DESTINATION],
  registerMachineKey: () => [SAMPLE_KEY_ID, SAMPLE_KEY_BYTES, 'label', SAMPLE_DESTINATION],
  retireDataKey: () => [SAMPLE_ID, SAMPLE_DESTINATION],
  revokeMachineKey: () => [SAMPLE_KEY_ID, SAMPLE_DESTINATION],
} satisfies Record<SampleMember, () => unknown[]>

async function invokeSample(client: object, member: string): Promise<void> {
  const method = (client as Record<string, (...args: unknown[]) => unknown>)[member]
  if (!method) return
  const argumentsFor = SAMPLE_ARGUMENTS[member as SampleMember]
  if (!argumentsFor) throw new Error(`record client sample lacks arguments: ${member}`)
  const args = argumentsFor()
  try {
    const result = await method(...args)
    if (member === 'openBoardStream' && result && typeof result === 'object' && 'close' in result)
      (result as { close: () => void }).close()
  } catch (error) {
    // Contract generation cares about the request and response status, not client parsing.
    if (process.env.DEBUG_RECORD_CONTRACT) console.error(member, error)
  }
}

export async function generateRecordClientContract(
  origin: string,
): Promise<RecordClientContractEntry[]> {
  const entries: RecordClientContractEntry[] = []
  let activeSample = ''
  const transport = createRecordingTransport(entries, () => activeSample)
  const authentication = {
    token: () => 'contract-token',
    tokenAsync: async () => 'contract-token',
  }
  const request = <T>(path: string, init: RequestInit & { destinationSpaceId?: string } = {}) =>
    recordApiRequest<T>(path, init, authentication, transport, () => undefined, origin)
  const record = recordApiClientOver(request, {
    transport,
    origin: () => origin,
    streamToken: () => 'contract-token',
    streamTransport: transport,
    preflight: () => undefined,
  })
  const config = configClient({ BOTTEGA_RECORD_API_URL: origin }, transport, 'contract-token')
  const missing = missingClientSamples(record, config)
  if (missing.length) throw new Error(`record client contract lacks samples: ${missing.join(', ')}`)
  for (const [sample, member] of Object.entries(recordClientSamples)) {
    activeSample = sample
    await invokeSample(record, member)
  }
  for (const [sample, member] of Object.entries(configClientSamples)) {
    activeSample = sample
    await invokeSample(config, member)
  }
  const recorded = new Set(entries.map((entry) => entry.sample))
  const unrecorded = [
    ...Object.keys(recordClientSamples),
    ...Object.keys(configClientSamples),
  ].filter((sample) => !recorded.has(sample))
  if (unrecorded.length)
    throw new Error(`record client samples sent no request: ${unrecorded.join(', ')}`)
  const objectPaths = entries.filter((entry) =>
    decodeURIComponent(entry.path).includes('[object Object]'),
  )
  if (objectPaths.length)
    throw new Error(
      `record client samples rendered a non-string path segment: ${objectPaths
        .map((entry) => entry.sample)
        .join(', ')}`,
    )
  const invalid = entries.filter((entry) => [400, 405, 415, 422].includes(entry.status))
  if (invalid.length)
    throw new Error(
      `record client samples failed request validation: ${invalid
        .map((entry) => `${entry.sample} (${entry.status})`)
        .join(', ')}`,
    )
  return entries.sort((a, b) => a.sample.localeCompare(b.sample))
}

export const serializeRecordClientContract = formatRecordClientContractJson

async function main() {
  const urlKey = 'BOTTEGA_RECORD_API_URL'
  const previousUrl = Reflect.get(process.env, urlKey) as string | undefined
  Reflect.set(process.env, urlKey, CONTRACT_ORIGIN)
  let entries: RecordClientContractEntry[]
  try {
    entries = await generateRecordClientContract(CONTRACT_ORIGIN)
  } finally {
    if (previousUrl === undefined) Reflect.deleteProperty(process.env, urlKey)
    else Reflect.set(process.env, urlKey, previousUrl)
  }
  if (process.argv.includes('--update')) {
    writeFileSync(CURRENT_CONTRACT_PATH, serializeRecordClientContract(entries))
    return
  }
  if (process.argv.includes('--snapshot')) {
    const version = (
      JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { version: string }
    ).version
    mkdirSync(RELEASED_CONTRACT_DIRECTORY, { recursive: true })
    const snapshot = releasedContractSnapshotPath(ROOT, version)
    const serialized = serializeRecordClientContract(entries)
    if (existsSync(snapshot) && readFileSync(snapshot, 'utf8') !== serialized)
      throw new Error(
        `released client contract ${version} is immutable; deliberately remove ${snapshot} to drop that client, then rerun --snapshot`,
      )
    writeFileSync(snapshot, serialized)
    return
  }
  process.stdout.write(serializeRecordClientContract(entries))
}

if (import.meta.main) await main()

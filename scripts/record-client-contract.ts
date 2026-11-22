import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { configClient, type ConfigClient } from '../shared/config-client.ts'
import {
  recordApiClientOver,
  type RecordApiClient,
} from '../orchestrator/src/record/record-api-client.ts'
import { recordTransport } from '../orchestrator/src/record/record-api-client-transport.ts'
import { identity } from '../orchestrator/src/record/record-api-identity.fixture.ts'
import { idleRecordApiDeps, idleSubjectDeps } from '../orchestrator/test/fixtures/record-api.ts'
import { recordApiTestApp } from '../orchestrator/test/fixtures/record-api-app.ts'
import { registerRecordStorageRoute } from '../orchestrator/src/record/record-api-storage.ts'
import {
  installRecordToken,
} from '../orchestrator/test/fixtures/record-session.ts'
import { recordRequestHeaders } from '../shared/record-request-headers.ts'

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
export const CURRENT_CONTRACT_PATH = resolve(ROOT, 'scripts/quality/record-client-contract.json')
export const RELEASED_CONTRACT_DIRECTORY = resolve(
  ROOT,
  'scripts/quality/record-client-contracts',
)

const SAMPLE_ID = '01990000-0000-7000-8000-000000000001'
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
  'abandonTaskFlow', 'acceptBoardAnswer', 'acceptInvitation', 'addProjectSubject',
  'adoptTaskFlow', 'advanceTaskFlow', 'applySettingsAutoMode', 'applySettingsPermission',
  'attachTaskFlowText', 'awaitTaskFlowRuling', 'blockOutsideAuthor', 'cacheCounts',
  'completeBoardFilingLease', 'composeTaskFlow', 'consumeDoc', 'copyTaskFlowText', 'counts',
  'createOrganization', 'defineProjectSubject', 'deleteContextItem', 'deleteDoc', 'deleteSpace',
  'deleteTaskFlowText', 'deleteTrialSpace', 'draftWorkflow', 'ensureSpaceBuiltIns',
  'failBoardFilingLease', 'getBoardStatus', 'getBoardThread', 'getContextItem', 'getDoc',
  'getPublicDoc', 'grantConfigAccess', 'handoffTaskFlow', 'hideRow', 'importCanon', 'importDoc',
  'importLensCatalogue', 'importPortCatalogue', 'importQuestion', 'importTaskFlow',
  'importWorkflowCatalogue', 'inviteMember', 'listBoardChanges', 'listBoardClaims',
  'listBoardMessages', 'listChanges', 'listConfigAccess', 'listContextHolders',
  'listContextItems', 'listDocs', 'listHidden', 'listInvitations', 'listLensCatalogue',
  'listOutsideBlocks', 'listPortCatalogue', 'listProjectSubjects', 'listProjects',
  'listPublicDocs', 'listRevisions', 'listRoutingEvidence', 'listScores', 'listSnapshots',
  'listTaskFlowStages', 'listWorkflowCatalogue', 'noDestinationWrites', 'openBoardStream',
  'pauseOutsideIntake', 'postBoardMessage', 'promoteWorkflow', 'purgeProject',
  'putBoardReceipt', 'putSnapshot', 'readMembershipQuestions', 'readQuestions', 'readTaskFlow',
  'readTaskFlowObligation', 'readTaskFlowPresence', 'readTaskFlowProjectReferenceCounts',
  'readTaskFlowStage', 'readTaskFlowStageSummaries', 'readTaskFlowText', 'releaseBoardClaim',
  'releaseBoardTaskClaims', 'removeMember', 'renameMachine', 'renameProjectSubject',
  'renameSubject', 'renewBoardClaim', 'reorderDocs', 'reorderProjectSubjects', 'repinTaskFlow',
  'replyBoardMessage', 'restoreDoc', 'resumeOutsideIntake', 'retireMachine', 'retireProject',
  'retireProjectSubject', 'retireWorkflow', 'searchDocs', 'searchPublicDocs',
  'selectProjectLensProfile', 'setActiveOrganization', 'setOutsideIntake', 'showOutsideIntake',
  'storage', 'sync', 'takeBoardClaim', 'takeBoardFilingLease', 'takeBoardSuccessor',
  'unblockOutsideAuthor', 'unhideRow', 'updateTaskFlowStage', 'upsertContextItem', 'upsertDoc',
  'upsertLens', 'upsertLensProfile', 'upsertProject', 'whoami', 'withdrawBoardMessage',
  'withdrawConfigAccess', 'writePort', 'writeQuestion',
] as const

const CONFIG_SAMPLE_NAMES = [
  'addWraps', 'allocateMachineJoinNameplate', 'appendTrustLogEntry', 'claimMachineKey',
  'createDataKey', 'createMachineKeyClaimChallenge', 'currentDataKey',
  'deleteCredentialPreference', 'deleteEntry', 'deleteSecret', 'failMachineJoinNameplate',
  'getDataKey', 'getEntry', 'getSecret', 'listCredentialPreferences', 'listDataKeys',
  'listEntries', 'listMachineKeys', 'listSecrets', 'postMachineJoinMessage',
  'putCredentialPreference', 'putEntry', 'putSecret', 'readMachineJoinMessages', 'readTrustLog',
  'registerMachineKey', 'retireDataKey', 'revokeMachineKey', 'whoami',
] as const

export const recordClientSamples = Object.fromEntries(
  RECORD_SAMPLE_NAMES.map((name) => [`record.${name}`, name]),
) as Record<string, keyof RecordApiClient>
export const configClientSamples = Object.fromEntries(
  CONFIG_SAMPLE_NAMES.map((name) => [`config.${name}`, name]),
) as Record<string, keyof ConfigClient>

export function recordClientContractApp() {
  const unusedWrite = async () => ({})
  const app = recordApiTestApp(identity, { ...idleSubjectDeps(), ...idleRecordApiDeps() }, {
    listBoardChanges: async () => ({ changes: [], cursor: '0' }),
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
  })
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

export function createRecordingTransport(
  entries: RecordClientContractEntry[],
  sampleName: () => string,
  app = recordClientContractApp(),
): typeof fetch {
  return (async (input, init) => {
    const request = new Request(input, init)
    const recordedRequest = request.clone()
    const url = new URL(request.url)
    const response = await app.request(request).catch((error) =>
      Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 }),
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

function clientMembers(client: object, prefix: string): string[] {
  return Object.entries(client)
    .filter(([, value]) => typeof value === 'function')
    .map(([name]) => `${prefix}.${name}`)
    .sort()
}

export function missingClientSamples(record: RecordApiClient, config: ConfigClient): string[] {
  const sampled = new Set([...Object.keys(recordClientSamples), ...Object.keys(configClientSamples)])
  return [...clientMembers(record, 'record'), ...clientMembers(config, 'config')].filter(
    (name) => !sampled.has(name),
  )
}

const genericArguments = [
  SAMPLE_INPUT,
  SAMPLE_INPUT,
  SAMPLE_INPUT,
  SAMPLE_INPUT,
  SAMPLE_INPUT,
] as const

async function invokeSample(client: object, member: string): Promise<void> {
  const method = (client as Record<string, (...args: unknown[]) => unknown>)[member]
  if (!method) return
  const args: unknown[] = [...genericArguments]
  if (member === 'listBoardChanges') args.splice(0, args.length, { after: '0' }, SAMPLE_DESTINATION)
  if (member === 'listBoardMessages') args.splice(0, args.length, SAMPLE_INPUT)
  if (member === 'listContextItems') args.splice(0, args.length, ['sample'], SAMPLE_DESTINATION)
  if (member === 'openBoardStream') args.splice(0, args.length)
  if (member === 'postBoardMessage' || member === 'putBoardReceipt')
    args.splice(0, args.length, SAMPLE_INPUT, SAMPLE_DESTINATION)
  if (member === 'withdrawBoardMessage')
    args.splice(0, args.length, SAMPLE_ID, SAMPLE_DESTINATION, SAMPLE_INPUT)
  if (member === 'postMachineJoinMessage')
    args.splice(0, args.length, 'sample', 'client', 'one', new Uint8Array([1]), SAMPLE_DESTINATION)
  if (member === 'appendTrustLogEntry')
    args.splice(0, args.length, null, new Uint8Array([1]), SAMPLE_DESTINATION)
  try {
    const result = await method(...args)
    if (member === 'openBoardStream' && result && typeof result === 'object' && 'close' in result)
      (result as { close: () => void }).close()
  } catch (error) {
    // Contract generation cares about the request and response status, not client parsing.
    if (process.env.DEBUG_RECORD_CONTRACT) console.error(member, error)
  }
}

export async function generateRecordClientContract(): Promise<RecordClientContractEntry[]> {
  const entries: RecordClientContractEntry[] = []
  let activeSample = ''
  const transport = createRecordingTransport(entries, () => activeSample)
  const request = async (path: string, init: RequestInit & { destinationSpaceId?: string } = {}) => {
    const headers = recordRequestHeaders({
      bearerToken: 'contract-token',
      destinationSpaceId: init.destinationSpaceId,
      headers: init.headers,
    })
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
    const response = await recordTransport(
      'https://record.example.test',
      path,
      { ...init, headers },
      transport,
      () => undefined,
      () => 'bottega/contract',
    )
    const body = await response.json().catch(() => null)
    if (!response.ok) throw new Error(`record contract response ${response.status}`)
    return body
  }
  const record = recordApiClientOver(request, transport)
  const config = configClient({ BOTTEGA_RECORD_API_URL: 'https://record.example.test' }, transport, 'contract-token')
  const missing = missingClientSamples(record, config)
  if (missing.length) throw new Error(`record client contract lacks samples: ${missing.join(', ')}`)
  const previousUrl = process.env.BOTTEGA_RECORD_API_URL
  const previousNodeEnv = process.env.NODE_ENV
  const previousKeystore = process.env.BOTTEGA_KEYSTORE
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  process.env.NODE_ENV = 'development'
  process.env.BOTTEGA_KEYSTORE = 'keychain'
  installRecordToken('contract-token')
  try {
    for (const [sample, member] of Object.entries(recordClientSamples)) {
      activeSample = sample
      await invokeSample(record, member)
    }
    for (const [sample, member] of Object.entries(configClientSamples)) {
      activeSample = sample
      await invokeSample(config, member)
    }
  } finally {
    installRecordToken(null)
    if (previousUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = previousUrl
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    if (previousKeystore === undefined) delete process.env.BOTTEGA_KEYSTORE
    else process.env.BOTTEGA_KEYSTORE = previousKeystore
  }
  const recorded = new Set(entries.map((entry) => entry.sample))
  const unrecorded = [...Object.keys(recordClientSamples), ...Object.keys(configClientSamples)].filter(
    (sample) => !recorded.has(sample),
  )
  if (unrecorded.length) throw new Error(`record client samples sent no request: ${unrecorded.join(', ')}`)
  return entries.sort((a, b) => a.sample.localeCompare(b.sample))
}

export const serializeRecordClientContract = (entries: RecordClientContractEntry[]) =>
  `${JSON.stringify(entries, null, 2)}\n`

async function main() {
  const entries = await generateRecordClientContract()
  if (process.argv.includes('--update')) {
    writeFileSync(CURRENT_CONTRACT_PATH, serializeRecordClientContract(entries))
    return
  }
  if (process.argv.includes('--snapshot')) {
    const version = (JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { version: string })
      .version
    mkdirSync(RELEASED_CONTRACT_DIRECTORY, { recursive: true })
    writeFileSync(resolve(RELEASED_CONTRACT_DIRECTORY, `${version}.json`), serializeRecordClientContract(entries))
    return
  }
  process.stdout.write(serializeRecordClientContract(entries))
}

if (import.meta.main) await main()

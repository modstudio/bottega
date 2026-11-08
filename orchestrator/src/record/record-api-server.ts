// concern: record-api-server
/** Composes and serves the record API. Must not own record queries or authentication policy. */
import { readBuiltCommit } from '../../../shared/built-commit.ts'
import {
  HOSTED_SERVER_IDLE_TIMEOUT_SECONDS,
  hostedAccessLogLine,
} from '../../../shared/hosted-server.ts'
import { probeRecord, recordMigrationCount } from '../postgres/postgres-migrate.ts'
import { renameHostedMachine, retireHostedMachine } from './machine-name-record.ts'
import { recordApi } from './record-api.ts'
import { platformOwnerUserIds, registerRecordStorageRoute } from './record-api-storage.ts'
import {
  recordAllowedOrigins,
  recordAuth,
  recordIdentity,
  setActiveRecordSpaceForSession,
} from './record-auth.ts'
import { listHostedBoardChanges, readHostedBoardHead } from './record-board-changes.ts'
import {
  listHostedBoardClaims,
  releaseHostedBoardClaim,
  releaseHostedBoardTaskClaims,
  renewHostedBoardClaim,
  takeHostedBoardClaim,
} from './record-board-claims.ts'
import {
  acceptHostedBoardAnswer,
  completeHostedBoardFilingLease,
  failHostedBoardFilingLease,
  postHostedBoardMessage,
  readHostedBoardThread,
  replyHostedBoardMessage,
  takeHostedBoardFilingLease,
  withdrawHostedBoardMessage,
} from './record-board-messages.ts'
import { listHostedBoardOverview } from './record-board-overview.ts'
import { hostedBoardStatus, putHostedBoardReceipt } from './record-board-receipts.ts'
import { createBoardStreamRegistry } from './record-board-stream.ts'
import { takeHostedBoardSuccessor } from './record-board-successor.ts'
import { createBoardWakeSource } from './record-board-wake.ts'
import { importRecordCanon } from './record-canon-import.ts'
import {
  importRecordLensCatalogue,
  importRecordPortCatalogue,
  importRecordWorkflowCatalogue,
} from './record-catalogue-import.ts'
import { readRecordChangeFeed } from './record-change-feed.ts'
import { createRecordChangeWakeSource } from './record-change-wake.ts'
import {
  addDataKeyWraps,
  claimMachineKey,
  createDataKey,
  createMachineKeyClaimChallenge,
  currentDataKey,
  deleteConfigEntry,
  deleteConfigSecret,
  deleteDataKeyWraps,
  getConfigEntry,
  getConfigSecret,
  getDataKey,
  grantSpaceConfigAccess,
  listConfigEntries,
  listConfigSecrets,
  listDataKeys,
  listMachineKeys,
  listSpaceConfigAccess,
  putConfigEntry,
  putConfigSecret,
  registerMachineKey,
  retireDataKey,
  revokeMachineKey,
  withdrawSpaceConfigAccess,
} from './record-config.ts'
import {
  consumeRecordDoc,
  countRecordDocs,
  deleteRecordDoc,
  getRecordDoc,
  importRecordDoc,
  listRecordDocEntries,
  listRecordDocRevisions,
  renameRecordDocSubject,
  reorderRecordDocs,
  restoreRecordDoc,
  upsertRecordDoc,
} from './record-docs.ts'
import {
  listRecordLensCatalogue,
  selectRecordProjectLensProfile,
  upsertRecordLens,
  upsertRecordLensProfile,
} from './record-lens-catalogue.ts'
import { setSpaceMemberPermission } from './record-member-permission.ts'
import { hideRow, listHidden, unhideRow } from './record-moderation-hide.ts'
import {
  blockOutsideAuthor,
  listOutsideBlocks,
  unblockOutsideAuthor,
} from './record-outside-block.ts'
import {
  pauseOutsideIntake,
  resumeOutsideIntake,
  setOutsideIntake,
  showOutsideIntake,
} from './record-outside-intake.ts'
import { listPendingRecordInvitations } from './record-pending-invitations.ts'
import { closeRecordPools } from './record-pool.ts'
import { listRecordPortCatalogue, writeRecordPort } from './record-port-catalogue.ts'
import { RecordProjectSpaceConflictError } from './record-project-space-contract.ts'
import { isProjectRowLevelSecurityViolation } from './record-project-space-server.ts'
import { listRecordProjects, retireRecordProject, upsertRecordProject } from './record-projects.ts'
import {
  getPublicRecordDoc,
  listPublicRecordDocs,
  searchPublicRecordDocs,
  searchRecordDocs,
} from './record-public-docs.ts'
import { recordReleaseCheck } from './record-release-check.ts'
import { listRecordReleases, readLatestRecordReleases } from './record-releases.ts'
import { pruneRecordRetention, startRecordRetention } from './record-retention.ts'
import { getRecordReview, listRecordReviews } from './record-reviews.ts'
import { listRecordRoutingEvidence } from './record-routing-evidence.ts'
import { getRecordRun, listRecordRuns, viewRecordRuns } from './record-runs.ts'
import { applyRecordSettingsAutoMode, applyRecordSettingsPermission } from './record-settings.ts'
import { listRecordSnapshots, upsertRecordSnapshot } from './record-snapshots.ts'
import { ensureSpaceBuiltIns } from './record-space-built-ins.ts'
import { readRecordStorage } from './record-storage.ts'
import {
  addRecordSubject,
  defineRecordSubject,
  listRecordSubjects,
  renameRecordSubject,
  reorderRecordSubjects,
  retireRecordSubject,
} from './record-subjects.ts'
import { syncHostedRecord } from './record-sync-service.ts'
import { readRecordTaskFlow } from './record-task-flow.ts'
import { deleteTrialRecordSpace } from './record-trial-space-delete.ts'
import {
  countRecordScores,
  listRecordScores,
  unvoidRecordRun,
  upsertRecordScore,
  voidRecordRun,
} from './record-verdicts.ts'
import {
  draftRecordWorkflow,
  listRecordWorkflowCatalogue,
  promoteRecordWorkflow,
  retireRecordWorkflow,
} from './record-workflow-catalogue.ts'

type ServerEnvironment = Record<string, string | undefined>

function required(environment: ServerEnvironment, name: string): string {
  const value = environment[name]
  if (!value) throw new Error(`${name} is required to serve the record API`)
  return value
}

function recordApiServerConfig(environment: ServerEnvironment = process.env) {
  const port = Number(environment.PORT ?? '3000')
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('PORT must be an integer from 0 through 65535')
  }
  return {
    port,
    recordUrl: required(environment, 'BOTTEGA_RECORD_URL'),
    authDatabaseUrl: required(environment, 'RECORD_AUTH_DATABASE_URL'),
    authSecret: required(environment, 'BETTER_AUTH_SECRET'),
    authUrl: required(environment, 'BETTER_AUTH_URL'),
    hubUrl: required(environment, 'RECORD_HUB_URL'),
    allowedOrigins: recordAllowedOrigins(environment),
  }
}

export async function stopRecordApiServer(input: {
  stop(closeActiveConnections?: boolean): void | Promise<void>
  closeActiveConnections?: boolean
  boardWakeSource: { close(): Promise<void> }
  recordChangeWakeSource: { close(): Promise<void> }
  recordRetention: { stop(): void }
  boardStreamRegistry: ReturnType<typeof createBoardStreamRegistry>
  auth: { close(): Promise<void> }
}): Promise<void> {
  input.boardStreamRegistry.closeAll()
  input.recordRetention.stop()
  await input.boardWakeSource.close()
  await input.recordChangeWakeSource.close()
  await input.stop(input.closeActiveConnections)
  await Promise.all([input.auth.close(), closeRecordPools()])
}

function serveRecordApi(
  app: { fetch(request: Request): Response | Promise<Response> },
  port: number,
  boardWakeSource: Awaited<ReturnType<typeof createBoardWakeSource>>,
  recordChangeWakeSource: ReturnType<typeof createRecordChangeWakeSource>,
  boardStreamRegistry: ReturnType<typeof createBoardStreamRegistry>,
  recordRetention: { stop(): void },
  auth: ReturnType<typeof recordAuth>,
) {
  const server = Bun.serve({
    hostname: '0.0.0.0',
    idleTimeout: HOSTED_SERVER_IDLE_TIMEOUT_SECONDS,
    port,
    fetch: async (request, bunServer) => {
      const started = performance.now()
      if (request.method === 'GET' && new URL(request.url).pathname === '/v1/board/stream') {
        bunServer.timeout(request, 0)
      }
      const response = await app.fetch(request)
      console.log(
        hostedAccessLogLine({
          method: request.method,
          pathname: new URL(request.url).pathname,
          status: response.status,
          durationMs: performance.now() - started,
        }),
      )
      return response
    },
  })
  const stop = server.stop.bind(server)
  server.stop = async (closeActiveConnections) => {
    await stopRecordApiServer({
      stop,
      closeActiveConnections,
      boardWakeSource,
      recordChangeWakeSource,
      recordRetention,
      boardStreamRegistry,
      auth,
    })
  }
  return server
}

function recordDocDependencies() {
  return {
    listDocs: listRecordDocEntries,
    listPublicDocs: listPublicRecordDocs,
    readPublicDoc: getPublicRecordDoc,
    searchPublicDocs: searchPublicRecordDocs,
    searchDocs: searchRecordDocs,
    readDoc: getRecordDoc,
    listDocRevisions: listRecordDocRevisions,
    upsertDoc: upsertRecordDoc,
    reorderDocs: reorderRecordDocs,
    importDoc: importRecordDoc,
    importCanon: importRecordCanon,
    deleteDoc: deleteRecordDoc,
    consumeDoc: consumeRecordDoc,
    restoreDoc: restoreRecordDoc,
    renameDocSubject: renameRecordDocSubject,
    countDocs: countRecordDocs,
  }
}

function recordRunDependencies() {
  return {
    readRuns: listRecordRuns,
    readRunsWindow: viewRecordRuns,
    readRun: getRecordRun,
    listRoutingEvidence: listRecordRoutingEvidence,
    readReviews: listRecordReviews,
    readReview: getRecordReview,
  }
}

function recordLensDependencies() {
  return {
    ensureSpaceBuiltIns,
    listLensCatalogue: listRecordLensCatalogue,
    upsertLens: upsertRecordLens,
    upsertLensProfile: upsertRecordLensProfile,
    selectProjectLensProfile: selectRecordProjectLensProfile,
    importLensCatalogue: importRecordLensCatalogue,
    listPortCatalogue: listRecordPortCatalogue,
    writePort: writeRecordPort,
    importPortCatalogue: importRecordPortCatalogue,
    listWorkflowCatalogue: listRecordWorkflowCatalogue,
    draftWorkflow: draftRecordWorkflow,
    promoteWorkflow: promoteRecordWorkflow,
    retireWorkflow: retireRecordWorkflow,
    importWorkflowCatalogue: importRecordWorkflowCatalogue,
  }
}

function recordServerAuth(
  config: ReturnType<typeof recordApiServerConfig>,
  environment: ServerEnvironment,
) {
  return recordAuth(config.recordUrl, environment, config.authDatabaseUrl, undefined, undefined, {
    ensure: ensureSpaceBuiltIns,
  })
}

function recordSpaceAccessDependencies() {
  return {
    listSpaceConfigAccess,
    grantSpaceConfigAccess,
    setSpaceMemberPermission,
    withdrawSpaceConfigAccess,
    showOutsideIntake,
    setOutsideIntake,
    pauseOutsideIntake,
    resumeOutsideIntake,
    blockOutsideAuthor,
    listOutsideBlocks,
    unblockOutsideAuthor,
    hideRow,
    unhideRow,
    listHidden,
  }
}

function recordChangeDependencies(
  config: ReturnType<typeof recordApiServerConfig>,
  wake: ReturnType<typeof createRecordChangeWakeSource>,
) {
  return {
    readChanges: (input: Omit<Parameters<typeof readRecordChangeFeed>[0], 'url'>) =>
      readRecordChangeFeed({ ...input, url: config.recordUrl }),
    waitForRecordChange: (milliseconds: number, signal?: AbortSignal) =>
      wake.wait(milliseconds, signal),
  }
}

function recordScoreDependencies() {
  return {
    upsertScore: async (input: Parameters<typeof upsertRecordScore>[0]) =>
      upsertRecordScore({
        ...input,
        delivery: input.delivery as 'none' | 'partial' | 'full',
        quality: input.quality as 'wrong' | 'mixed' | 'right' | null,
        fidelity: input.fidelity as 'drifted' | 'partial' | 'faithful' | null,
      }),
    voidRun: voidRecordRun,
    unvoidRun: unvoidRecordRun,
    listScores: listRecordScores,
    countScores: countRecordScores,
  }
}

function registerStorageRoute(
  app: ReturnType<typeof recordApi>,
  config: ReturnType<typeof recordApiServerConfig>,
  environment: ServerEnvironment,
) {
  registerRecordStorageRoute(app, {
    platformOwnerUserIds: () => platformOwnerUserIds(environment),
    readStorage: () => readRecordStorage(config.recordUrl),
  })
}

function recordProjectDependencies() {
  return {
    readProjects: listRecordProjects,
    readTaskFlow: readRecordTaskFlow,
    upsertProject: async (input: Parameters<typeof upsertRecordProject>[0]) => {
      try {
        return await upsertRecordProject(input)
      } catch (error) {
        if (!isProjectRowLevelSecurityViolation(error)) throw error
        throw new RecordProjectSpaceConflictError({
          projectId: input.id,
          projectName: input.name,
          spaceId: input.spaceId,
        })
      }
    },
    retireProject: retireRecordProject,
  }
}

function recordBoardDependencies() {
  return {
    listBoardMessages: listHostedBoardOverview,
    postBoardMessage: postHostedBoardMessage,
    replyBoardMessage: replyHostedBoardMessage,
    withdrawBoardMessage: withdrawHostedBoardMessage,
    acceptBoardAnswer: acceptHostedBoardAnswer,
    takeBoardFilingLease: takeHostedBoardFilingLease,
    completeBoardFilingLease: completeHostedBoardFilingLease,
    failBoardFilingLease: failHostedBoardFilingLease,
    readBoardThread: readHostedBoardThread,
    putBoardReceipt: putHostedBoardReceipt,
    boardStatus: hostedBoardStatus,
    readBoardHead: readHostedBoardHead,
    listBoardChanges: listHostedBoardChanges,
    takeBoardSuccessor: takeHostedBoardSuccessor,
    takeBoardClaim: takeHostedBoardClaim,
    renewBoardClaim: renewHostedBoardClaim,
    releaseBoardClaim: releaseHostedBoardClaim,
    listBoardClaims: listHostedBoardClaims,
    releaseBoardTaskClaims: releaseHostedBoardTaskClaims,
  }
}

async function serveRecordApiWithAuth(
  config: ReturnType<typeof recordApiServerConfig>,
  auth: ReturnType<typeof recordAuth>,
  environment: ServerEnvironment,
) {
  const boardWakeSource = await createBoardWakeSource(config.recordUrl)
  const recordChangeWakeSource = createRecordChangeWakeSource(config.recordUrl)
  const boardStreamRegistry = createBoardStreamRegistry()
  const recordRetention = startRecordRetention({
    prune: () => pruneRecordRetention(config.recordUrl),
  })
  const migrations = recordMigrationCount()
  const app = recordApi({
    clientAddresses: { recordApiUrl: config.authUrl, hubHostedUrl: config.hubUrl },
    recordUrl: config.recordUrl,
    ...recordChangeDependencies(config, recordChangeWakeSource),
    allowedOrigins: config.allowedOrigins,
    ...recordApiAccessDependencies(config, auth, migrations),
    ...recordRunDependencies(),
    readReleases: listRecordReleases,
    readLatestReleases: readLatestRecordReleases,
    ...recordProjectDependencies(),
    ...recordLensDependencies(),
    listSubjects: listRecordSubjects,
    addSubject: addRecordSubject,
    renameSubject: renameRecordSubject,
    defineSubject: defineRecordSubject,
    reorderSubjects: reorderRecordSubjects,
    retireSubject: retireRecordSubject,
    ...recordDocDependencies(),
    ...recordSettingsDependencies(),
    ...recordScoreDependencies(),
    upsertSnapshot: upsertRecordSnapshot,
    listSnapshots: listRecordSnapshots,
    listConfigEntries,
    getConfigEntry,
    putConfigEntry,
    deleteConfigEntry,
    listConfigSecrets,
    getConfigSecret,
    putConfigSecret,
    deleteConfigSecret,
    currentDataKey,
    listDataKeys,
    getDataKey,
    createDataKey,
    addDataKeyWraps,
    retireDataKey,
    deleteDataKeyWraps,
    listMachineKeys,
    registerMachineKey,
    createMachineKeyClaimChallenge,
    claimMachineKey,
    revokeMachineKey,
    ...recordSpaceAccessDependencies(),
    ...recordBoardDependencies(),
    boardWakeSource,
    boardStreamRegistry,
    deleteTrialSpace: deleteTrialRecordSpace,
  })
  registerStorageRoute(app, config, environment)
  return serveRecordApi(
    app,
    config.port,
    boardWakeSource,
    recordChangeWakeSource,
    boardStreamRegistry,
    recordRetention,
    auth,
  )
}

export async function startRecordApiServer(environment: ServerEnvironment = process.env) {
  const config = recordApiServerConfig(environment)
  const auth = recordServerAuth(config, environment)
  try {
    return await serveRecordApiWithAuth(config, auth, environment)
  } catch (error) {
    await auth.close()
    throw error
  }
}

function recordSettingsDependencies() {
  return {
    applySettingsPermission: applyRecordSettingsPermission,
    applySettingsAutoMode: applyRecordSettingsAutoMode,
  }
}

function recordApiAccessDependencies(
  config: ReturnType<typeof recordApiServerConfig>,
  auth: ReturnType<typeof recordAuth>,
  migrations: number,
) {
  return {
    syncRecord: syncHostedRecord,
    renameMachine: renameHostedMachine,
    retireMachine: retireHostedMachine,
    auth,
    readSession: async (headers: Headers) => {
      const current = await auth.api.getSession({ headers })
      if (!current) return null
      return recordIdentity(
        config.recordUrl,
        current.user,
        current.session.activeOrganizationId ?? null,
      )
    },
    setActiveSpace: (headers: Headers, spaceId: string) =>
      setActiveRecordSpaceForSession(config.recordUrl, headers, spaceId),
    listInvitations: listPendingRecordInvitations,
    readHealth: async () => {
      try {
        await probeRecord(config.recordUrl)
        return { ok: true, migrations }
      } catch {
        return { ok: false, migrations }
      }
    },
    readCommit: readBuiltCommit,
  }
}

if (import.meta.main) {
  if (process.argv[2] === 'release-check') {
    try {
      await recordReleaseCheck('api')
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  } else {
    await startRecordApiServer()
  }
}

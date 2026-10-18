// concern: record-api-server
/** Composes and serves the record API. Must not own record queries or authentication policy. */
import { readBuiltCommit } from '../../../shared/built-commit.ts'
import { probeRecord, recordMigrationCount } from '../postgres/postgres-migrate.ts'
import { recordApi } from './record-api.ts'
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
import { createBoardWakeSource } from './record-board-wake.ts'
import { importRecordCanon } from './record-canon-import.ts'
import {
  addDataKeyWraps,
  createDataKey,
  currentDataKey,
  deleteConfigEntry,
  deleteConfigSecret,
  deleteDataKeyWraps,
  getConfigEntry,
  getConfigSecret,
  getDataKey,
  listConfigEntries,
  listConfigSecrets,
  listDataKeys,
  listMachineKeys,
  putConfigEntry,
  putConfigSecret,
  registerMachineKey,
  retireDataKey,
  revokeMachineKey,
} from './record-config.ts'
import {
  consumeRecordDoc,
  countRecordDocs,
  deleteRecordDoc,
  getRecordDoc,
  importRecordDoc,
  listRecordDocRevisions,
  listRecordDocs,
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
import { listPendingRecordInvitations } from './record-pending-invitations.ts'
import { listRecordProjects, retireRecordProject, upsertRecordProject } from './record-projects.ts'
import {
  getPublicRecordDoc,
  listPublicRecordDocs,
  searchPublicRecordDocs,
  searchRecordDocs,
} from './record-public-docs.ts'
import { recordReleaseCheck } from './record-release-check.ts'
import { listRecordReleases, readLatestRecordReleases } from './record-releases.ts'
import { getRecordReview, listRecordReviews } from './record-reviews.ts'
import { getRecordRun, listRecordRuns, viewRecordRuns } from './record-runs.ts'
import { applyRecordSettingsPermission } from './record-settings.ts'
import { listRecordSnapshots, upsertRecordSnapshot } from './record-snapshots.ts'
import {
  addRecordSubject,
  defineRecordSubject,
  listRecordSubjects,
  renameRecordSubject,
  reorderRecordSubjects,
  retireRecordSubject,
} from './record-subjects.ts'
import { syncHostedRecord } from './record-sync-service.ts'
import {
  countRecordScores,
  listRecordScores,
  unvoidRecordRun,
  upsertRecordScore,
  voidRecordRun,
} from './record-verdicts.ts'

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
    recordUrl: required(environment, 'ORCH_RECORD_URL'),
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
  boardStreamRegistry: ReturnType<typeof createBoardStreamRegistry>
}): Promise<void> {
  input.boardStreamRegistry.closeAll()
  await input.boardWakeSource.close()
  await input.stop(input.closeActiveConnections)
}

function serveRecordApi(
  app: { fetch(request: Request): Response | Promise<Response> },
  port: number,
  boardWakeSource: Awaited<ReturnType<typeof createBoardWakeSource>>,
  boardStreamRegistry: ReturnType<typeof createBoardStreamRegistry>,
) {
  const server = Bun.serve({
    hostname: '0.0.0.0',
    port,
    fetch: async (request, bunServer) => {
      const started = performance.now()
      if (request.method === 'GET' && new URL(request.url).pathname === '/v1/board/stream') {
        bunServer.timeout(request, 0)
      }
      const response = await app.fetch(request)
      console.log(
        `${request.method} ${new URL(request.url).pathname} ${response.status} ${Math.round(performance.now() - started)}ms`,
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
      boardStreamRegistry,
    })
  }
  return server
}

function recordDocDependencies() {
  return {
    listDocs: listRecordDocs,
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

function recordLensDependencies() {
  return {
    listLensCatalogue: listRecordLensCatalogue,
    upsertLens: upsertRecordLens,
    upsertLensProfile: upsertRecordLensProfile,
    selectProjectLensProfile: selectRecordProjectLensProfile,
  }
}

export async function startRecordApiServer(environment: ServerEnvironment = process.env) {
  const config = recordApiServerConfig(environment)
  const auth = recordAuth(config.recordUrl, environment, config.authDatabaseUrl)
  const boardWakeSource = await createBoardWakeSource(config.recordUrl)
  const boardStreamRegistry = createBoardStreamRegistry()
  const migrations = recordMigrationCount()
  const app = recordApi({
    clientAddresses: { recordApiUrl: config.authUrl, hubHostedUrl: config.hubUrl },
    recordUrl: config.recordUrl,
    allowedOrigins: config.allowedOrigins,
    ...recordApiAccessDependencies(config, auth, migrations),
    readRuns: listRecordRuns,
    readRunsWindow: viewRecordRuns,
    readRun: getRecordRun,
    readReviews: listRecordReviews,
    readReview: getRecordReview,
    readReleases: listRecordReleases,
    readLatestReleases: readLatestRecordReleases,
    readProjects: listRecordProjects,
    upsertProject: upsertRecordProject,
    retireProject: retireRecordProject,
    ...recordLensDependencies(),
    listSubjects: listRecordSubjects,
    addSubject: addRecordSubject,
    renameSubject: renameRecordSubject,
    defineSubject: defineRecordSubject,
    reorderSubjects: reorderRecordSubjects,
    retireSubject: retireRecordSubject,
    ...recordDocDependencies(),
    applySettingsPermission: applyRecordSettingsPermission,
    upsertScore: async (input) =>
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
    revokeMachineKey,
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
    boardWakeSource,
    boardStreamRegistry,
    readBoardHead: readHostedBoardHead,
    listBoardChanges: listHostedBoardChanges,
    takeBoardClaim: takeHostedBoardClaim,
    renewBoardClaim: renewHostedBoardClaim,
    releaseBoardClaim: releaseHostedBoardClaim,
    listBoardClaims: listHostedBoardClaims,
    releaseBoardTaskClaims: releaseHostedBoardTaskClaims,
  })
  return serveRecordApi(app, config.port, boardWakeSource, boardStreamRegistry)
}

function recordApiAccessDependencies(
  config: ReturnType<typeof recordApiServerConfig>,
  auth: ReturnType<typeof recordAuth>,
  migrations: number,
) {
  return {
    syncRecord: syncHostedRecord,
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

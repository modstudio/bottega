// concern: record-api-server
/** Composes and serves the record API. Must not own record queries or authentication policy. */
import { probeRecord, recordMigrationCount } from '../postgres/postgres-migrate.ts'
import { recordApi } from './record-api.ts'
import {
  recordAllowedOrigins,
  recordAuth,
  recordIdentity,
  setActiveRecordSpaceForSession,
} from './record-auth.ts'
import { listHostedBoardChanges } from './record-board-changes.ts'
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
import { putHostedBoardReceipt } from './record-board-receipts.ts'
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
  importRecordCanon,
  importRecordDoc,
  listRecordDocRevisions,
  listRecordDocs,
  renameRecordDocSubject,
  restoreRecordDoc,
  upsertRecordDoc,
} from './record-docs.ts'
import { listRecordProjects, retireRecordProject, upsertRecordProject } from './record-projects.ts'
import { recordReleaseCheck } from './record-release-check.ts'
import { getRecordReview, listRecordReviews } from './record-reviews.ts'
import { getRecordRun, listRecordRuns, viewRecordRuns } from './record-runs.ts'
import { applyRecordSettingsPermission } from './record-settings.ts'
import { listRecordSnapshots, upsertRecordSnapshot } from './record-snapshots.ts'
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

export function recordApiServerConfig(environment: ServerEnvironment = process.env) {
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

export function startRecordApiServer(environment: ServerEnvironment = process.env) {
  const config = recordApiServerConfig(environment)
  const auth = recordAuth(config.recordUrl, environment, config.authDatabaseUrl)
  const migrations = recordMigrationCount()
  const app = recordApi({
    recordUrl: config.recordUrl,
    allowedOrigins: config.allowedOrigins,
    auth,
    readSession: async (headers) => {
      const current = await auth.api.getSession({ headers })
      if (!current) return null
      return recordIdentity(
        config.recordUrl,
        current.user,
        current.session.activeOrganizationId ?? null,
      )
    },
    setActiveSpace: (headers, spaceId) =>
      setActiveRecordSpaceForSession(config.recordUrl, headers, spaceId),
    readHealth: async () => {
      try {
        await probeRecord(config.recordUrl)
        return { ok: true, migrations }
      } catch {
        return { ok: false, migrations }
      }
    },
    readRuns: listRecordRuns,
    readRunsWindow: viewRecordRuns,
    readRun: getRecordRun,
    readReviews: listRecordReviews,
    readReview: getRecordReview,
    readProjects: listRecordProjects,
    upsertProject: upsertRecordProject,
    retireProject: retireRecordProject,
    listDocs: listRecordDocs,
    readDoc: getRecordDoc,
    listDocRevisions: listRecordDocRevisions,
    upsertDoc: upsertRecordDoc,
    importDoc: importRecordDoc,
    importCanon: importRecordCanon,
    deleteDoc: deleteRecordDoc,
    consumeDoc: consumeRecordDoc,
    restoreDoc: restoreRecordDoc,
    renameDocSubject: renameRecordDocSubject,
    countDocs: countRecordDocs,
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
    postBoardMessage: postHostedBoardMessage,
    replyBoardMessage: replyHostedBoardMessage,
    withdrawBoardMessage: withdrawHostedBoardMessage,
    acceptBoardAnswer: acceptHostedBoardAnswer,
    takeBoardFilingLease: takeHostedBoardFilingLease,
    completeBoardFilingLease: completeHostedBoardFilingLease,
    failBoardFilingLease: failHostedBoardFilingLease,
    readBoardThread: readHostedBoardThread,
    putBoardReceipt: putHostedBoardReceipt,
    listBoardChanges: listHostedBoardChanges,
    takeBoardClaim: takeHostedBoardClaim,
    renewBoardClaim: renewHostedBoardClaim,
    releaseBoardClaim: releaseHostedBoardClaim,
    listBoardClaims: listHostedBoardClaims,
    releaseBoardTaskClaims: releaseHostedBoardTaskClaims,
  })
  return Bun.serve({
    hostname: '0.0.0.0',
    port: config.port,
    fetch: async (request) => {
      const started = performance.now()
      const response = await app.fetch(request)
      console.log(
        `${request.method} ${new URL(request.url).pathname} ${response.status} ${Math.round(performance.now() - started)}ms`,
      )
      return response
    },
  })
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
    startRecordApiServer()
  }
}

import { afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { seedNeutralCodexQuotaReading } from '../../test/fixtures/store.ts'
import * as productionModelHost from '../agent/model-host.ts'
import { workerHarnessName } from '../agent/worker-launch-env.ts'
import {
  type ConfinementEvent,
  classifyCheckoutChanges,
  freezeAfterCheckouts,
} from '../confinement/confinement.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { EMPTY_QUOTA_READINGS } from '../transport/quota-readings.ts'
import { EMPTY_VENDOR_USAGE } from '../transport/vendor-usage.ts'
import * as productionClaim from './run-claim.ts'
import * as productionClose from './run-close.ts'
import type { LiveInput, LiveResult } from './run-live.ts'
import * as productionLive from './run-live.ts'
import * as productionTerminal from './run-terminal.ts'
import * as productionWorkerHome from './run-worker-home.ts'

const directories: string[] = []
const originalClaimRun = productionClaim.claimRun
let classified: ConfinementEvent | null = null
let runLiveFixture: ((input: LiveInput) => Promise<LiveResult>) | null = null
let runUnderTest: typeof import('./run.ts').run
let caller: string

beforeEach(() => seedNeutralCodexQuotaReading())

async function loadRunUnderTest(): Promise<typeof import('./run.ts').run> {
  spyOn(productionClaim, 'claimRun').mockImplementation(
    async (input: Parameters<typeof productionClaim.claimRun>[0]) => {
      if (input.callerCwd !== caller) return originalClaimRun(input)
      const id = newRecordId()
      const started = Date.now()
      db()
        .query(
          `INSERT INTO run
           (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,
            session_id,cwd,repo,project_record_id)
           VALUES (?,1,?,'codex','understand','fixture',?,'fixture','running',NULL,?,?,?)`,
        )
        .run(
          id,
          new Date(started).toISOString(),
          Buffer.byteLength(input.prompt),
          input.callerCwd,
          input.runProjectName,
          input.runProjectId,
        )
      const promptPath = join(input.callerCwd, '.fixture-prompt.md')
      return {
        promptPath,
        outputPath: join(input.callerCwd, '.fixture-output.txt'),
        originalSchemaPath: undefined,
        textReplyContract: false,
        schemaPath: undefined,
        started,
        launchKey: null,
        runToken: 'fixture-token',
        claim: { id, recordId: id, number: 1, parentRunRecordId: null },
        keepTree: undefined,
        scratchDir: input.callerCwd,
        worktree: null,
        changes: null,
        isolatedCwd: null,
        removeIsolatedCwd: null,
        provisionedMcpConfig: null,
        retargetDiagnostic: null,
        mcpSetupHeader: null,
        mcpTrustGranted: false,
        grokMcpEnvironment: {},
        runtimeDir: input.callerCwd,
        runtimeDirExisted: true,
        cwd: input.callerCwd,
        prompt: input.prompt,
        mcpConnection: input.mcpConnection,
        usingMcp: input.usingMcp,
      }
    },
  )
  spyOn(productionLive, 'runLive').mockImplementation((input: LiveInput) => runLiveFixture!(input))
  spyOn(productionModelHost, 'ensureLocalHealth').mockImplementation(async () => ({
    ok: true,
    detail: 'fixture',
  }))
  spyOn(productionModelHost, 'tryWake').mockImplementation(() => ({
    sent: false,
    detail: 'fixture',
  }))
  spyOn(productionWorkerHome, 'prepareWorkerHomeLaunch').mockImplementation(
    async (input: Parameters<typeof productionWorkerHome.prepareWorkerHomeLaunch>[0]) => {
      // The real preparation refuses without a host Codex login, a host precondition rather than fixture behavior.
      const harness = workerHarnessName(input.agent)
      return {
        codexMcpCatalogues: [],
        environment: {},
        hasRunScopedHome: harness === 'codex' || harness === 'grok' || input.sandbox === 'srt',
        sandboxEnvironment: {},
      }
    },
  )
  spyOn(productionTerminal, 'finishRun').mockImplementation(
    async (input: {
      watchedCheckouts: Parameters<typeof freezeAfterCheckouts>[0]['watched']
      frozenBefore: Parameters<typeof classifyCheckoutChanges>[0]['before']
      callerRemoval: Parameters<typeof classifyCheckoutChanges>[0]['removal']
      started: number
      status: LiveResult['status']
      error: string | null
      failureKind: LiveResult['failureKind']
      output: string
      acceptedQuestions: LiveResult['acceptedQuestions']
      preConfinement: string | null
      artifactsPersisted: boolean
    }) => {
      const after = freezeAfterCheckouts({
        watched: input.watchedCheckouts,
        before: input.frozenBefore,
        removal: input.callerRemoval,
      })
      classified = classifyCheckoutChanges({
        before: input.frozenBefore,
        after: after.snapshots,
        removedCaller: after.removedCaller,
        ownDiffPaths: [],
        chainRoot: null,
        database: db(),
        startedAt: new Date(input.started).toISOString(),
        removal: input.callerRemoval,
      })
      return {
        status: input.status,
        error: input.error,
        failureKind: input.failureKind,
        changes: null,
        output: input.output,
        acceptedQuestions: input.acceptedQuestions,
        confinementEvent: classified,
        preConfinement: input.preConfinement,
        artifactsPersisted: input.artifactsPersisted,
      }
    },
  )
  spyOn(productionClose, 'closeRun').mockImplementation(
    async (input: Parameters<typeof productionClose.closeRun>[0]) => {
      throw Object.assign(new Error('fixture terminal outcome'), { runId: input.claim.id })
    },
  )
  return (await import('./run.ts')).run
}

beforeAll(async () => {
  caller = mkdtempSync(join(tmpdir(), 'orch-run-confinement-'))
  directories.push(caller)
  spawnFixtureGitSync(['init', '-b', 'main', caller])
  writeFileSync(join(caller, 'tracked.txt'), 'before\n')
  spawnFixtureGitSync(['-C', caller, 'add', 'tracked.txt'])
  spawnFixtureGitSync([
    '-C',
    caller,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'fixture',
  ])
  const settledIndexTime = new Date(Date.now() - 2_000)
  utimesSync(join(caller, '.git', 'index'), settledIndexTime, settledIndexTime)
  runLiveFixture = async (_input: LiveInput): Promise<LiveResult> => {
    writeFileSync(join(caller, 'tracked.txt'), 'after\n')
    utimesSync(join(caller, '.git', 'index'), settledIndexTime, settledIndexTime)
    return {
      proc: null,
      timer: null,
      checkpointTimer: null,
      resourceObserver: null,
      timedOut: false,
      idleKilled: false,
      idleKillError: null,
      idleUnkillable: false,
      idleTreePids: [],
      idleTreePgid: null,
      exitCode: 1,
      output: '',
      vendorTokens: null,
      callUsage: null,
      costUsd: null,
      vendorUsage: EMPTY_VENDOR_USAGE,
      quotaReadings: EMPTY_QUOTA_READINGS,
      resolvedSession: null,
      effectiveModel: null,
      replyFileError: null,
      replyFilePresent: false,
      contract: null,
      contractObjects: 0,
      acceptedQuestions: [],
      status: 'failed',
      error: 'fixture terminal outcome',
      failureKind: 'other',
      artifactsPersisted: true,
      preConfinement: null,
      vendorTerminatedStream: null,
      askLoopback: null,
      mcpSetupHeader: null,
      workerEvents: [],
    }
  }
  runUnderTest = await loadRunUnderTest()
})

afterEach(() => {
  mock.restore()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('run carries its before-snapshots into terminal confinement classification', async () => {
  classified = null
  upsertProject({
    recordId: newRecordId(),
    name: 'run-confinement-handoff-fixture',
    path: caller,
    settings: { trunk: 'main' },
  })
  await expect(
    runUnderTest({
      job: 'understand',
      prompt: 'confinement handoff fixture',
      agent: 'codex',
      agentExplicit: true,
      cwd: caller,
      launchCwd: caller,
      repo: 'run-confinement-handoff-fixture',
      noFailover: true,
    }),
  ).rejects.toMatchObject({ message: 'fixture terminal outcome' })

  expect(classified).toMatchObject({
    classification: 'non_overlapping',
    checkout: realpathSync(caller),
  })
})

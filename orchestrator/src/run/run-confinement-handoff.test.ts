import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import {
  type ConfinementEvent,
  classifyCheckoutChanges,
  freezeAfterCheckouts,
} from '../confinement/confinement.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { EMPTY_VENDOR_USAGE } from '../transport/vendor-usage.ts'
import { type ClaimInput, claimRun as productionClaimRun } from './run-claim.ts'
import type { LiveInput, LiveResult } from './run-live.ts'

const directories: string[] = []
const originalClaimRun = productionClaimRun
let classified: ConfinementEvent | null = null
let runLiveFixture: ((input: LiveInput) => Promise<LiveResult>) | null = null
let runUnderTest: typeof import('./run.ts').run
let caller: string

async function loadRunUnderTest(): Promise<typeof import('./run.ts').run> {
  mock.module('./run-claim.ts', () => ({
    claimRun: async (input: ClaimInput) => {
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
        claim: { id, recordId: id, number: 1 },
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
        sandboxRunDir: input.callerCwd,
        sandboxRunDirExisted: true,
        cwd: input.callerCwd,
        prompt: input.prompt,
        mcpConnection: input.mcpConnection,
        usingMcp: input.usingMcp,
      }
    },
  }))
  mock.module('./run-live.ts', () => ({
    runLive: (input: LiveInput) => runLiveFixture!(input),
  }))
  mock.module('../agent/model-host.ts', () => ({
    ensureLocalHealth: async () => ({ ok: true, detail: 'fixture' }),
    tryWake: () => ({ sent: false, detail: 'fixture' }),
  }))
  mock.module('./run-terminal.ts', () => ({
    finishRun: async (input: {
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
  }))
  mock.module('./run-close.ts', () => ({
    closeRun: async (input: { claim: { id: string } }) => {
      throw Object.assign(new Error('fixture terminal outcome'), { runId: input.claim.id })
    },
  }))
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
      costUsd: null,
      vendorUsage: EMPTY_VENDOR_USAGE,
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
  try {
    await runUnderTest({
      job: 'understand',
      prompt: 'confinement handoff fixture',
      agent: 'codex',
      agentExplicit: true,
      cwd: caller,
      launchCwd: caller,
      repo: 'run-confinement-handoff-fixture',
      noFailover: true,
    })
  } catch {}

  expect(classified).toMatchObject({
    classification: 'non_overlapping',
    checkout: realpathSync(caller),
  })
})

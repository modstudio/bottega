import { afterEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { EMPTY_VENDOR_USAGE } from '../transport/vendor-usage.ts'
import type { LiveInput, LiveResult } from './run-live.ts'

const directories: string[] = []

afterEach(() => {
  mock.restore()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('run carries its before-snapshots into terminal confinement classification', async () => {
  const caller = mkdtempSync(join(tmpdir(), 'orch-run-confinement-'))
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
  upsertProject({
    recordId: newRecordId(),
    name: 'run-confinement-handoff-fixture',
    path: caller,
    settings: { trunk: 'main' },
  })

  const runLive = async (_input: LiveInput): Promise<LiveResult> => {
    writeFileSync(join(caller, 'tracked.txt'), 'after\n')
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
      failureKind: 'agent',
      artifactsPersisted: true,
      preConfinement: null,
      vendorTerminatedStream: null,
      askLoopback: null,
      mcpSetupHeader: null,
      workerEvents: [],
    }
  }
  mock.module('./run-live.ts', () => ({ runLive }))
  const { run } = await import('./run.ts')

  let runId: string | null = null
  try {
    await run({
      job: 'implement',
      prompt: 'confinement handoff fixture',
      agent: 'codex',
      agentExplicit: true,
      cwd: caller,
      launchCwd: caller,
      repo: 'run-confinement-handoff-fixture',
      noFailover: true,
    })
  } catch (error) {
    runId = (error as Error & { runId?: string }).runId ?? null
  }

  expect(runId).not.toBeNull()
  const row = db().query('SELECT confinement FROM run WHERE record_id=?').get(runId!) as {
    confinement: string | null
  }
  expect(JSON.parse(row.confinement!)).toMatchObject({
    classification: 'non_overlapping',
    checkout: realpathSync(caller),
  })
})

import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import type { HostLoad } from '../gate-load.ts'
import { upsertProject } from '../project/projects.ts'
import { type ClaimInput, claimRun } from './run-claim.ts'

const available = (): HostLoad => ({
  gates: 0,
  loadavg: 0,
  cpuBusy: 0,
  ncpu: 8,
  freeMem: 8 * 1024 * 1024 * 1024,
  pressure: 'normal',
  swapUsed: 0,
  swapTotal: 0,
  swapGrowthBytesPerSec: null,
  recentAdmissions: 0,
  waitingRequests: 0,
  oldestWaitMs: 0,
})

test('claim records host admission before its repository tree plan runs', async () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'claim-admission-order-'))
  const projectRecordId = newRecordId()
  const prompt = 'admit before the deliberately invalid repository tree plan'
  upsertProject({ recordId: projectRecordId, name: 'admission-order-fixture', path: runsDir })
  const input: ClaimInput = {
    opts: { job: 'file-question' },
    runsDir,
    stamp: 'claim-admission-order',
    name: 'codex',
    generatedSchema: null,
    originalPrompt: prompt,
    prompt,
    callerCwd: runsDir,
    seed: undefined,
    writesJob: false,
    repoJob: true,
    runProjectName: 'admission-order-fixture',
    runProjectId: projectRecordId,
    reason: 'test',
    vendorSession: null,
    pack: null,
    mcpRequest: undefined,
    transportName: 'cli',
    a: AGENTS.codex!,
    mcpConnection: null,
    mcpMode: null,
    declaredDeliverables: [],
    timeoutMinutes: undefined,
    timeoutMs: 60_000,
    forbidsRepo: false,
    reviewTarget: null,
    implicitReview: { branch: null, findings: false },
    coverageBase: null,
    readOnlyBase: null,
    deferredCwdMcpPlan: [],
    usingMcp: false,
    startedByUserId: null,
    replySchemaName: 'WORKER_SCHEMA',
    carriedQuestionIds: [],
    endpointKeySource: 'project',
    assertDispatchAllowed: () => {},
    admitDeps: {
      env: {},
      platform: 'linux',
      measure: available,
      sleep: async () => {},
    },
  }

  try {
    await expect(claimRun(input)).rejects.toThrow(`not a git repository: ${runsDir}`)
    const row = db().query('SELECT host_admission FROM run WHERE prompt_head=?').get(prompt) as {
      host_admission: string
    }
    expect(JSON.parse(row.host_admission)).toMatchObject({ decision: 'admit' })
  } finally {
    rmSync(runsDir, { recursive: true, force: true })
  }
})

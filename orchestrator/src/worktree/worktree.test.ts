import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import type { RecipeSnapshot } from '../recipe/tracked-recipe.ts'
import { type CreateWorkerWorktreeOptions, recordProvisioning } from './worktree.ts'

const hostLoad = {
  gates: 0,
  loadavg: 0,
  cpuBusy: null,
  ncpu: 1,
  freeMem: 1,
  pressure: 'normal' as const,
  swapUsed: 0,
  swapTotal: 0,
  swapGrowthBytesPerSec: null,
  recentAdmissions: 0,
  waitingRequests: 0,
  oldestWaitMs: 0,
  liveRuns: 1,
}

test("a continued turn's provisioning measurement reads declared paths from the root snapshot", () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
  const turn = addRun({ agent: 'codex', job: 'implement', parent: root, turn: 2 })
  const tree = mkdtempSync(join(tmpdir(), 'orch-provisioning-measurement-'))
  try {
    mkdirSync(join(tree, 'declared-cache'))
    writeFileSync(join(tree, 'declared-cache', 'entry'), 'measured')
    const snapshot: RecipeSnapshot = {
      source: { path: `${PLATFORM_SLUG}.jsonc`, commit: 'fixture' },
      recipe: { create: [], provision: [{ path: 'declared-cache', method: 'clone' }] },
    }
    db()
      .query('UPDATE run SET recipe_snapshot=? WHERE record_id=?')
      .run(JSON.stringify(snapshot), root)

    recordProvisioning(
      {
        tool: null,
        cwd: tree,
        mainProjectPath: tree,
        runId: turn,
        writes: true,
        readOnlyBase: 'HEAD',
        record: () => undefined,
        detached: false,
      } satisfies CreateWorkerWorktreeOptions,
      performance.now(),
      hostLoad,
      'ok',
      { path: tree, branch: 'DEV-1447-test', base: 'fixture', repoRoot: tree },
    )

    const measured = db()
      .query('SELECT provisioning_entry_roots FROM run WHERE record_id=?')
      .get(turn) as { provisioning_entry_roots: string }
    expect(JSON.parse(measured.provisioning_entry_roots)).toContain('declared-cache')
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
})

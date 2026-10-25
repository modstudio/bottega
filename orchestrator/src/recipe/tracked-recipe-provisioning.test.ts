import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso } from '../database/db.ts'
import { git } from '../git/git-environment.ts'
import { createTrackedRecipe } from './tracked-recipe.ts'

test('records declared dependencies once and clone mechanisms separately', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'orch-provisioning-phases-'))
  try {
    git(['init', '--initial-branch=main'], repoRoot)
    writeFileSync(join(repoRoot, '.gitignore'), 'vendor/\n')
    writeFileSync(
      join(repoRoot, `${PLATFORM_SLUG}.jsonc`),
      JSON.stringify({
        worktree: { provision: [{ path: 'vendor', method: 'clone' }], create: [] },
      }),
    )
    git(['add', '.'], repoRoot)
    git(
      [
        '-c',
        'user.name=Orch Test',
        '-c',
        'user.email=orch@example.invalid',
        'commit',
        '-m',
        'fixture',
      ],
      repoRoot,
    )
    mkdirSync(join(repoRoot, 'vendor'))
    writeFileSync(join(repoRoot, 'vendor', 'dependency'), 'ready')

    const database = db()
    const projectId = database
      .query<{ record_id: string }, [string]>(
        "INSERT INTO project(record_id,name,path,canon) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'provisioning-phases',?,1) RETURNING record_id",
      )
      .get(repoRoot)!.record_id
    const runId = database
      .query<{ id: string }, [string, string, string]>(
        `INSERT INTO run
           (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id,turn)
           VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),?,'codex','implement','sha',1,'provisioning phases','running',?,1)
           RETURNING record_id AS id`,
      )
      .get(newRecordId(), nowIso(), projectId)!.id
    const path = join(repoRoot, '.claude', 'worktrees', `orch-${runId}`)

    createTrackedRecipe({
      tool: { recipePath: `${PLATFORM_SLUG}.jsonc` },
      repoRoot,
      runId,
      branch: `DEV-1492-orch-${runId}`,
      name: `orch-${runId}`,
      path,
      attribute() {},
      verify() {},
      remove: () => ({ removed: false, detail: 'unused' }),
      removeProvisioned: () => ({ removed: false, detail: 'unused' }),
    })

    const row = database
      .query<{ provisioning_phases: string }, [string]>(
        'SELECT provisioning_phases FROM run WHERE record_id=?',
      )
      .get(runId)!
    const dependencyPhases = (
      JSON.parse(row.provisioning_phases) as { phase: string; name: string }[]
    )
      .filter(({ phase }) => phase === 'dependency' || phase === 'clone')
      .map(({ phase, name }) => ({ phase, name }))
    expect(dependencyPhases).toEqual([
      { phase: 'clone', name: expect.stringMatching(/^vendor \((clonefile|cp)\)$/) },
      { phase: 'dependency', name: 'declared dependencies' },
    ])
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

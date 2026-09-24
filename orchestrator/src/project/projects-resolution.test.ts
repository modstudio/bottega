import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db, writableDb } from '../database/db.ts'
import {
  type ProjectReferenceCounts,
  projectAt,
  projectByName,
  projectRemovalRefusal,
  projects,
  removeProject,
  retiredProjectAt,
  retiredProjectByName,
  retiredProjectRefusal,
  retireProject,
  stackAt,
  unretireProject,
  upsertProject,
  validateProjectSettings,
} from './projects.ts'

const none: ProjectReferenceCounts = {
  run: 0,
  resource_claim: 0,
  canon_pack: 0,
  landing: 0,
  landing_override: 0,
  landing_review_carry: 0,
  doc: 0,
  doc_revision: 0,
  review: 0,
}

let projectDirectory: string | null = null

afterEach(() => {
  if (projectDirectory) rmSync(projectDirectory, { recursive: true, force: true })
  projectDirectory = null
})

describe('projects are data, not code', () => {
  test('checks accept only the two optional boolean switches', () => {
    expect(validateProjectSettings({ checks: { spelling: true, attribution: false } })).toEqual([])
    expect(
      validateProjectSettings({ checks: { spelling: 'yes' } as unknown as { spelling: boolean } }),
    ).toContain('checks.spelling must be a boolean')
    expect(
      validateProjectSettings({ checks: { unknown: true } as unknown as { spelling: boolean } }),
    ).toContain('checks.unknown is not a recognised check')
    expect(
      validateProjectSettings({ checks: null } as unknown as Parameters<
        typeof validateProjectSettings
      >[0]),
    ).toContain('checks must be an object')
  })

  test('readonly_docker must be boolean when present', () => {
    expect(
      validateProjectSettings({
        worktree: { readonly_docker: 'yes' } as unknown as { readonly_docker: boolean },
      }),
    ).toContain('worktree.readonly_docker must be a boolean')
    expect(validateProjectSettings({ worktree: { readonly_docker: true } })).toEqual([])
  })

  test('a directory belongs to the project that contains it', () => {
    upsertProject({ name: 'alpha', path: '/w/alpha', stack: 'php-laravel' })
    expect(projectAt('/w/alpha')?.name).toBe('alpha')
    expect(projectAt('/w/alpha/src/deep/file')?.name).toBe('alpha')
    // The case the old path regex could never handle, and the reason
    // containment beats pattern-matching: a worktree lives inside its project.
    expect(projectAt('/w/alpha/.claude/worktrees/orch-12')?.name).toBe('alpha')
    expect(stackAt('/w/alpha/.claude/worktrees/orch-12')).toBe('php-laravel')
  })

  test('an unregistered directory is null, not a guess', () => {
    upsertProject({ name: 'alpha', path: '/w/alpha' })
    expect(projectAt('/somewhere/else')).toBeNull()
    // Not '/w/alphabet': containment must respect the path separator, or a
    // project named as a prefix of another would swallow it.
    expect(projectAt('/w/alphabet')).toBeNull()
  })

  test('the longest matching path wins, so nesting resolves inward', () => {
    upsertProject({ name: 'outer', path: '/w' })
    upsertProject({ name: 'inner', path: '/w/inner' })
    expect(projectAt('/w/inner/src')?.name).toBe('inner')
    expect(projectAt('/w/other')?.name).toBe('outer')
  })

  test('settings survive a round trip', () => {
    upsertProject({
      name: 'alpha',
      path: '/w/alpha',
      settings: { trunk: 'develop', states: { in_progress: 'active' } },
    })
    const p = projectAt('/w/alpha')!
    expect(p.settings.trunk).toBe('develop')
    expect(p.settings.states?.in_progress).toBe('active')
  })

  test('registration validates a tracked recipe at its project path', () => {
    projectDirectory = mkdtempSync(join(tmpdir(), 'orch-project-recipe-'))
    writeFileSync(join(projectDirectory, 'worktree.jsonc'), '{"worktree":{"create":[]}}')
    expect(
      validateProjectSettings({ worktree: { recipePath: 'worktree.jsonc' } }, projectDirectory),
    ).toEqual([])
    writeFileSync(
      join(projectDirectory, 'worktree.jsonc'),
      '{"worktree":{"create":[],"unknown":true}}',
    )
    expect(
      validateProjectSettings(
        { worktree: { recipePath: 'worktree.jsonc' } },
        projectDirectory,
      ).join('\n'),
    ).toContain('unknown-key rule')
  })

  test('registration accepts a shadowed tracked recipe beside an inline recipe', () => {
    expect(
      validateProjectSettings({
        worktree: { recipe: {}, recipePath: '.orch/worktree.jsonc' },
      }),
    ).toEqual([])
  })
})

describe('DEV-587 referenced projects are retired, not unstitched', () => {
  test('projectRemovalRefusal is null for all-zero counts', () => {
    expect(projectRemovalRefusal('ghost', none)).toBeNull()
  })

  test('projectRemovalRefusal names only non-zero tables', () => {
    expect(projectRemovalRefusal('kept', { ...none, run: 2, resource_claim: 1, doc: 4 })).toEqual([
      'project kept is referenced by 2 run(s), 1 claim(s), 4 doc(s); removing it would blank their project attribution',
      'cleared by: orch project retire kept',
    ])
  })

  test('a project with a run refuses removal and keeps the run attributed', () => {
    upsertProject({ name: 'kept-run', path: '/w/kept-run' })
    const project = projectByName('kept-run')!
    writableDb()
    db()
      .query(
        `INSERT INTO run (started_at, agent, job, project_id, prompt_sha, prompt_bytes, prompt_head, status)
         VALUES ('t', 'a', 'understand', ?, 'sha', 1, 'h', 'ok')`,
      )
      .run(project.id)
    expect(() => removeProject('kept-run')).toThrow(
      'project kept-run is referenced by 1 run(s); removing it would blank their project attribution\n' +
        'cleared by: orch project retire kept-run',
    )
    expect(projectByName('kept-run')?.id).toBe(project.id)
    expect(
      (
        db().query('SELECT project_id FROM run WHERE project_id=?').get(project.id) as {
          project_id: number
        }
      ).project_id,
    ).toBe(project.id)
  })

  test('a project with nothing referencing it still removes', () => {
    upsertProject({ name: 'ephemeral', path: '/w/ephemeral' })
    expect(removeProject('ephemeral')).toBe(true)
    expect(projectByName('ephemeral')).toBeNull()
  })

  test('retire stamps retired_at and hides the row from acting reads', () => {
    upsertProject({ name: 'tombstoned', path: '/w/tombstoned' })
    expect(retireProject('tombstoned')).toBe('retired')
    const retired = projects({ retired: true }).find((project) => project.name === 'tombstoned')
    expect(retired?.retiredAt).toBeTruthy()
    expect(projects().some((project) => project.name === 'tombstoned')).toBe(false)
    expect(projectByName('tombstoned')).toBeNull()
    expect(projectAt('/w/tombstoned')).toBeNull()
    expect(retiredProjectByName('tombstoned')?.id).toBe(retired!.id)
    expect(retiredProjectAt('/w/tombstoned')?.name).toBe('tombstoned')
    expect(retiredProjectRefusal('tombstoned')).toBe(
      'project tombstoned is retired; cleared by: orch project retire tombstoned --undo',
    )
    expect(retireProject('tombstoned')).toBe('already-retired')
  })

  test('undo and re-add restore a retired name', () => {
    upsertProject({ name: 'restored', path: '/w/restored' })
    expect(retireProject('restored')).toBe('retired')
    expect(unretireProject('restored')).toBe(true)
    expect(projectByName('restored')?.path).toBe('/w/restored')
    expect(projectByName('restored')?.retiredAt).toBeNull()
    expect(retireProject('restored')).toBe('retired')
    upsertProject({ name: 'restored', path: '/w/restored-next', stack: 'node' })
    const live = projectByName('restored')
    expect(live?.path).toBe('/w/restored-next')
    expect(live?.stack).toBe('node')
    expect(live?.retiredAt).toBeNull()
  })
})

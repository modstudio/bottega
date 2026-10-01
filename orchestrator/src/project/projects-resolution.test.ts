import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codeSearchCommand } from '../code/code-commands.ts'
import { db, writableDb } from '../database/db.ts'
import {
  type ProjectReferenceCounts,
  projectAt,
  projectByName,
  projectRemovalRefusal,
  projectRepositoryRefusal,
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
  landing_triage_snapshot: 0,
  review_read: 0,
  doc: 0,
  doc_revision: 0,
  review: 0,
}

let projectDirectory: string | null = null

function repository(name = 'repository'): string {
  if (!projectDirectory) projectDirectory = mkdtempSync(join(tmpdir(), 'orch-project-resolution-'))
  const path = join(projectDirectory, name)
  mkdirSync(path, { recursive: true })
  const initialized = Bun.spawnSync(['git', 'init', '-b', 'main'], {
    cwd: path,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString())
  return path
}

afterEach(() => {
  if (projectDirectory) rmSync(projectDirectory, { recursive: true, force: true })
  projectDirectory = null
})

describe('projects are data, not code', () => {
  test('code search opt-in is a boolean-only project setting', () => {
    expect(validateProjectSettings({ search: { code: true } })).toEqual([])
    expect(
      validateProjectSettings({ search: { code: 'yes' } } as unknown as Parameters<
        typeof validateProjectSettings
      >[0]),
    ).toContain('search.code must be a boolean')
  })

  test('main stack consumers are explicit and validated', () => {
    expect(
      validateProjectSettings({ mainStack: { consumers: ['gate', 'worktree-create'] } }),
    ).toEqual([])
    expect(
      validateProjectSettings({ mainStack: { consumers: ['unknown'] } } as unknown as Parameters<
        typeof validateProjectSettings
      >[0]),
    ).toEqual(['mainStack.consumers entries must be gate or worktree-create'])
  })

  test('checks accept the optional policy shapes', () => {
    expect(
      validateProjectSettings({
        checks: {
          spelling: true,
          attribution: false,
          commentTaskKeys: true,
          commentHistory: { phrases: ['used to'] },
        },
      }),
    ).toEqual([])
    expect(
      validateProjectSettings({ checks: { spelling: 'yes' } as unknown as { spelling: boolean } }),
    ).toContain('checks.spelling must be a boolean')
    expect(
      validateProjectSettings({ checks: { unknown: true } as unknown as { spelling: boolean } }),
    ).toContain('checks.unknown is not a recognized check')
    expect(
      validateProjectSettings({
        checks: { commentTaskKeys: 'yes' },
      } as unknown as Parameters<typeof validateProjectSettings>[0]),
    ).toContain('checks.commentTaskKeys must be a boolean')
    expect(
      validateProjectSettings({
        checks: { commentHistory: { phrases: [''] } },
      }),
    ).toContain('checks.commentHistory.phrases must be an array of non-empty strings')
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

  test('managedContext must be boolean when present', () => {
    expect(
      validateProjectSettings({
        managedContext: 'yes',
      } as unknown as Parameters<typeof validateProjectSettings>[0]),
    ).toContain('managedContext must be a boolean')
  })

  test('validates only key prefixes being written against register rows', () => {
    const register = [{ name: 'existing', settings: { keyPrefixes: ['DEV'] } }]
    expect(
      validateProjectSettings({ keyPrefixes: ['TASK'] }, undefined, {
        validateKeyPrefixes: true,
        currentProjectName: 'new',
        register,
      }),
    ).toContain('key prefix TASK is reserved')
    expect(
      validateProjectSettings({ keyPrefixes: ['TASK'] }, undefined, {
        validateKeyPrefixes: true,
        currentProjectName: 'tasks',
        register,
      }),
    ).toEqual([])
    expect(
      validateProjectSettings({ keyPrefixes: ['DEV'] }, undefined, {
        validateKeyPrefixes: true,
        currentProjectName: 'new',
        register,
      }),
    ).toContain('key prefix DEV is already used by another project')
    expect(validateProjectSettings({ keyPrefixes: ['legacy-invalid'] })).toEqual([])
  })

  test('a directory belongs to the project that contains it', () => {
    const path = repository('alpha')
    upsertProject({ name: 'alpha', path, stack: 'php-laravel' })
    expect(projectAt(path)?.name).toBe('alpha')
    expect(projectAt(join(path, 'src/deep/file'))?.name).toBe('alpha')
    // The case the old path regex could never handle, and the reason
    // containment beats pattern-matching: a worktree lives inside its project.
    expect(projectAt(join(path, '.claude/worktrees/orch-12'))?.name).toBe('alpha')
    expect(stackAt(join(path, '.claude/worktrees/orch-12'))).toBe('php-laravel')
  })

  test('an unregistered directory is null, not a guess', () => {
    upsertProject({ name: 'alpha', path: '/w/alpha' })
    expect(projectAt('/somewhere/else')).toBeNull()
    // Not '/w/alphabet': containment must respect the path separator, or a
    // project named as a prefix of another would swallow it.
    expect(projectAt('/w/alphabet')).toBeNull()
  })

  test('an arbitrarily named non-repository project never resolves from cwd', () => {
    projectDirectory = mkdtempSync(join(tmpdir(), 'orch-tasks-project-'))
    upsertProject({ name: 'notes-only', path: projectDirectory })
    expect(projectAt(projectDirectory)).toBeNull()
    expect(projectAt(join(projectDirectory, 'child'))).toBeNull()
    expect(projectRepositoryRefusal(projectByName('notes-only')!)).toBe(
      `project notes-only has no repository: ${projectDirectory} is not a git checkout`,
    )
  })

  test('code search refuses a caller checkout outside the selected project', async () => {
    upsertProject({
      name: 'alpha',
      path: '/w/alpha',
      settings: { search: { code: true } },
    })
    await expect(
      codeSearchCommand(
        'meaning',
        {
          has: () => false,
          flag: (name) => (name === 'project' ? 'alpha' : undefined),
        },
        { cwd: () => '/somewhere/else', log: () => undefined },
      ),
    ).rejects.toThrow("caller's checkout does not belong")
  })

  test('the longest matching path wins, so nesting resolves inward', () => {
    const outer = repository('outer')
    const inner = repository('outer/inner')
    upsertProject({ name: 'outer', path: outer })
    upsertProject({ name: 'inner', path: inner })
    expect(projectAt(join(inner, 'src'))?.name).toBe('inner')
    expect(projectAt(join(outer, 'other'))?.name).toBe('outer')
  })

  test('settings survive a round trip', () => {
    const path = repository('alpha-settings')
    upsertProject({
      name: 'alpha',
      path,
      settings: { trunk: 'develop', states: { in_progress: 'active' } },
    })
    const p = projectAt(path)!
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
    const path = repository('tombstoned')
    upsertProject({ name: 'tombstoned', path })
    expect(retireProject('tombstoned')).toBe('retired')
    const retired = projects({ retired: true }).find((project) => project.name === 'tombstoned')
    expect(retired?.retiredAt).toBeTruthy()
    expect(projects().some((project) => project.name === 'tombstoned')).toBe(false)
    expect(projectByName('tombstoned')).toBeNull()
    expect(projectAt(path)).toBeNull()
    expect(retiredProjectByName('tombstoned')?.id).toBe(retired!.id)
    expect(retiredProjectAt(path)?.name).toBe('tombstoned')
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

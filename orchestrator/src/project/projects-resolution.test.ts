import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
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
  board_claim: 0,
  branch_landing_record: 0,
  presence: 0,
  worker_note_request: 0,
  workflow_cursor: 0,
  main_stack_activity: 0,
  port_pair_source: 0,
  port_pair_target: 0,
  port_ref: 0,
  port_ref_source: 0,
  port_ref_target: 0,
  project_lens_profile: 0,
  release_ledger: 0,
  subject: 0,
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
  test('focused test runners have a fixed executable and argv prefix', () => {
    expect(
      validateProjectSettings({
        focusedTests: { command: 'scripts/test-focused', args: ['--ci'] },
      }),
    ).toEqual([])
    expect(
      validateProjectSettings({
        focusedTests: { command: '', args: ['ok', 1] },
      } as unknown as Parameters<typeof validateProjectSettings>[0]),
    ).toEqual([
      'focusedTests.command must be a non-empty string',
      'focusedTests.args must be an array of strings',
    ])
  })

  test('reader MCP tool maps are strict, named, and duplicate-free', () => {
    expect(
      validateProjectSettings({
        mcp: { reader_tools: { starship: ['get-task', 'search_tasks'], absent: [] } },
      }),
    ).toEqual([])
    expect(
      validateProjectSettings({ mcp: { reader_tools: [] } } as unknown as Parameters<
        typeof validateProjectSettings
      >[0]),
    ).toContain('mcp.reader_tools must be a map from server names to tool-name lists')
    expect(
      validateProjectSettings({ mcp: { reader_tools: { server: [''] } } }).join('\n'),
    ).toContain('plain non-empty tool names')
    expect(
      validateProjectSettings({ mcp: { reader_tools: { server: ['same', 'same'] } } }).join('\n'),
    ).toContain('duplicate tool name "same"')
  })

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
      validateProjectSettings({
        mainStack: { consumers: ['mcp'], requiredServices: ['db', 'cache'] },
      }),
    ).toEqual([])
    expect(
      validateProjectSettings({ mainStack: { consumers: ['unknown'] } } as unknown as Parameters<
        typeof validateProjectSettings
      >[0]),
    ).toEqual(['mainStack.consumers entries must be gate, mcp, or worktree-create'])
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

  test('readonly_docker is refused with its brokered replacement', () => {
    expect(
      validateProjectSettings({
        worktree: { readonly_docker: true } as unknown as Parameters<
          typeof validateProjectSettings
        >[0]['worktree'],
      }),
    ).toContain(
      'worktree.readonly_docker is retired; remove it and read the recorded gate through gate_result',
    )
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
    upsertProject({ recordId: newRecordId(), name: 'alpha', path, stack: 'php-laravel' })
    expect(projectAt(path)?.name).toBe('alpha')
    expect(projectAt(join(path, 'src/deep/file'))?.name).toBe('alpha')
    // The case the old path regex could never handle, and the reason
    // containment beats pattern-matching: a worktree lives inside its project.
    expect(projectAt(join(path, '.claude/worktrees/orch-12'))?.name).toBe('alpha')
    expect(stackAt(join(path, '.claude/worktrees/orch-12'))).toBe('php-laravel')
  })

  test('an unregistered directory is null, not a guess', () => {
    upsertProject({ recordId: newRecordId(), name: 'alpha', path: '/w/alpha' })
    expect(projectAt('/somewhere/else')).toBeNull()
    // Not '/w/alphabet': containment must respect the path separator, or a
    // project named as a prefix of another would swallow it.
    expect(projectAt('/w/alphabet')).toBeNull()
  })

  test('an arbitrarily named non-repository project never resolves from cwd', () => {
    projectDirectory = mkdtempSync(join(tmpdir(), 'orch-tasks-project-'))
    upsertProject({ recordId: newRecordId(), name: 'notes-only', path: projectDirectory })
    expect(projectAt(projectDirectory)).toBeNull()
    expect(projectAt(join(projectDirectory, 'child'))).toBeNull()
    expect(projectRepositoryRefusal(projectByName('notes-only')!)).toBe(
      `project notes-only has no repository: ${projectDirectory} is not a git checkout`,
    )
  })

  test('code search refuses a caller checkout outside the selected project', async () => {
    upsertProject({
      recordId: newRecordId(),
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
    upsertProject({ recordId: newRecordId(), name: 'outer', path: outer })
    upsertProject({ recordId: newRecordId(), name: 'inner', path: inner })
    expect(projectAt(join(inner, 'src'))?.name).toBe('inner')
    expect(projectAt(join(outer, 'other'))?.name).toBe('outer')
  })

  test('settings survive a round trip', () => {
    const path = repository('alpha-settings')
    upsertProject({
      recordId: newRecordId(),
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
      `cleared by: ${PLATFORM_SLUG} project retire kept`,
    ])
  })

  test('a project with a run refuses removal and keeps the run attributed', () => {
    upsertProject({ recordId: newRecordId(), name: 'kept-run', path: '/w/kept-run' })
    const project = projectByName('kept-run')!
    writableDb()
    db()
      .query(
        `INSERT INTO run (record_id,started_at, agent, job, project_record_id, prompt_sha, prompt_bytes, prompt_head, status)
         VALUES ('${newRecordId()}','t', 'a', 'understand', ?, 'sha', 1, 'h', 'ok')`,
      )
      .run(project.recordId)
    expect(() => removeProject('kept-run')).toThrow(
      'project kept-run is referenced by 1 run(s); removing it would blank their project attribution\n' +
        `cleared by: ${PLATFORM_SLUG} project retire kept-run`,
    )
    expect(projectByName('kept-run')?.recordId).toBe(project.recordId)
    expect(
      (
        db()
          .query('SELECT project_record_id FROM run WHERE project_record_id=?')
          .get(project.recordId) as {
          project_record_id: string
        }
      ).project_record_id,
    ).toBe(project.recordId)
  })

  test('a project with nothing referencing it still removes', () => {
    upsertProject({ recordId: newRecordId(), name: 'ephemeral', path: '/w/ephemeral' })
    expect(removeProject('ephemeral')).toBe(true)
    expect(projectByName('ephemeral')).toBeNull()
  })

  test('retire stamps retired_at and hides the row from acting reads', () => {
    const path = repository('tombstoned')
    upsertProject({ recordId: newRecordId(), name: 'tombstoned', path })
    expect(retireProject('tombstoned')).toBe('retired')
    const retired = projects({ retired: true }).find((project) => project.name === 'tombstoned')
    expect(retired?.retiredAt).toBeTruthy()
    expect(projects().some((project) => project.name === 'tombstoned')).toBe(false)
    expect(projectByName('tombstoned')).toBeNull()
    expect(projectAt(path)).toBeNull()
    expect(retiredProjectByName('tombstoned')?.recordId).toBe(retired!.recordId)
    expect(retiredProjectAt(path)?.name).toBe('tombstoned')
    expect(retiredProjectRefusal('tombstoned')).toBe(
      `project tombstoned is retired; cleared by: ${PLATFORM_SLUG} project retire tombstoned --undo`,
    )
    expect(retireProject('tombstoned')).toBe('already-retired')
  })

  test('undo and re-add restore a retired name', () => {
    upsertProject({ recordId: newRecordId(), name: 'restored', path: '/w/restored' })
    expect(retireProject('restored')).toBe('retired')
    expect(unretireProject('restored')).toBe(true)
    expect(projectByName('restored')?.path).toBe('/w/restored')
    expect(projectByName('restored')?.retiredAt).toBeNull()
    expect(retireProject('restored')).toBe('retired')
    upsertProject({
      recordId: newRecordId(),
      name: 'restored',
      path: '/w/restored-next',
      stack: 'node',
    })
    const live = projectByName('restored')
    expect(live?.path).toBe('/w/restored-next')
    expect(live?.stack).toBe('node')
    expect(live?.retiredAt).toBeNull()
  })
})

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { codeSearchCommand } from '../code/code-commands.ts'
import { db, writableDb } from '../database/db.ts'
import { PROJECT_REFERENCES } from './project-reference-counts.ts'
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
  suppliedUnknownKeyProblems,
  unretireProject,
  upsertProject,
  validateProjectSettings,
} from './projects.ts'

const none = Object.fromEntries(
  PROJECT_REFERENCES.map(([key]) => [key, 0]),
) as ProjectReferenceCounts

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
  test('project agent key mappings contain only trimmed non-empty secret names', () => {
    expect(
      validateProjectSettings({
        agentKeys: { BOTTEGA_OPENROUTER: 'OPENROUTER_STARSHIP' },
      }),
    ).toEqual([])
    for (const agentKeys of [
      null,
      [],
      { '': 'PROJECT_KEY' },
      { AGENT_KEY: ' ' },
      { ' AGENT': 'KEY' },
    ]) {
      expect(
        validateProjectSettings({ agentKeys } as unknown as Parameters<
          typeof validateProjectSettings
        >[0]),
      ).toContain(
        'agentKeys must be an object mapping non-empty trimmed agent secret names to non-empty trimmed project secret names',
      )
    }
  })

  test('focused test runners have a fixed executable and argv prefix', () => {
    expect(
      validateProjectSettings(
        {
          focusedTests: { command: 'scripts/test-focused', args: ['--ci'] },
        },
        'strict',
      ),
    ).toEqual([])
    expect(
      validateProjectSettings(
        {
          focusedTests: { command: '', args: ['ok', 1] },
        } as unknown as Parameters<typeof validateProjectSettings>[0],
        'strict',
      ),
    ).toEqual([
      'focusedTests.command must be a non-empty string',
      'focusedTests.args must be an array of strings',
    ])
  })

  test('reader MCP tool maps are strict, named, and duplicate-free', () => {
    expect(
      validateProjectSettings(
        {
          mcp: { reader_tools: { starship: ['get-task', 'search_tasks'], absent: [] } },
        },
        'strict',
      ),
    ).toEqual([])
    expect(
      validateProjectSettings(
        { mcp: { reader_tools: [] } } as unknown as Parameters<typeof validateProjectSettings>[0],
        'strict',
      ),
    ).toContain('mcp.reader_tools must be a map from server names to tool-name lists')
    expect(
      validateProjectSettings({ mcp: { reader_tools: { server: [''] } } }, 'strict').join('\n'),
    ).toContain('plain non-empty tool names')
    expect(
      validateProjectSettings(
        { mcp: { reader_tools: { server: ['same', 'same'] } } },
        'strict',
      ).join('\n'),
    ).toContain('duplicate tool name "same"')
  })

  test('code search opt-in is a boolean-only project setting', () => {
    expect(validateProjectSettings({ search: { code: true } }, 'strict')).toEqual([])
    expect(
      validateProjectSettings(
        { search: { code: 'yes' } } as unknown as Parameters<typeof validateProjectSettings>[0],
        'strict',
      ),
    ).toContain('search.code must be a boolean')
  })

  test('main stack consumers are explicit and validated', () => {
    expect(
      validateProjectSettings({ mainStack: { consumers: ['gate', 'worktree-create'] } }, 'strict'),
    ).toEqual([])
    expect(
      validateProjectSettings(
        {
          mainStack: { consumers: ['mcp'], requiredServices: ['db', 'cache'] },
        },
        'strict',
      ),
    ).toEqual([])
    expect(
      validateProjectSettings(
        { mainStack: { consumers: ['unknown'] } } as unknown as Parameters<
          typeof validateProjectSettings
        >[0],
        'strict',
      ),
    ).toEqual(['mainStack.consumers entries must be gate, mcp, or worktree-create'])
  })

  test('checks accept the optional policy shapes', () => {
    expect(
      validateProjectSettings(
        {
          checks: {
            spelling: true,
            attribution: false,
            commentTaskKeys: true,
            commentHistory: { phrases: ['used to'] },
          },
        },
        'strict',
      ),
    ).toEqual([])
    expect(
      validateProjectSettings(
        { checks: { spelling: 'yes' } as unknown as { spelling: boolean } },
        'strict',
      ),
    ).toContain('checks.spelling must be a boolean')
    expect(
      validateProjectSettings(
        { checks: { unknown: true } as unknown as { spelling: boolean } },
        'strict',
      ),
    ).toContain('checks.unknown is not a recognized check')
    expect(
      validateProjectSettings(
        {
          checks: { commentTaskKeys: 'yes' },
        } as unknown as Parameters<typeof validateProjectSettings>[0],
        'strict',
      ),
    ).toContain('checks.commentTaskKeys must be a boolean')
    expect(
      validateProjectSettings(
        {
          checks: { commentHistory: { phrases: [''] } },
        },
        'strict',
      ),
    ).toContain('checks.commentHistory.phrases must be an array of non-empty strings')
    expect(
      validateProjectSettings(
        { checks: null } as unknown as Parameters<typeof validateProjectSettings>[0],
        'strict',
      ),
    ).toContain('checks must be an object')
  })

  test('readonly_docker is refused with its brokered replacement', () => {
    expect(
      validateProjectSettings(
        {
          worktree: { readonly_docker: true } as unknown as Parameters<
            typeof validateProjectSettings
          >[0]['worktree'],
        },
        'strict',
      ),
    ).toContain(
      'worktree.readonly_docker is retired; remove it and read the recorded gate through gate_result',
    )
  })

  test('managedContext must be boolean when present', () => {
    expect(
      validateProjectSettings(
        {
          managedContext: 'yes',
        } as unknown as Parameters<typeof validateProjectSettings>[0],
        'strict',
      ),
    ).toContain('managedContext must be a boolean')
  })

  test('validates only key prefixes being written against register rows', () => {
    const register = [{ name: 'existing', settings: { keyPrefixes: ['DEV'] } }]
    expect(
      validateProjectSettings({ keyPrefixes: ['TASK'] }, 'strict', undefined, {
        validateKeyPrefixes: true,
        currentProjectName: 'new',
        register,
      }),
    ).toContain('key prefix TASK is reserved')
    expect(
      validateProjectSettings({ keyPrefixes: ['TASK'] }, 'strict', undefined, {
        validateKeyPrefixes: true,
        currentProjectName: 'tasks',
        register,
      }),
    ).toEqual([])
    expect(
      validateProjectSettings({ keyPrefixes: ['DEV'] }, 'strict', undefined, {
        validateKeyPrefixes: true,
        currentProjectName: 'new',
        register,
      }),
    ).toContain('key prefix DEV is already used by another project')
    expect(validateProjectSettings({ keyPrefixes: ['legacy-invalid'] }, 'strict')).toEqual([])
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
      validateProjectSettings(
        { worktree: { recipePath: 'worktree.jsonc' } },
        'strict',
        projectDirectory,
      ),
    ).toEqual([])
    writeFileSync(
      join(projectDirectory, 'worktree.jsonc'),
      '{"worktree":{"create":[],"unknown":true}}',
    )
    expect(
      validateProjectSettings(
        { worktree: { recipePath: 'worktree.jsonc' } },
        'strict',
        projectDirectory,
      ).join('\n'),
    ).toContain('unknown-key rule')
  })

  test('registration accepts a shadowed tracked recipe beside an inline recipe', () => {
    expect(
      validateProjectSettings(
        {
          worktree: { recipe: {}, recipePath: '.orch/worktree.jsonc' },
        },
        'strict',
      ),
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
        `INSERT INTO run (record_id,number,started_at, agent, job, project_record_id, prompt_sha, prompt_bytes, prompt_head, status)
         VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),'t', 'a', 'understand', ?, 'sha', 1, 'h', 'ok')`,
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

  test('a project with pull request CI evidence refuses removal', () => {
    upsertProject({ recordId: newRecordId(), name: 'kept-ci', path: '/w/kept-ci' })
    const project = projectByName('kept-ci')!
    writableDb()
    db()
      .query(
        `INSERT INTO pull_request_ci
         (record_id,project,project_record_id,pr_number,record_kind,complete,recorded_at)
         VALUES (?, ?, ?, 42, 'collection', 1, 't')`,
      )
      .run(newRecordId(), project.name, project.recordId)
    expect(() => removeProject(project.name)).toThrow(
      'project kept-ci is referenced by 1 pull_request_ci(s)',
    )
  })

  test('a project with nothing referencing it still removes', () => {
    upsertProject({ recordId: newRecordId(), name: 'ephemeral', path: '/w/ephemeral' })
    expect(removeProject('ephemeral')).toBe(true)
    expect(projectByName('ephemeral')).toBeNull()
  })

  test('local-only lens selections and port rows still refuse removal', () => {
    upsertProject({ recordId: newRecordId(), name: 'local-catalogue', path: '/w/local-catalogue' })
    const project = projectByName('local-catalogue')!
    writableDb()
    db()
      .query(
        `INSERT INTO project_lens_profile
         (record_id,project_record_id,lens_record_id,axis,profile_name,selection_version,space_id)
         VALUES (?,?,NULL,'framework','default',1,NULL)`,
      )
      .run(newRecordId(), project.recordId)
    db()
      .query(
        `INSERT INTO port_ref
         (record_id,task_key,target_project_record_id,note,created_at,version,space_id)
         VALUES (?,'DEV-1404',?,'local','2026-10-19T00:00:00.000Z',1,NULL)`,
      )
      .run(newRecordId(), project.recordId)

    expect(() => removeProject('local-catalogue')).toThrow(
      '1 port_ref(s), 1 project_lens_profile(s)',
    )
    expect(projectByName('local-catalogue')).not.toBeNull()
  })

  test('hosted catalogue rows neither block removal nor disappear with the local project', () => {
    upsertProject({
      recordId: newRecordId(),
      name: 'hosted-catalogue',
      path: '/w/hosted-catalogue',
    })
    const project = projectByName('hosted-catalogue')!
    const space = newRecordId()
    const pair = newRecordId()
    const ref = newRecordId()
    writableDb()
    db()
      .query(
        `INSERT INTO project_lens_profile
         (record_id,project_record_id,lens_record_id,axis,profile_name,selection_version,space_id)
         VALUES (?,?,NULL,'framework','default',1,?)`,
      )
      .run(newRecordId(), project.recordId, space)
    db()
      .query(
        `INSERT INTO port_pair
         (record_id,source_project_record_id,target_project_record_id,created_at,space_id)
         VALUES (?,?,?,'2026-10-19T00:00:00.000Z',?)`,
      )
      .run(pair, project.recordId, newRecordId(), space)
    db()
      .query(
        `INSERT INTO port_ref
         (record_id,task_key,target_project_record_id,note,created_at,version,space_id)
         VALUES (?,'DEV-1404',?,'hosted','2026-10-19T00:00:00.000Z',1,?)`,
      )
      .run(ref, project.recordId, space)
    db()
      .query(
        `INSERT INTO port_ref_source
         (record_id,ref_record_id,source_project_record_id,commits,paths,note,position,space_id)
         VALUES (?,?,?,'[]','[]','hosted',1,?)`,
      )
      .run(newRecordId(), ref, project.recordId, space)

    expect(removeProject('hosted-catalogue')).toBe(true)
    expect(projectByName('hosted-catalogue')).toBeNull()
    for (const table of ['project_lens_profile', 'port_pair', 'port_ref', 'port_ref_source'])
      expect(db().query(`SELECT COUNT(*) AS n FROM ${table} WHERE space_id=?`).get(space)).toEqual({
        n: 1,
      })
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

/**
 * The register is written by one binary and read by another, so a settings name
 * this binary does not know is a read's ordinary case and a write's typo.
 */
describe('an unknown settings name is judged by which side is reading', () => {
  const asSettings = (settings: Record<string, unknown>) =>
    settings as unknown as Parameters<typeof validateProjectSettings>[0]
  const unknownCheck = asSettings({ checks: { spelling: true, brandNewCheck: true } })
  const unknownHistoryField = asSettings({
    checks: { commentHistory: { phrases: ['used to'], tone: 'warm' } },
  })
  const unknownSearchField = asSettings({ search: { code: true, docs: true } })
  const unknownMainStackKey = asSettings({ mainStack: { consumers: ['gate'], health: 'http' } })

  test('a read drops a name this binary does not know', () => {
    expect(validateProjectSettings(unknownCheck, 'strip')).toEqual([])
    expect(validateProjectSettings(unknownHistoryField, 'strip')).toEqual([])
    expect(validateProjectSettings(unknownSearchField, 'strip')).toEqual([])
    expect(validateProjectSettings(unknownMainStackKey, 'strip')).toEqual([])
  })

  test('a write refuses the same name with the text it always printed', () => {
    expect(validateProjectSettings(unknownCheck, 'strict')).toEqual([
      'checks.brandNewCheck is not a recognized check',
    ])
    expect(validateProjectSettings(unknownHistoryField, 'strict')).toEqual([
      'checks.commentHistory.tone is not recognized',
    ])
    expect(validateProjectSettings(unknownSearchField, 'strict')).toEqual([
      'search.docs is not recognized',
    ])
    expect(validateProjectSettings(unknownMainStackKey, 'strict')).toEqual([
      'mainStack contains unknown settings',
    ])
  })

  test('a check on a name or a value this binary knows is the same in either mode', () => {
    expect(validateProjectSettings(asSettings({ checks: { spelling: 'yes' } }), 'strip')).toEqual([
      'checks.spelling must be a boolean',
    ])
    expect(validateProjectSettings(asSettings({ search: { code: 'yes' } }), 'strip')).toEqual([
      'search.code must be a boolean',
    ])
    expect(
      validateProjectSettings(asSettings({ mainStack: { consumers: ['unknown'] } }), 'strip'),
    ).toEqual(['mainStack.consumers entries must be gate, mcp, or worktree-create'])
  })

  test('a supplied patch is refused only for the names this binary does not know', () => {
    expect(suppliedUnknownKeyProblems({ checks: { brandNewCheck: true } })).toEqual([
      'checks.brandNewCheck is not a recognized check',
    ])
    expect(suppliedUnknownKeyProblems({ search: { docs: true } })).toEqual([
      'search.docs is not recognized',
    ])
    expect(suppliedUnknownKeyProblems({ mainStack: { health: 'http' } })).toEqual([
      'mainStack contains unknown settings',
    ])
    expect(
      suppliedUnknownKeyProblems({ mechanicalChecks: { brandNewCheck: { tool: 'probe' } } }),
    ).toEqual([expect.stringContaining('unknown category')])
    expect(
      suppliedUnknownKeyProblems({
        mechanicalChecks: { spelling: { tool: 'typos', newField: 1 } },
      }),
    ).toEqual([expect.stringContaining('entry has unknown fields: newField')])
    // A partial patch is judged on the keys it names, never on the ones it left
    // out for the stored row to complete.
    expect(suppliedUnknownKeyProblems({ checks: { spelling: true } })).toEqual([])
    expect(suppliedUnknownKeyProblems({ mainStack: { consumers: ['mcp'] } })).toEqual([])
  })
})

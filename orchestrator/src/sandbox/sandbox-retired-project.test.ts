import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import { db, writableDb } from '../database/db.ts'
import { type Project, projectsForSandboxDeny } from '../project/projects.ts'
import { readonlyLensProfile } from './sandbox.ts'

test('the sandbox deny universe includes a retired checkout, its parent, and its worktree root', () => {
  const recordId = newRecordId()
  const state = mkdtempSync(join(tmpdir(), 'retired-sandbox-state-'))
  writableDb()
  db()
    .query(
      `INSERT INTO project (record_id,name,path,stack,settings,retired_at)
       VALUES (?,'retired-sandbox-fixture','/retired-fixture/sibling','node','{}',?)`,
    )
    .run(recordId, new Date().toISOString())
  try {
    const own: Project = {
      recordId: newRecordId(),
      name: 'own-sandbox-fixture',
      path: '/projects/fixture',
      stack: 'node',
      canon: false,
      retiredAt: null,
      settings: {},
    }
    const profile = readonlyLensProfile({
      worktree: '/projects/fixture/.claude/worktrees/run',
      runtimeDir: join(state, 'orchestrator/runs/sandbox-run'),
      project: own,
      registeredProjects: [own, ...projectsForSandboxDeny(db())],
      agent: 'grok',
      path: '/usr/bin',
      nodeModuleLinks: [],
      environment: { HOME: '/Users/operator', [STATE_HOME_ENV]: state },
      socketDenyPaths: [],
    })

    expect(profile.filesystem.denyRead).toContain('/retired-fixture/sibling')
    expect(profile.filesystem.denyRead).toContain('/retired-fixture')
    expect(profile.filesystem.denyRead).toContain('/retired-fixture/sibling/.claude/worktrees')
  } finally {
    db().query('DELETE FROM project WHERE record_id=?').run(recordId)
    rmSync(state, { recursive: true, force: true })
  }
})

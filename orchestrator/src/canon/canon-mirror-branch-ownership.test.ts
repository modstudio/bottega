import { expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { db } from '../database/db.ts'
import { mirrorRepositoryCanon } from './canon-mirror.ts'
import {
  mirrorFixturePort,
  mirrorRepository,
  registerManagedMirror,
} from './canon-mirror-ownership.fixture.ts'

test('a reused local mirror branch at a foreign tip is refused', async () => {
  const root = mirrorRepository('cm-foreign-branch')
  try {
    await registerManagedMirror(root, 'cm-foreign-branch')
    spawnFixtureGitSync(['branch', 'DEV-1002-canon-mirror', 'HEAD'], { cwd: root })
    const project = db()
      .query<{ id: number }, []>("SELECT id FROM project WHERE name='cm-foreign-branch'")
      .get()!
    db()
      .query(`INSERT INTO run
        (started_at,agent,job,repo,project_id,prompt_sha,prompt_bytes,prompt_head,status,branch,base_commit,head_commit)
        VALUES ('2026-09-28','(architect)','canon-mirror','cm-foreign-branch',?,'fixture',7,'fixture','failed','DEV-1002-canon-mirror','recorded-base','0123456789abcdef0123456789abcdef01234567')`)
      .run(project.id)
    const result = await mirrorRepositoryCanon({
      project: 'cm-foreign-branch',
      dryRun: false,
      port: mirrorFixturePort(root, { localBranch: () => true }),
      noteFailure: async () => {},
    })
    expect(result[0]?.text).toContain('refusing unowned local branch')
    expect(
      spawnFixtureGitSync(['show-ref', '--verify', '--quiet', 'refs/heads/DEV-1002-canon-mirror'], {
        cwd: root,
      }).exitCode,
    ).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

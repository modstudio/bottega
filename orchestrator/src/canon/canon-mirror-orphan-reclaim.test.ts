import { expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { db } from '../database/db.ts'
import { mirrorRepositoryCanon } from './canon-mirror.ts'
import {
  mirrorFixturePort,
  mirrorRepository,
  registerManagedMirror,
} from './canon-mirror-ownership.fixture.ts'

test('a tip recorded before a failed PR step is reclaimed on the next run', async () => {
  const root = mirrorRepository('cm-reclaim-push')
  const owned = '0123456789abcdef0123456789abcdef01234567'
  let expectedLease: string | null = null
  try {
    await registerManagedMirror(root, 'cm-reclaim-push')
    const project = db()
      .query<{ id: number }, []>("SELECT id FROM project WHERE name='cm-reclaim-push'")
      .get()!
    db()
      .query(`INSERT INTO run
      (started_at,agent,job,repo,project_id,prompt_sha,prompt_bytes,prompt_head,status,branch,base_commit,head_commit)
      VALUES ('2026-09-28','(architect)','canon-mirror','cm-reclaim-push',?,'fixture',7,'fixture','failed','DEV-1002-canon-mirror','base',?)`)
      .run(project.id, owned)
    const result = await mirrorRepositoryCanon({
      project: 'cm-reclaim-push',
      dryRun: false,
      port: mirrorFixturePort(root, {
        remoteBranchTip: () => owned,
        push: (_path, _branch, expected) => {
          expectedLease = expected
        },
        releaseBranch: () => {},
      }),
      noteFailure: async () => {},
    })
    expect(String(expectedLease)).toBe(owned)
    expect(result[0]?.text).not.toContain('unowned remote branch')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

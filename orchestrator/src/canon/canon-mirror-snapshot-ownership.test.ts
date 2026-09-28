import { expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { db } from '../database/db.ts'
import { mirrorRepositoryCanon } from './canon-mirror.ts'
import {
  mirrorFixturePort,
  mirrorRepository,
  registerManagedMirror,
} from './canon-mirror-ownership.fixture.ts'

test('a foreign snapshot at a matching remote tip does not establish ownership', async () => {
  const root = mirrorRepository('cm-foreign-snapshot')
  const tip = '0123456789abcdef0123456789abcdef01234567'
  try {
    await registerManagedMirror(root, 'cm-foreign-snapshot')
    db()
      .query(`INSERT INTO landing_triage_snapshot
      (record_id,project,branch,tip,tree,pr_number,review_ids,patch_id,tier,lens_rounds,finding_count,at)
      VALUES ('foreign-snapshot','cm-foreign-snapshot','DEV-1002-canon-mirror',?,'tree',9,'[]','patch',0,0,0,'2026-09-28')`)
      .run(tip)
    const result = await mirrorRepositoryCanon({
      project: 'cm-foreign-snapshot',
      dryRun: false,
      port: mirrorFixturePort(root, { remoteBranchTip: () => tip }),
      noteFailure: async () => {},
    })
    expect(result[0]?.text).toContain(tip)
    expect(result[0]?.text).not.toContain('output withheld')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

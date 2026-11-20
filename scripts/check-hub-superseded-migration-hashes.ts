#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import supersededMigrationHashes from '../hub/migrations/meta/_superseded_hashes.json' with {
  type: 'json',
}
import { startBoundedSync } from '../shared/bounded-process.ts'
import { splitMigrationSource } from '../shared/migration-source.ts'
import { refusal, renderRefusal } from '../shared/refusal.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

for (const entry of supersededMigrationHashes.entries) {
  const path = `hub/migrations/${entry.tag}.sql`
  const shown = startBoundedSync(['git', 'show', `${entry.preEditCommit}:${path}`], {
    budget: 'git-plumbing',
    cwd: root,
  })
  if (shown.exitCode !== 0) {
    throw new Error(
      renderRefusal(
        refusal(
          `cannot verify superseded hub migration hash: ${entry.preEditCommit}:${path} is unreachable\n` +
            `git show: ${shown.stderr.trim()}`,
          {
            kind: 'edit',
            text: `fetch the repository's full history, then rerun bun run check`,
          },
        ),
      ),
    )
  }
  const actual = createHash('sha256').update(splitMigrationSource(shown.stdout).ddl).digest('hex')
  if (actual !== entry.predecessorHash) {
    throw new Error(
      `superseded hub migration hash does not match ${entry.preEditCommit}:${path}\n` +
        `declared: ${entry.predecessorHash}\nactual: ${actual}`,
    )
  }
}

console.log('superseded hub migration hashes match their declared pre-edit commits')

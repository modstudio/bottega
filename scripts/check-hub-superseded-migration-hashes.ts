#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import journal from '../hub/migrations/meta/_journal.json' with { type: 'json' }
import supersededMigrationHashes from '../hub/migrations/meta/_superseded_hashes.json' with {
  type: 'json',
}
import { startBoundedSync } from '../shared/bounded-process.ts'
import { splitMigrationSource } from '../shared/migration-source.ts'
import { refusal, renderRefusal } from '../shared/refusal.ts'
import { normalizeSupersededDdl } from './superseded-migration-ddl.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

function journalRefusal(
  entry: (typeof supersededMigrationHashes.entries)[number],
  problem: string,
) {
  return new Error(
    renderRefusal(
      refusal(`cannot verify superseded hub migration ${entry.tag}: ${problem}`, {
        kind: 'edit',
        text: `correct the ${entry.tag} entry in hub/migrations/meta/_superseded_hashes.json so its tag and when match exactly one hub journal entry, then rerun bun run check`,
      }),
    ),
  )
}

function differingFragment(left: string, right: string): { predecessor: string; current: string } {
  let offset = 0
  while (offset < left.length && offset < right.length && left[offset] === right[offset])
    offset += 1
  const start = Math.max(0, offset - 40)
  return {
    predecessor: left.slice(start, offset + 80),
    current: right.slice(start, offset + 80),
  }
}

for (const entry of supersededMigrationHashes.entries) {
  const matchingJournalEntries = journal.entries.filter((candidate) => candidate.tag === entry.tag)
  if (matchingJournalEntries.length !== 1) {
    throw journalRefusal(
      entry,
      `expected exactly one matching journal entry, found ${matchingJournalEntries.length}`,
    )
  }
  const journalEntry = matchingJournalEntries[0]!
  if (journalEntry.when !== entry.when) {
    throw journalRefusal(
      entry,
      `declared when ${entry.when} differs from journal when ${journalEntry.when}`,
    )
  }

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

  const predecessorDdl = splitMigrationSource(shown.stdout).ddl
  const currentDdl = splitMigrationSource(readFileSync(`${root}${path}`, 'utf8')).ddl
  const normalizedPredecessor = normalizeSupersededDdl(predecessorDdl)
  const normalizedCurrent = normalizeSupersededDdl(currentDdl)
  if (normalizedPredecessor !== normalizedCurrent) {
    const difference = differingFragment(normalizedPredecessor, normalizedCurrent)
    throw new Error(
      `superseded hub migration ${entry.tag} is not schema-neutral\n` +
        `predecessor: ${difference.predecessor}\ncurrent: ${difference.current}`,
    )
  }
}

console.log(
  'superseded hub migration hashes resolve to the journal and are schema-neutral against their declared pre-edit commits',
)

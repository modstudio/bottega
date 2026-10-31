/**
 * Generated files, which are not work.
 *
 * Measured over fourteen days across the four product repos, **82% of all line
 * churn was generated** — drizzle rewrites a 25-50k line schema snapshot on
 * every migration, so adding one column reads as a 23,000-line day. Left in,
 * the lines lens measures the ORM's verbosity rather than anything anyone did.
 */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { categorizeFile, type FileKind } from '../../../shared/file-kind.ts'
import { storedMachineId } from '../../../shared/machine-config.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { keyPattern, refreshKeyPrefixes, writeCommitKey } from '../attribute.ts'
import { nowIso, type Project, writeTransaction } from '../db.ts'
import { projects } from '../projects.ts'
import { upsertGitTasks } from './git-task-cache.ts'

export type { FileKind } from '../../../shared/file-kind.ts'

export const GIT_INGEST_BATCH_SIZE = 50

/**
 * What kind of file a change touched.
 *
 * Categorized rather than filtered, because the mix is itself information: a
 * day of docs and config is not a day of product code, and knowing that is
 * worth more than a single number pretending they are the same.
 *
 * Tests are their own category rather than dropped. They distort a line count
 * badly — one 16,884-line integration test was the largest single file in
 * one project's window — but they are real work, and scoring them at zero would make
 * writing them look free.
 */
export function categorize(file: string): FileKind {
  return categorizeFile(file)
}

type DayActivity = {
  tasks: Set<string>
  commits: number
  files: Set<string>
  lines: Record<FileKind, number>
}

/** Commits seen per task key, for tasks no tracker could tell us about. */
type GitTask = {
  key: string
  project: Project
  first: string
  last: string
  commits: number
}

function blank(): DayActivity {
  return {
    tasks: new Set(),
    commits: 0,
    files: new Set(),
    lines: { generated: 0, test: 0, docs: 0, config: 0, product: 0 },
  }
}

/**
 * What each repo produced, per day and per task key.
 *
 * No single denominator is trustworthy, so the ratio is reported under several
 * and the interesting signal is whether they agree. Each is wrong in its own
 * direction: tasks miss work carrying no ticket, lines reward verbosity,
 * commits follow habit rather than effort, and files touched says nothing about
 * depth.
 */
function scanGit(since: string) {
  refreshKeyPrefixes()
  const days = new Map<string, DayActivity>()
  const tasks = new Map<string, GitTask>()
  const commits: { sha: string; repo: string; key: string; at: string }[] = []
  const get = (d: string) => {
    if (!days.has(d)) days.set(d, blank())
    return days.get(d)!
  }

  for (const project of projects().filter((project) => project.repository)) {
    const repo = project.name
    const proc = Bun.spawnSync(
      [
        'git',
        '-C',
        project.path,
        'log',
        '--all',
        `--since=${since}`,
        '--numstat',
        '--pretty=format:%x00%cs%x09%cI%x09%H%x09%s',
      ],
      { stdout: 'pipe', stderr: 'ignore' },
    )
    let day: string | null = null
    for (const line of new TextDecoder().decode(proc.stdout).split('\n')) {
      if (line.startsWith('\u0000')) {
        const [d, at, sha, subject] = line.slice(1).split('\t')
        if (!d) {
          day = null
          continue
        }
        day = d
        const row = get(day)
        row.commits++
        for (const k of (subject ?? '').match(keyPattern()) ?? []) {
          const key = k.toUpperCase()
          row.tasks.add(`${repo}:${key}`)
          const t = tasks.get(key)
          if (t) {
            t.commits++
            if (d < t.first) t.first = d
            if (d > t.last) t.last = d
          } else {
            tasks.set(key, {
              key,
              project: repo,
              first: d,
              last: d,
              commits: 1,
            })
          }
          if (sha && at) commits.push({ sha, repo, key, at })
        }
        continue
      }
      if (!day) continue
      const [add, del, file] = line.split('\t')
      // "-" is git's marker for a binary file: no line count exists.
      if (add === undefined || add === '-' || !file) continue
      const row = get(day)
      const kind = categorize(file)
      row.lines[kind] += Number(add) + Number(del ?? 0)
      if (kind === 'product') row.files.add(`${repo}:${file}`)
    }
  }
  return { days, tasks, commits }
}

/**
 * Write the day grain, and seed tasks that only git knows about.
 *
 * Git-derived task rows carry no title and no status, and say so via
 * `source='git'`. They exist because a tracker that is unreachable — or a
 * project that has no local credentials at all — should not make its work
 * vanish from the view entirely.
 */
export async function ingestGit(
  since: string,
  options: { transaction?: GitTransaction; batchSize?: number } = {},
): Promise<{ days: number; tasks: number }> {
  const machine = storedMachineId()
  if (!machine)
    throw new Error(
      `refusing to write daily totals without a machine identity; run ${PLATFORM_SLUG} machine migrate`,
    )
  const { days, tasks, commits } = scanGit(since)
  const at = nowIso()
  writeGitIngestBatches(
    { days, tasks, commits },
    machine,
    at,
    options.transaction,
    options.batchSize,
  )
  return { days: days.size, tasks: tasks.size }
}

type GitScan = ReturnType<typeof scanGit>
type GitTransaction = <T>(fn: (conn: import('bun:sqlite').Database) => T) => T

export function writeGitIngestBatches(
  scan: GitScan,
  machine: string,
  at: string,
  transaction: GitTransaction = writeTransaction,
  batchSize = GIT_INGEST_BATCH_SIZE,
): void {
  const operations = [
    ...scan.commits.map((commit) => ({ kind: 'commit' as const, commit })),
    ...[...scan.days].map(([day, activity]) => ({ kind: 'day' as const, day, activity })),
  ]
  const batches = Array.from(
    { length: Math.max(1, Math.ceil(operations.length / batchSize)) },
    (_, index) => operations.slice(index * batchSize, (index + 1) * batchSize),
  )
  for (const [index, batch] of batches.entries())
    transaction((conn) => {
      const dayStmt = conn.query(
        `INSERT INTO day (record_id, machine_id, day, tasks, commits, files,
                      lines_product, lines_test, lines_docs, lines_config, lines_generated,
                      collected_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(day) DO UPDATE SET
       -- Git columns always overwrite: history is still there, so a later pass
       -- measures them at least as well as the first did. The token columns are
       -- the ones that need a guard, and they are written elsewhere.
       tasks=excluded.tasks, commits=excluded.commits, files=excluded.files,
       lines_product=excluded.lines_product, lines_test=excluded.lines_test,
       lines_docs=excluded.lines_docs, lines_config=excluded.lines_config,
       lines_generated=excluded.lines_generated, collected_at=excluded.collected_at`,
      )

      // Seed Git-only tasks before resolving the commit's task UUID. Never downgrade a
      // tracker's row to a git-derived one. The cache adapter also queues only inserts
      // and meaningful changes in this transaction.
      if (index === 0) upsertGitTasks(conn, scan.tasks.values(), at)
      for (const operation of batch) {
        if (operation.kind === 'commit') {
          writeCommitKey(conn, operation.commit)
          continue
        }
        const { day, activity: a } = operation
        dayStmt.run(
          newRecordId(),
          machine,
          day,
          a.tasks.size,
          a.commits,
          a.files.size,
          a.lines.product,
          a.lines.test,
          a.lines.docs,
          a.lines.config,
          a.lines.generated,
          at,
        )
      }
      if (index === batches.length - 1)
        conn
          .query(`INSERT INTO setting (key, value) VALUES ('collect.git.at', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
          .run(JSON.stringify(at))
    })
}

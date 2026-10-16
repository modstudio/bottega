import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { latestArchitectRead } from '../review/review-read.ts'
import {
  chooseSinceReadBound,
  readRunDiffSource,
  runDiffCommand,
  unchangedSinceReadMessage,
  validateRunDiffBounds,
} from './run-diff.ts'

test('since-read and since-base refuse because they choose different lower bounds', () => {
  expect(() =>
    validateRunDiffBounds({ has: (name) => name === 'since-read' || name === 'since-base' }),
  ).toThrow('choose different lower bounds')
})

test('since-read refuses a missing read with both remedies', () => {
  const decision = chooseSinceReadBound({
    runId: 1257,
    branch: 'DEV-1257-work',
    read: null,
    comparisonTip: 'current-tip',
    readIsAncestor: false,
  })

  expect(decision).toEqual({
    kind: 'refusal',
    message:
      'no architect read is recorded for branch DEV-1257-work\n' +
      `cleared by: record one with ${PLATFORM_SLUG} review read --note <note>, or run ${PLATFORM_SLUG} run diff 1257 for the whole change`,
  })
})

test('since-read refuses a rewritten branch and names both commits', () => {
  const decision = chooseSinceReadBound({
    runId: 1257,
    branch: 'DEV-1257-work',
    read: {
      tip: 'read-tip',
      recordedAt: '2026-10-12T12:00:00.000Z',
      note: 'read before fixes',
    },
    comparisonTip: 'rewritten-tip',
    readIsAncestor: false,
  })

  expect(decision.kind).toBe('refusal')
  if (decision.kind === 'refusal') {
    expect(decision.message).toContain('read-tip')
    expect(decision.message).toContain('rewritten-tip')
    expect(decision.message).toContain(`cleared by: run ${PLATFORM_SLUG} run diff 1257`)
  }
})

test('since-read selects the recorded tip as the lower bound', () => {
  const read = {
    tip: 'read-tip',
    recordedAt: '2026-10-12T12:00:00.000Z',
    note: 'read before fixes',
  }
  expect(
    chooseSinceReadBound({
      runId: 1257,
      branch: 'DEV-1257-work',
      read,
      comparisonTip: 'later-tip',
      readIsAncestor: true,
    }),
  ).toEqual({ kind: 'bound', read })
})

test('an unchanged clean comparison names the architect read', () => {
  const read = {
    tip: 'read-tip',
    recordedAt: '2026-10-12T12:00:00.000Z',
    note: 'read before fixes',
  }
  expect(unchangedSinceReadMessage(read, '')).toBe(
    'no file changed since architect read read-tip recorded 2026-10-12T12:00:00.000Z',
  )
  expect(unchangedSinceReadMessage({ ...read, tip: 'earlier-tip' }, '')).toBe(
    'no file changed since architect read earlier-tip recorded 2026-10-12T12:00:00.000Z',
  )
  expect(unchangedSinceReadMessage(read, 'patch')).toBeNull()
})

test('live since-read sends the recorded tip through the service to the observed diff', async () => {
  const database = db()
  database
    .query(
      'INSERT INTO project (record_id,name,path,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?)',
    )
    .run('diff-service-fixture', '/repo', '{}')
  const run = database
    .query<{ id: number }, []>(
      `INSERT INTO run
        (record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,repo,cwd,worktree,
         branch,base_commit)
       VALUES
        ('${newRecordId()}','2026-10-12','codex','implementation','sha',1,'head','running',
         'diff-service-fixture','/repo/tree','/repo/tree','DEV-1257-work','base-tip')
       RETURNING id`,
    )
    .get()!
  database
    .query(
      `INSERT INTO review_read
        (record_id,project,branch,tip,patch_id,path_set,tier,note,recorded_at)
       VALUES
        ('read-service','diff-service-fixture','DEV-1257-work','read-tip','patch','[]',1,
         'read before fixes','2026-10-12T12:00:00.000Z')`,
    )
    .run()
  const output: string[] = []

  await runDiffCommand(
    run.id,
    { has: (name) => name === 'since-read' || name === 'quiet' },
    {
      error: () => {},
      write: (value) => output.push(value),
      usage: () => {
        throw new Error('unexpected usage')
      },
      cleanupRepoRoot: () => '/repo',
      observedChangesIn: (_spec, _sinceBase, lowerBound) =>
        lowerBound === 'read-tip'
          ? {
              diff: 'diff --git a/after-read.txt b/after-read.txt\n+after the read\n',
              files: ['after-read.txt'],
              insertions: 1,
              deletions: 0,
              since: lowerBound,
              trunk: 'main',
              trunkConfigured: false,
            }
          : {
              diff: 'diff --git a/before-read.txt b/before-read.txt\n+before the read\n',
              files: ['before-read.txt'],
              insertions: 1,
              deletions: 0,
              since: 'base-tip',
              trunk: 'main',
              trunkConfigured: false,
            },
      latestArchitectRead: (project, branch) => latestArchitectRead(database, project, branch),
      commitAt: () => 'later-tip',
      isAncestor: (_cwd, ancestor, descendant) =>
        ancestor === 'read-tip' && descendant === 'later-tip',
      commitsBetween: (_cwd, since, tip) =>
        since === 'read-tip' && tip === 'HEAD' ? 'later-tip fix after read\n' : '',
      exists: () => true,
      withWorktreeLease: (_repoRoot, _worktreePath, action) => action(),
      writesRepo: () => true,
    },
  )

  const rendered = output.join('')
  expect(rendered).toContain('since: read-tip (architect read)')
  expect(rendered).toContain('later-tip fix after read')
  expect(rendered).toContain('after the read')
  expect(rendered).not.toContain('before the read')
})

test('live diff checks existence and reads the tree while its lease is held', () => {
  // Production break watched fail: replace readLive(...) with readEvidence().
  const events: string[] = []
  const result = readRunDiffSource({
    repoRoot: '/repo',
    worktree: '/repo/tree',
    exists: () => {
      events.push('exists')
      return true
    },
    withWorktreeLease: (_repoRoot, _worktreePath, action) => {
      events.push('lease:start')
      const value = action()
      events.push('lease:end')
      return value
    },
    readLive: () => {
      events.push('live')
      return 'live changes'
    },
    readEvidence: () => {
      events.push('evidence')
      return 'branch changes'
    },
  })

  expect(result).toBe('live changes')
  expect(events).toEqual(['lease:start', 'exists', 'live', 'lease:end'])
})

test('an absent tree selects the evidence branch read after releasing its lease', () => {
  // Production break watched fail: replace exists(...) with true.
  const events: string[] = []
  const result = readRunDiffSource({
    repoRoot: '/repo',
    worktree: '/repo/tree',
    exists: () => {
      events.push('exists')
      return false
    },
    withWorktreeLease: (_repoRoot, _worktreePath, action) => {
      events.push('lease:start')
      const value = action()
      events.push('lease:end')
      return value
    },
    readLive: () => {
      events.push('live')
      return 'live changes'
    },
    readEvidence: () => {
      events.push('evidence')
      return 'branch changes'
    },
  })

  expect(result).toBe('branch changes')
  expect(events).toEqual(['lease:start', 'exists', 'lease:end', 'evidence'])
})

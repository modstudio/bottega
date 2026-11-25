import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  CHAIN_TREE_COMMIT_LIST_CAP,
  decideHeldBranchRemedy,
  heldBranchRemedy,
  renderChainTreeAttachRefusal,
  renderHeldBranchRemedy,
} from './held-branch-remedy.ts'
import { acquireRunLease, removeFreeRunLease } from './run-lease.ts'

const path = '/worktrees/DEV-2405-held'

test('a live holder names the run and never offers detach', () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
  db().query('UPDATE run SET worktree=? WHERE record_id=?').run(path, runId)

  const message = heldBranchRemedy(path)

  expect(message).toContain(`run ${runId} is live`)
  expect(message).toContain(`${PLATFORM_SLUG} run wait ${runId}`)
  expect(message).toContain(`${PLATFORM_SLUG} run stop ${runId}`)
  expect(message).not.toContain('--detach')
})

test('a running ghost with a free lease does not block detach', () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  db().query('UPDATE run SET worktree=? WHERE record_id=?').run(path, runId)
  acquireRunLease(runId).release()

  try {
    const message = heldBranchRemedy(path)

    expect(message).toContain(`git -C ${path} switch --detach`)
    expect(message).not.toContain(`run ${runId} is live`)
  } finally {
    removeFreeRunLease(runId)
  }
})

test('an idle clean holder names switch --detach with its absolute path', () => {
  const message = renderHeldBranchRemedy(path, decideHeldBranchRemedy({ path, liveRunId: null }))

  expect(message).toContain(`git -C ${path} switch --detach`)
})

test('an idle dirty holder names switch --detach and says changes are kept', () => {
  const message = renderHeldBranchRemedy(path, decideHeldBranchRemedy({ path, liveRunId: null }))

  expect(message).toContain(`git -C ${path} switch --detach`)
  expect(message).toContain('keeps uncommitted changes')
})

test('choose-work names both tips, caps commit lists, and prescribes no destructive command', () => {
  const headOnly = Array.from({ length: CHAIN_TREE_COMMIT_LIST_CAP + 2 }, (_, index) =>
    `head-${index}`,
  )
  const tipOnly = Array.from({ length: CHAIN_TREE_COMMIT_LIST_CAP + 1 }, (_, index) =>
    `tip-${index}`,
  )
  const message = renderChainTreeAttachRefusal({
    path,
    branch: 'DEV-2644-work',
    remedy: {
      kind: 'choose-work',
      head: 'head-sha',
      tip: 'tip-sha',
      headOnly,
      tipOnly,
    },
    retryCommand: `${PLATFORM_SLUG} run continue root-run`,
  })

  expect(message).toContain('head-sha')
  expect(message).toContain('tip-sha')
  expect(message).toContain('…and 2 more')
  expect(message).toContain('…and 1 more')
  expect(message).not.toMatch(/(?:--force|(?:^|\s)-f(?:\s|$)|reset)/)
})

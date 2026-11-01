import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  readerCloneReclaimDecision,
  unmarkedReaderCloneReclaimRefusal,
} from './reclaim-reader-clone.ts'

const runId = '01990000-0000-7000-8000-000000001960'

test('a live creating run protects its unmarked reader clone', () => {
  expect(
    readerCloneReclaimDecision({ kind: 'run', runId }, [{ recordId: runId, status: 'running' }]),
  ).toEqual({
    allowed: false,
    reason: `run ${runId} status running is not terminal and may still be creating this reader clone`,
  })
})

test('a terminal or absent creating run allows its unmarked reader clone', () => {
  expect(
    readerCloneReclaimDecision({ kind: 'run', runId }, [{ recordId: runId, status: 'ok' }]),
  ).toEqual({
    allowed: true,
  })
  expect(readerCloneReclaimDecision({ kind: 'run', runId }, [])).toEqual({ allowed: true })
})

test('a live project run protects a shared review clone', () => {
  expect(
    readerCloneReclaimDecision({ kind: 'shared-review' }, [
      { recordId: runId, status: 'waiting-input' },
    ]),
  ).toEqual({
    allowed: false,
    reason: `run ${runId} status waiting-input is not terminal; the shared review clone may still be in creation`,
  })
})

test('explicit reclaim points a clean terminal unmarked run tree at sweep', () => {
  expect(
    unmarkedReaderCloneReclaimRefusal({
      runId,
      run: { recordId: runId, status: 'ok' },
      uniqueCommitCount: 0,
      dirty: false,
      dirtyDetail: 'all work is committed',
      platformSlug: PLATFORM_SLUG,
    }),
  ).toBe(
    `${PLATFORM_SLUG} machine sweep reclaims this unmarked tree once run ${runId} is terminal and it holds no unique work; both conditions are met; run ${PLATFORM_SLUG} machine sweep`,
  )
})

test('explicit reclaim names each failed unmarked run tree condition', () => {
  const common = {
    runId,
    uniqueCommitCount: 0,
    dirty: false,
    dirtyDetail: 'all work is committed',
    platformSlug: PLATFORM_SLUG,
  }
  expect(unmarkedReaderCloneReclaimRefusal({ ...common, run: null })).toContain(
    'condition failed: the run has no run record',
  )
  expect(
    unmarkedReaderCloneReclaimRefusal({
      ...common,
      run: { recordId: runId, status: 'running' },
    }),
  ).toContain('condition failed: run status running is not terminal')
  expect(
    unmarkedReaderCloneReclaimRefusal({
      ...common,
      run: { recordId: runId, status: 'ok' },
      uniqueCommitCount: 3,
    }),
  ).toContain('condition failed: it holds 3 commits not on main')
  expect(
    unmarkedReaderCloneReclaimRefusal({
      ...common,
      run: { recordId: runId, status: 'ok' },
      dirty: true,
      dirtyDetail: 'has uncommitted or untracked changes',
    }),
  ).toContain('condition failed: it has uncommitted or untracked changes')
})

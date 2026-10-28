import { describe, expect, test } from 'bun:test'
import { treeProcessCwdDecision } from './tree-process-cwd-decision.ts'

const decide = (
  cwdByPid: ReadonlyMap<number, string>,
  options: { ownPid?: number; scanError?: string | null; treePaths?: string[] } = {},
) =>
  treeProcessCwdDecision({
    treePaths: options.treePaths ?? ['/real/tree'],
    cwdByPid,
    ownPid: options.ownPid ?? 99,
    scanError: options.scanError ?? null,
  })

describe('tree process cwd decision', () => {
  test('holds for a process at the tree root', () => {
    expect(decide(new Map([[12, '/real/tree']]))).toEqual({
      action: 'hold',
      reason: { kind: 'processes', processes: [{ pid: 12, cwd: '/real/tree' }] },
    })
  })

  test('holds for a process in a tree subdirectory', () => {
    expect(decide(new Map([[12, '/real/tree/packages/app']])).action).toBe('hold')
  })

  test('proceeds when every process is outside the tree', () => {
    expect(decide(new Map([[12, '/real/other']]))).toEqual({ action: 'proceed' })
  })

  test('ignores the close-out process itself', () => {
    expect(decide(new Map([[12, '/real/tree']]), { ownPid: 12 })).toEqual({
      action: 'proceed',
    })
  })

  test('holds with the scan failure cause', () => {
    expect(decide(new Map(), { scanError: 'lsof timed out' })).toEqual({
      action: 'hold',
      reason: { kind: 'scan-error', cause: 'lsof timed out' },
    })
  })

  test('holds when a cwd matches only the recorded tree spelling', () => {
    expect(
      decide(new Map([[12, '/recorded/tree/subdir']]), {
        treePaths: ['/physical/tree', '/recorded/tree'],
      }),
    ).toMatchObject({ action: 'hold' })
  })

})

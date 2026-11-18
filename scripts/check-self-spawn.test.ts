import { describe, expect, test } from 'bun:test'
import {
  acceptedSelfSpawnFixture,
  freshTaskReadFixture,
  rejectedSelfSpawnFixtures,
  spawnedTaskReadFixture,
  spawnedTaskWriteFixture,
} from './check-self-spawn.fixtures.ts'
import {
  selfSpawnViolationLines,
  taskVerbSpawns,
  taskVerbSpawnViolations,
} from './check-self-spawn.ts'

describe('self-spawn enforcement fixtures', () => {
  for (const [name, fixture] of Object.entries(rejectedSelfSpawnFixtures)) {
    test(`rejects ${name}`, () => {
      expect(selfSpawnViolationLines(fixture)).toHaveLength(1)
    })
  }

  test('accepts a leading resolver spread through a local argv variable', () => {
    expect(selfSpawnViolationLines(acceptedSelfSpawnFixture)).toEqual([])
  })
})

describe('task-verb spawn enforcement', () => {
  test('refuses a spawned task read', () => {
    const path = 'orchestrator/src/moved-read.ts'
    expect(taskVerbSpawnViolations(path, taskVerbSpawns(spawnedTaskReadFixture, path))).toEqual([
      `${path}:3: task show must use the installed task reader`,
    ])
  })

  test('allows a baselined task write', () => {
    const path = 'orchestrator/src/issue/issue.ts'
    const writes = Array.from({ length: 4 }, () => spawnedTaskWriteFixture).join('\n')
    expect(taskVerbSpawnViolations(path, taskVerbSpawns(writes, path))).toEqual([])
  })

  test('refuses a new unbaselined task write', () => {
    const path = 'orchestrator/src/new-write.ts'
    expect(taskVerbSpawnViolations(path, taskVerbSpawns(spawnedTaskWriteFixture, path))).toEqual([
      `${path}:2: task set is not in the task-write baseline`,
    ])
  })

  test('allows only the named fresh task read', () => {
    const path = 'orchestrator/src/workflow/workflow-task-reference.ts'
    expect(taskVerbSpawnViolations(path, taskVerbSpawns(freshTaskReadFixture, path))).toEqual([])
  })
})

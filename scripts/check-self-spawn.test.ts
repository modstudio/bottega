import { describe, expect, test } from 'bun:test'
import {
  acceptedSelfSpawnFixture,
  freshTaskReadFixture,
  hubOutputTaskReadFixture,
  nonFreshNamedTaskReadFixture,
  rejectedSelfSpawnFixtures,
  spawnedTaskDocReadFixture,
  spawnedTaskDuplicatesFixture,
  spawnedTaskReadFixture,
  spawnedTaskWriteFixture,
} from './check-self-spawn.fixtures.ts'
import {
  selfSpawnViolationLines,
  TASK_WRITE_BASELINE,
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

  test('refuses a task write over its baseline', () => {
    const path = 'orchestrator/src/issue/issue.ts'
    const writes = Array.from(
      { length: TASK_WRITE_BASELINE[path].count + 1 },
      () => spawnedTaskWriteFixture,
    ).join('\n')
    const findings = taskVerbSpawns(writes, path)
    expect(taskVerbSpawnViolations(path, findings)).toEqual([
      `${path}:${findings.at(-1)?.line}: task set is not in the task-write baseline`,
    ])
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

  test('refuses a non-fresh read in the named fresh-read function', () => {
    const path = 'orchestrator/src/workflow/workflow-task-reference.ts'
    expect(
      taskVerbSpawnViolations(path, taskVerbSpawns(nonFreshNamedTaskReadFixture, path)),
    ).toEqual([`${path}:3: task show must use the installed task reader`])
  })

  test.each([
    ['hubOutput task list', hubOutputTaskReadFixture, 'list'],
    ['task doc show', spawnedTaskDocReadFixture, 'doc show'],
    ['task duplicates', spawnedTaskDuplicatesFixture, 'duplicates'],
  ])('refuses a spawned %s read', (_name, fixture, verb) => {
    const path = 'orchestrator/src/moved-read.ts'
    const findings = taskVerbSpawns(fixture, path)
    expect(taskVerbSpawnViolations(path, findings)).toEqual([
      `${path}:${findings[0]?.line}: task ${verb} must use the installed task reader`,
    ])
  })
})

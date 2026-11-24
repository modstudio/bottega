import { expect, test } from 'bun:test'
import { registerTaskReadFailures, registerTaskReadFindings } from './check-register-task-reads.ts'

test('flags a register loop that reads each project task list', () => {
  const text = `
    for (const project of projects()) {
      await readProjectTaskList(project.name)
    }
  `
  expect(registerTaskReadFindings('orchestrator/src/example.ts', text)).toEqual([
    { file: 'orchestrator/src/example.ts', line: 3 },
  ])
})

test('flags a read of the default project', () => {
  const text = 'taskReader().list({ project: DEFAULT_LOCAL_PROJECT_NAME })'
  expect(registerTaskReadFindings('cli/example.ts', text)).toEqual([
    { file: 'cli/example.ts', line: 1 },
  ])
})

test('allows a per-project read chosen by the caller', () => {
  expect(
    registerTaskReadFindings(
      'hub/src/example.ts',
      'export const read = (project: string) => readLiveProjectTasks(reader, project)',
    ),
  ).toEqual([])
})

test('allows the matching baseline file', () => {
  const file = 'orchestrator/src/context-health/context-health-adapter.ts'
  expect(
    registerTaskReadFailures(
      [{ file, text: 'projects().filter(Boolean); readProjectTaskList(project.name)' }],
      [file],
    ),
  ).toEqual([])
})

test('refuses a stale baseline entry', () => {
  const file = 'orchestrator/src/context-health/context-health-adapter.ts'
  expect(registerTaskReadFailures([{ file, text: 'export const value = 1' }], [file])).toEqual([
    expect.stringContaining('baseline entry no longer matches; remove it'),
  ])
})

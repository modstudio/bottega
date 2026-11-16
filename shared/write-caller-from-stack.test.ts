import { expect, test } from 'bun:test'
import { writeCallerFromStack } from './write-caller-from-stack.ts'

test('caller frames are labeled from plain, URL, parenthesized, and embedded paths', () => {
  const options = { repositoryRoot: '/repo', excludedFiles: ['/repo/hub/src/db.ts'] }
  expect(writeCallerFromStack('Error\n    at run (/repo/hub/src/outbox.ts:452:3)', options)).toBe(
    'hub/src/outbox.ts:452',
  )
  expect(writeCallerFromStack('Error\n    at file:///repo/hub/src/tasks.ts:9:1', options)).toBe(
    'hub/src/tasks.ts:9',
  )
  expect(writeCallerFromStack('Error\n    at run (/repo/hub/src/a (copy):17:4)', options)).toBe(
    'hub/src/a (copy):17',
  )
  expect(
    writeCallerFromStack('Error\n    at run (/$bunfs/root/hub/src/outbox.ts:31:2)', {
      repositoryRoot: '/$bunfs/root',
      excludedFiles: ['/$bunfs/root/hub/src/db.ts'],
    }),
  ).toBe('hub/src/outbox.ts:31')
})

test('caller frames skip supplied files and directories and reject paths outside the repository', () => {
  expect(
    writeCallerFromStack(
      'Error\n' +
        '    at write (/repo/hub/src/db.ts:10:2)\n' +
        '    at record (/repo/shared/store-lock-refusal-log.ts:20:3)\n' +
        '    at apply (/repo/hub/src/tasks.ts:30:4)',
      {
        repositoryRoot: '/repo',
        excludedFiles: ['/repo/hub/src/db.ts'],
        excludedDirectories: ['/repo/shared'],
      },
    ),
  ).toBe('hub/src/tasks.ts:30')
  expect(
    writeCallerFromStack('Error\n    at write (/elsewhere/service.ts:10:2)', {
      repositoryRoot: '/repo',
    }),
  ).toBeNull()
})

import { beforeEach, expect, test } from 'bun:test'
import type { Command } from 'commander'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { createHubProgram, run, usesReadOnlyStoreHandle } from './cli-program.ts'
import { createTask, showTask } from './task.ts'
import { createTaskDocument, getTaskDocument } from './task-document.ts'

beforeEach(resetFixtureStore)

test('task queries use a read-only store handle unless show refreshes its tracker', () => {
  expect(usesReadOnlyStoreHandle(['task', 'list'])).toBeTrue()
  expect(usesReadOnlyStoreHandle(['task', 'show', 'DEV-1'])).toBeTrue()
  expect(usesReadOnlyStoreHandle(['task', 'show', 'DEV-1', '--fresh'])).toBeFalse()
  expect(usesReadOnlyStoreHandle(['task', 'set', 'DEV-1'])).toBeFalse()
})

function command(root: Command, ...path: string[]): Command {
  return path.reduce((parent, name) => {
    const child = parent.commands.find((candidate) => candidate.name() === name)
    if (!child) throw new Error(`missing command ${path.join(' ')}`)
    return child
  }, root)
}

test('Commander binds scalar, repeatable, and presence options without losing targets', async () => {
  const duplicateCases = [
    ['tasks', '--hours', '1', '--hours', '2'],
    ['task', 'list', '--project', 'alpha', '--project', 'beta'],
    ['note', 'new', 'text', '--project', 'alpha', '--project', 'beta'],
    ['report', 'subscribe', '--recipient', 'one', '--recipient', 'two'],
    ['outbox', 'trace', '--row', 'one', '--row', 'two'],
  ]
  for (const argv of duplicateCases) {
    const fresh = createHubProgram()
    await expect(run(fresh, argv)).resolves.toBe(1)
  }

  const notes = createHubProgram()
  const noteList = command(notes, 'note', 'list')
  noteList.parseOptions(['--session', 'one', '--session', 'two'])
  expect(noteList.opts().session).toEqual(['one', 'two'])

  const reports = createHubProgram()
  const subscribe = command(reports, 'report', 'subscribe')
  subscribe.parseOptions(['--member', 'one', '--member', 'two'])
  expect(subscribe.opts().member).toEqual(['one', 'two'])

  const hostedUrl = process.env.BOTTEGA_HOSTED_URL
  delete process.env.BOTTEGA_HOSTED_URL
  try {
    const parent = await createTask({ project: 'workshop', title: 'Parent' })
    const child = await createTask({ project: 'workshop', title: 'Child', parent: parent.key })
    expect(await run(createHubProgram(), ['task', 'set', child.key, '--no-parent'])).toBe(0)
    expect(showTask(child.key).task.parent_key).toBeNull()
    const document = await createTaskDocument(
      { task: child.key, title: 'Handoff', role: 'handoff' },
      {},
    )
    expect(await run(createHubProgram(), ['task', 'doc', 'set', document.label, '--no-role'])).toBe(
      0,
    )
    expect(getTaskDocument(document.label, {}).role).toBeNull()
  } finally {
    if (hostedUrl !== undefined) process.env.BOTTEGA_HOSTED_URL = hostedUrl
  }
})

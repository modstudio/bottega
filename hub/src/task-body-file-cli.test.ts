import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from './cli.ts'
import { createTask, showTask } from './task.ts'

const directory = mkdtempSync(join(tmpdir(), 'hub-task-body-file-'))
const bodyFile = join(directory, 'body.md')
const priorHostedUrl = process.env.BOTTEGA_HOSTED_URL

beforeAll(() => {
  delete process.env.BOTTEGA_HOSTED_URL
  writeFileSync(bodyFile, 'Body read from a file.\n')
})

afterAll(() => {
  if (priorHostedUrl === undefined) delete process.env.BOTTEGA_HOSTED_URL
  else process.env.BOTTEGA_HOSTED_URL = priorHostedUrl
  rmSync(directory, { recursive: true, force: true })
})

test('task set reads its replacement body from a file', async () => {
  const task = await createTask({ project: 'workshop', title: 'Body file task' })
  expect(await main(['task', 'set', task.key, '--body-file', bodyFile])).toBe(0)
  expect(showTask(task.key).task.body).toBe('Body read from a file.\n')
})

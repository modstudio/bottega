import { afterEach, expect, test } from 'bun:test'
import type { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { dirname } from 'node:path'
import { dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { detach } from './run-dispatch.ts'

const originalDepth = process.env.BOTTEGA_DEPTH
afterEach(() => {
  if (originalDepth === undefined) delete process.env.BOTTEGA_DEPTH
  else process.env.BOTTEGA_DEPTH = originalDepth
})

test('two detached runs never share prompt or coordinator files', async () => {
  process.env.BOTTEGA_DEPTH = '0'
  let pid = 4_200_000
  const fakeSpawn = (() => {
    const child = new EventEmitter() as ChildProcess
    Object.defineProperty(child, 'pid', { value: pid++ })
    child.unref = () => child
    queueMicrotask(() => child.emit('spawn'))
    return child
  }) as typeof spawn
  const first = await detach(
    'summarize',
    'first detached prompt',
    { cwd: dir },
    undefined,
    fakeSpawn,
  )
  const second = await detach(
    'summarize',
    'second detached prompt',
    { cwd: dir },
    undefined,
    fakeSpawn,
  )
  const paths = db().query<{ prompt_path: string }, [string]>(
    'SELECT prompt_path FROM run WHERE record_id=?',
  )
  const firstPath = paths.get(first)!.prompt_path
  const secondPath = paths.get(second)!.prompt_path
  expect(firstPath).not.toBe(secondPath)
  expect(dirname(firstPath)).not.toBe(dirname(secondPath))
})

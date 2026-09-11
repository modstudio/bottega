import { describe, expect, test } from 'bun:test'
import { scriptedTransport } from './fake-transport.ts'

describe('scripted transport', () => {
  test('records prompts and pauses an ask until a ruling resumes the same turn', async () => {
    const fake = scriptedTransport([
      { kind: 'started', pid: 7, session: 'session-1' },
      { kind: 'stdout', chunk: 'before' },
      { kind: 'ask', question: 'Which?', why: 'The result differs.' },
      { kind: 'stdout', chunk: ' after' },
      { kind: 'completed', output: 'done' },
    ])
    const handle = await fake.transport.start({
      agent: {} as never, cwd: '/tmp', env: {}, prompt: 'original', outPath: '/tmp/out',
      startedAt: 0,
    })
    await fake.transport.prompt(handle, 'submitted')
    let settled = false
    const collected = handle.collect().then((value) => { settled = true; return value })
    await Promise.resolve()
    expect(settled).toBeFalse()
    fake.injectRuling('Use A')
    expect((await collected).output).toBe('done')
    expect(fake.prompts).toEqual(['original', 'submitted'])
    expect(fake.events).toContainEqual({ kind: 'resume', ruling: 'Use A' })
  })

  test('failure and cancellation scripts never spawn and return failed results', async () => {
    const fake = scriptedTransport([{ kind: 'failed', error: 'broken' }])
    const handle = await fake.transport.start({
      agent: {} as never, cwd: '/tmp', env: {}, prompt: 'p', outPath: '/tmp/out', startedAt: 0,
    })
    expect(await handle.collect()).toMatchObject({ status: 'failed', error: 'broken', exitCode: 1 })
  })
})

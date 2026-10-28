import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import { dir } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { readAskServerFailure } from './ask-failure.ts'
import { runAskProxy } from './ask-proxy.ts'

const trackResidue = trackedTestResidue()
const previousAskUrl = process.env.BOTTEGA_ASK_URL
const previousScratch = process.env.BOTTEGA_SCRATCH
const entryScratch = join(dir, 'ask-proxy-entry-scratch')

beforeEach(() => {
  delete process.env.BOTTEGA_ASK_URL
  process.env.BOTTEGA_SCRATCH = trackResidue(entryScratch)
})

afterEach(() => {
  if (previousAskUrl === undefined) delete process.env.BOTTEGA_ASK_URL
  else process.env.BOTTEGA_ASK_URL = previousAskUrl
  if (previousScratch === undefined) delete process.env.BOTTEGA_SCRATCH
  else process.env.BOTTEGA_SCRATCH = previousScratch
})

test('an unset ask url through the entry records the failure and prints only the message', async () => {
  const stderr: string[] = []
  const error = spyOn(console, 'error').mockImplementation((value) => stderr.push(String(value)))
  try {
    expect(await runAskProxy()).toBe(1)
    expect(stderr.join('\n')).toContain('BOTTEGA_ASK_URL is required')
    expect(stderr.join('\n')).not.toMatch(/^\s+at /m)
    expect(readAskServerFailure(entryScratch)).toBe('BOTTEGA_ASK_URL is required')
  } finally {
    error.mockRestore()
  }
})

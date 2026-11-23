import { afterEach, beforeEach } from 'bun:test'

const priorRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
beforeEach(() => delete process.env.BOTTEGA_RECORD_API_URL)
afterEach(() => {
  if (priorRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = priorRecordApiUrl
})

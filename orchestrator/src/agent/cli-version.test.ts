import { expect, test } from 'bun:test'
import { type CliVersionCapture, capturedCliVersion } from './cli-version.ts'

test('parses a v-prefixed three-part CLI version', () => {
  const capture: CliVersionCapture = {
    exitCode: 0,
    stdout: 'v22.23.5',
    stderr: '',
    timedOut: false,
    error: null,
  }

  expect(capturedCliVersion(capture)).toBe('22.23.5')
})

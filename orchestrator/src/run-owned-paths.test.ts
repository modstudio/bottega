import { expect, test } from 'bun:test'
import { runTemporaryDirectory } from './run-owned-paths.ts'

test('run temporary directory follows the writer boundary', () => {
  expect(runTemporaryDirectory(true, '/runs/1', '/scratch/1')).toBe('/scratch/1/tmp')
  expect(runTemporaryDirectory(false, '/runs/1', '/scratch/1')).toBe('/runs/1/tmp')
})

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import {
  CURRENT_CONTRACT_REPO_PATH,
  readReleaseClientContract,
  releaseClientContractContentsRefusal,
} from './release-client-contract.ts'

test('missing contents refuse when drift checking is on', () => {
  expect(releaseClientContractContentsRefusal('1.2.3', null, 'current')).toContain(
    '1.2.3 is missing',
  )
})

test('missing contents refuse when drift checking is off', () => {
  expect(
    releaseClientContractContentsRefusal('1.2.3', null, 'current', { checkDrift: false }),
  ).toContain('1.2.3 is missing')
})

test('differing contents refuse by default with the version-bump remedy', () => {
  expect(releaseClientContractContentsRefusal('1.2.3', 'old', 'current')).toBe(
    'released client contract 1.2.3 differs from the current contract; bump package.json to a new version, then run bun scripts/record-client-contract.ts --snapshot',
  )
})

test('differing contents pass when drift checking is off', () => {
  expect(
    releaseClientContractContentsRefusal('1.2.3', 'old', 'current', { checkDrift: false }),
  ).toBeNull()
})

test('equal contents pass', () => {
  expect(releaseClientContractContentsRefusal('1.2.3', 'current', 'current')).toBeNull()
})

test('writing the current contract clears the missing-current refusal named by the update remedy', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'release-client-contract-'))
  try {
    expect(() => readReleaseClientContract(root, '1.2.3')).toThrow(
      `current client contract ${CURRENT_CONTRACT_REPO_PATH} is missing\ncleared by: bun scripts/record-client-contract.ts --update`,
    )
    const current = resolve(root, CURRENT_CONTRACT_REPO_PATH)
    mkdirSync(dirname(current), { recursive: true })
    writeFileSync(current, 'current')
    expect(readReleaseClientContract(root, '1.2.3')).toEqual({
      version: '1.2.3',
      snapshot: null,
      current: 'current',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

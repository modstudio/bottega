import { expect, test } from 'bun:test'
import {
  MERGED_WITH_RESIDUE_EXIT_CODE,
  MERGED_WITH_UNRELEASED_RUNG_EXIT_CODE,
} from './pr-landed-exit-codes.ts'
import { decideMergedOutputExitCode } from './pr-post-landing.ts'

test.each([
  [
    'unsatisfied release and clean cleanup',
    { satisfied: false },
    0,
    MERGED_WITH_UNRELEASED_RUNG_EXIT_CODE,
  ],
  [
    'unsatisfied release and residue cleanup',
    { satisfied: false },
    MERGED_WITH_RESIDUE_EXIT_CODE,
    MERGED_WITH_UNRELEASED_RUNG_EXIT_CODE,
  ],
  ['satisfied release and clean cleanup', { satisfied: true }, 0, 0],
  [
    'satisfied release and residue cleanup',
    { satisfied: true },
    MERGED_WITH_RESIDUE_EXIT_CODE,
    MERGED_WITH_RESIDUE_EXIT_CODE,
  ],
] as const)('%s chooses the release-aware exit', (_name, release, cleanupExit, expected) => {
  expect(decideMergedOutputExitCode(release, cleanupExit)).toBe(expected)
})

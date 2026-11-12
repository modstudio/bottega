// concern: pull-request policy
/** Exit codes that mean a pull request landed even when later work left residue. */
import { SHIP_CLEANUP_RESIDUE_EXIT_CODE } from '../ship-cleanup/ship-cleanup-decision.ts'

export const MERGED_WITH_RESIDUE_EXIT_CODE = SHIP_CLEANUP_RESIDUE_EXIT_CODE
export const MERGED_WITH_UNRELEASED_RUNG_EXIT_CODE = 21
export const POST_LANDING_REPORTED_EXIT_CODE = 22
export const LANDED_PULL_REQUEST_EXIT_CODES: ReadonlySet<number> = new Set([
  0,
  MERGED_WITH_RESIDUE_EXIT_CODE,
  MERGED_WITH_UNRELEASED_RUNG_EXIT_CODE,
  POST_LANDING_REPORTED_EXIT_CODE,
])

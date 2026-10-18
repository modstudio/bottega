// concern: run-artifact-limits
/** Retention limits shared by run text and finished-run artifacts. */
export const KEEP_RUN_FILES_DAYS = 30
export const RUN_LEFTOVER_MAX_AGE_DAYS = 3
export const RUN_ARTIFACT_FILE_CAP_BYTES = 5 * 1024 * 1024
export const RUN_ARTIFACT_TOTAL_CAP_BYTES = 25 * 1024 * 1024
export const OUTSIDE_DEPTH_AGGREGATE_FILE_LIMIT = 10
export const RUN_ARTIFACT_BUILD_OUTPUT_DIRECTORIES = [
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  '.turbo',
  '.cache',
] as const

import { availableParallelism } from 'node:os'

const RUN_TEST_WORKER_DIVISOR = 4

export function runTestWorkerCount(parallelism: number): number {
  return Math.max(1, Math.floor(parallelism / RUN_TEST_WORKER_DIVISOR))
}

/** Apply the run default before its tracked recipe environment so the recipe wins. */
export function runTestWorkerEnvironment(
  recipeEnvironment: Record<string, string>,
  parallelism = availableParallelism(),
): Record<string, string> {
  const workers = String(runTestWorkerCount(parallelism))
  return {
    ORCH_TEST_WORKERS: workers,
    VITEST_MAX_WORKERS: workers,
    ...recipeEnvironment,
  }
}

// concern: cleanup-sweep
/** Reports an isolated sweep maintenance step without coupling its caller to error handling. */
import type { CleanupPresentation } from './cleanup.ts'

export function reportMaintenanceStep<T>(
  label: string,
  presentation: CleanupPresentation,
  run: () => T,
  line: (result: T) => string,
): void {
  try {
    presentation.log(line(run()))
  } catch (error) {
    presentation.error(`${label} failed: ${error instanceof Error ? error.message : error}`)
  }
}

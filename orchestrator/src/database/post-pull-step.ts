// concern: bounded post-pull process execution
/** Runs one post-pull child process and preserves its output and failure detail. */

import { startBoundedSync } from '../../../shared/bounded-process.ts'

export function runPostPullStep(input: {
  argv: string[]
  cwd: string
  env?: Record<string, string | undefined>
  failureLabel: string
}): void {
  const result = startBoundedSync(input.argv, {
    budget: 'machine-update',
    cwd: input.cwd,
    env: input.env,
  })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim()
    const detail = stderr ? `: ${stderr}` : ''
    throw new Error(`${input.failureLabel} failed with exit ${result.exitCode}${detail}`)
  }
}

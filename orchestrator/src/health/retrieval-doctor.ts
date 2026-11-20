// concern: retrieval doctor
/** Decides and reports retrieval health only when retrieval was configured. */

type RetrievalCheckResult = { stdout: string; stderr: string; exitCode: number }
type RetrievalDoctorReporter = { log(value: string): void; exitCode(code: number): void }

export function retrievalIsConfigured(configuredUrl: string, modelHostInstalled: boolean): boolean {
  return configuredUrl.length > 0 || modelHostInstalled
}

export function retrievalDoctorDecision(
  configured: boolean,
  result?: RetrievalCheckResult,
): { lines: string[]; failed: boolean } {
  if (!configured) return { lines: ['retrieval  not configured (optional)'], failed: false }
  if (!result) throw new Error('configured retrieval doctor requires a check result')
  const failed = result.exitCode !== 0
  return {
    lines: [
      failed
        ? 'retrieval endpoints (optional; search_code and doc search unavailable)'
        : 'retrieval endpoints',
      ...result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => `  ${line}`),
      ...(result.stderr.trim() ? [`  ${result.stderr.trim()}`] : []),
    ],
    failed,
  }
}

export async function reportRetrievalDoctor(
  configured: boolean,
  reporter: RetrievalDoctorReporter,
  check: () => Promise<RetrievalCheckResult>,
): Promise<void> {
  const decision = retrievalDoctorDecision(configured, configured ? await check() : undefined)
  for (const line of decision.lines) reporter.log(line)
  if (decision.failed) reporter.exitCode(1)
}

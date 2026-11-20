// concern: retrieval doctor
/** Decides and reports retrieval health only when retrieval was configured. */

export type RetrievalCheckResult = { stdout: string; stderr: string; exitCode: number }
export type RetrievalDoctorReporter = { log(value: string): void; exitCode(code: number): void }

export function retrievalIsConfigured(
  configuredUrl: string,
  modelHostInstalled: boolean,
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    configuredUrl.length > 0 ||
    modelHostInstalled ||
    Boolean(environment.BOTTEGA_EMBED_URL?.trim()) ||
    Boolean(environment.BOTTEGA_RERANK_URL?.trim())
  )
}

export function retrievalDoctorDecision(
  input: { configured: false } | { configured: true; result: RetrievalCheckResult },
): { lines: string[]; failed: boolean } {
  if (!input.configured) return { lines: ['retrieval  not configured (optional)'], failed: false }
  const failed = input.result.exitCode !== 0
  return {
    lines: [
      failed
        ? 'retrieval endpoints FAIL — search_code and doc search unavailable'
        : 'retrieval endpoints',
      ...input.result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => `  ${line}`),
      ...(input.result.stderr.trim() ? [`  ${input.result.stderr.trim()}`] : []),
    ],
    failed,
  }
}

export async function reportRetrievalDoctor(
  configured: boolean,
  reporter: RetrievalDoctorReporter,
  check: () => Promise<RetrievalCheckResult>,
): Promise<void> {
  const decision = configured
    ? retrievalDoctorDecision({ configured: true, result: await check() })
    : retrievalDoctorDecision({ configured: false })
  for (const line of decision.lines) reporter.log(line)
  if (decision.failed) reporter.exitCode(1)
}

export function reportRetrieval(
  configuredUrl: string,
  modelHostInstalled: boolean,
  environment: Readonly<Record<string, string | undefined>>,
  reporter: RetrievalDoctorReporter,
  check: () => Promise<RetrievalCheckResult>,
): Promise<void> {
  return reportRetrievalDoctor(
    retrievalIsConfigured(configuredUrl, modelHostInstalled, environment),
    reporter,
    check,
  )
}

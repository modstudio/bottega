import { hostedWriterGuard } from './check-hosted-secret-writers.ts'

async function runHostedSecretWriterGuard(): Promise<void> {
  const started = performance.now()
  const { findings, verdicts } = await hostedWriterGuard.currentInspection()
  for (const finding of findings)
    console.error(
      `${finding.file}:${finding.line}: hosted ${finding.table} write bypasses maskHostedTableWrite (${finding.reason})`,
    )
  if (findings.length) process.exitCode = 1
  console.log(
    `hosted secret writer statements: ${verdicts.masked} masked, ${verdicts.structured} structured-only`,
  )
  console.log(`hosted secret writer call sites: ${(performance.now() - started).toFixed(1)} ms`)
}

await runHostedSecretWriterGuard()

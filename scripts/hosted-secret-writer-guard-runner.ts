import { hostedWriterGuard } from './check-hosted-secret-writers.ts'

async function runHostedSecretWriterGuard(): Promise<void> {
  const { findings, verdicts, builderSites } = await hostedWriterGuard.currentInspection()
  const verbose = Bun.argv.includes('--verbose')
  if (findings.length || verbose)
    for (const site of builderSites)
      console.log(
        `${site.file}:${site.line}: drizzle ${site.operation} ${site.table}: ${site.verdict}`,
      )
  for (const finding of findings)
    console.error(
      `${finding.file}:${finding.line}: hosted ${finding.table} write bypasses maskHostedTableWrite (${finding.reason})`,
    )
  if (findings.length) process.exitCode = 1
  console.log(
    `hosted secret writer statements: ${verdicts.masked} masked, ${verdicts.structured} structured-only, ${builderSites.filter((site) => site.verdict === 'outside-inventory').length} outside-inventory, ${builderSites.length} builder sites`,
  )
}

await runHostedSecretWriterGuard()

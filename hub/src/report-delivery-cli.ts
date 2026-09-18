#!/usr/bin/env bun

// concern: hosted-report-delivery-cli

import { runReportDeliveryPass } from './report-delivery.ts'
import { hostedDeliveryRepository, sesReportMailClient } from './report-delivery-hosted.ts'

type Environment = Record<string, string | undefined>

export async function runReportDeliveryCommand(
  argv: string[] = process.argv.slice(2),
  environment: Environment = process.env,
) {
  const dryRun = argv.includes('--dry-run')
  if (!dryRun && environment.HUB_REPORT_DELIVERY_ENABLED !== 'true') {
    console.log(
      'report delivery is disabled; set HUB_REPORT_DELIVERY_ENABLED=true to enable sending',
    )
    return { due: 0, sent: 0, skipped: 0, failed: 0 }
  }
  const databaseUrl = environment.HUB_RECORD_DATABASE_URL
  if (!databaseUrl) throw new Error('HUB_RECORD_DATABASE_URL is required')
  const result = await runReportDeliveryPass({
    repository: hostedDeliveryRepository(databaseUrl),
    mail: sesReportMailClient(environment),
    dryRun,
    print: console.log,
  })
  console.log(
    `report delivery: ${result.due} due, ${result.sent} sent, ${result.skipped} skipped, ${result.failed} failed`,
  )
  return result
}

if (import.meta.main) await runReportDeliveryCommand()

#!/usr/bin/env bun

// concern: hosted-report-delivery-cli

import { HUB_CHANGE_RETENTION_DAYS } from '../../shared/record/schema-hub.ts'
import { pruneHostedChanges } from './change-pruning.ts'
import { runReportDeliveryPass } from './report-delivery.ts'
import { hostedDeliveryRepository, sesReportMailClient } from './report-delivery-hosted.ts'

type Environment = Record<string, string | undefined>

type DeliveryResult = { due: number; sent: number; skipped: number; failed: number }

export async function runScheduledReportDelivery(input: {
  deliveryEnabled: boolean
  dryRun: boolean
  prune(): Promise<number>
  deliver(): Promise<DeliveryResult>
  print(line: string): void
  printError(line: string): void
}) {
  try {
    const deleted = await input.prune()
    input.print(`change log pruning: ${deleted} deleted`)
  } catch (cause) {
    input.printError(`change log pruning failed: ${String(cause)}`)
  }
  if (!input.dryRun && !input.deliveryEnabled) {
    input.print(
      'report delivery is disabled; set HUB_REPORT_DELIVERY_ENABLED=true to enable sending',
    )
    return { due: 0, sent: 0, skipped: 0, failed: 0 }
  }
  const result = await input.deliver()
  input.print(
    `report delivery: ${result.due} due, ${result.sent} sent, ${result.skipped} skipped, ${result.failed} failed`,
  )
  return result
}

export async function runReportDeliveryCommand(
  argv: string[] = process.argv.slice(2),
  environment: Environment = process.env,
) {
  const dryRun = argv.includes('--dry-run')
  const databaseUrl = environment.HUB_RECORD_DATABASE_URL
  if (!databaseUrl) throw new Error('HUB_RECORD_DATABASE_URL is required')
  return runScheduledReportDelivery({
    deliveryEnabled: environment.HUB_REPORT_DELIVERY_ENABLED === 'true',
    dryRun,
    prune: () => pruneHostedChanges(databaseUrl, HUB_CHANGE_RETENTION_DAYS),
    deliver: () =>
      runReportDeliveryPass({
        repository: hostedDeliveryRepository(databaseUrl),
        mail: sesReportMailClient(environment),
        dryRun,
        hostedOrigin: environment.HUB_HOSTED_URL,
        print: console.log,
      }),
    print: console.log,
    printError: console.error,
  })
}

if (import.meta.main) await runReportDeliveryCommand()

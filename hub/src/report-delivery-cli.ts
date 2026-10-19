#!/usr/bin/env bun

// concern: hosted-report-delivery-cli

import { SQL } from 'bun'
import { pruneHostedChanges } from './change-pruning.ts'
import { resolveHostedUrl } from './hosted-url.ts'
import { runReportDeliveryPass } from './report-delivery.ts'
import { hostedDeliveryRepository, sesReportMailClient } from './report-delivery-hosted.ts'

type Environment = Record<string, string | undefined>

type DeliveryResult = {
  due: number
  sent: number
  skipped: number
  failed: number
}

export async function runScheduledReportDelivery(input: {
  deliveryEnabled: boolean
  dryRun: boolean
  prune(): Promise<number>
  deliver(): Promise<DeliveryResult>
  print(line: string): void
  printError(line: string): void
}) {
  if (input.dryRun) {
    input.print('change log pruning skipped for dry run')
  } else {
    try {
      const deleted = await input.prune()
      input.print(`change log pruning: ${deleted} deleted`)
    } catch (cause) {
      input.printError(`change log pruning failed: ${String(cause)}`)
    }
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
  input: { dryRun: boolean },
  environment: Environment = process.env,
) {
  const databaseUrl = environment.HUB_RECORD_DATABASE_URL
  if (!databaseUrl) throw new Error('HUB_RECORD_DATABASE_URL is required')
  const database = new SQL(databaseUrl)
  try {
    return await runScheduledReportDelivery({
      deliveryEnabled: environment.HUB_REPORT_DELIVERY_ENABLED === 'true',
      dryRun: input.dryRun,
      prune: () => pruneHostedChanges(database),
      deliver: () =>
        runReportDeliveryPass({
          repository: hostedDeliveryRepository(database),
          mail: sesReportMailClient(environment),
          dryRun: input.dryRun,
          hostedOrigin: resolveHostedUrl(environment),
          print: console.log,
        }),
      print: console.log,
      printError: console.error,
    })
  } finally {
    await database.close()
  }
}

if (import.meta.main)
  await runReportDeliveryCommand({
    dryRun: process.argv.slice(2).includes('--dry-run'),
  })

#!/usr/bin/env bun

// concern: hosted-report-delivery-cli

import { SQL } from 'bun'
import { recordServiceUrl } from '../../shared/record/service-connection.ts'
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
  deliver(): Promise<DeliveryResult>
  print(line: string): void
}) {
  if (!input.dryRun && !input.deliveryEnabled) {
    input.print(
      'report delivery is disabled; set BOTTEGA_REPORT_DELIVERY_ENABLED=true to enable sending',
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
  const databaseUrl = environment.BOTTEGA_RECORD_DATABASE_URL
  if (!databaseUrl) throw new Error('BOTTEGA_RECORD_DATABASE_URL is required')
  const database = new SQL(recordServiceUrl(databaseUrl))
  try {
    return await runScheduledReportDelivery({
      deliveryEnabled: environment.BOTTEGA_REPORT_DELIVERY_ENABLED === 'true',
      dryRun: input.dryRun,
      deliver: () =>
        runReportDeliveryPass({
          repository: hostedDeliveryRepository(database),
          mail: sesReportMailClient(environment),
          dryRun: input.dryRun,
          hostedOrigin: resolveHostedUrl(environment),
          print: console.log,
        }),
      print: console.log,
    })
  } finally {
    await database.close()
  }
}

if (import.meta.main)
  await runReportDeliveryCommand({
    dryRun: process.argv.slice(2).includes('--dry-run'),
  })

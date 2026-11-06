import { expect, test } from 'bun:test'
import { runScheduledReportDelivery } from './report-delivery-cli.ts'

const delivered = { due: 1, sent: 1, skipped: 0, failed: 0 }

test('scheduled report delivery does not deliver when sending is disabled', async () => {
  let deliveries = 0
  const lines: string[] = []

  const result = await runScheduledReportDelivery({
    deliveryEnabled: false,
    dryRun: false,
    deliver: async () => {
      deliveries += 1
      return delivered
    },
    print: (line) => lines.push(line),
  })

  expect(result).toEqual({ due: 0, sent: 0, skipped: 0, failed: 0 })
  expect(deliveries).toBe(0)
  expect(lines).toContain(
    'report delivery is disabled; set BOTTEGA_REPORT_DELIVERY_ENABLED=true to enable sending',
  )
})

test('scheduled report delivery delivers enabled reports', async () => {
  let deliveries = 0
  const lines: string[] = []

  const result = await runScheduledReportDelivery({
    deliveryEnabled: true,
    dryRun: false,
    deliver: async () => {
      deliveries += 1
      return delivered
    },
    print: (line) => lines.push(line),
  })

  expect(result).toEqual(delivered)
  expect(deliveries).toBe(1)
  expect(lines).toContain('report delivery: 1 due, 1 sent, 0 skipped, 0 failed')
})

test('scheduled report delivery runs a dry delivery when sending is disabled', async () => {
  let deliveries = 0
  const lines: string[] = []

  const result = await runScheduledReportDelivery({
    deliveryEnabled: false,
    dryRun: true,
    deliver: async () => {
      deliveries += 1
      return delivered
    },
    print: (line) => lines.push(line),
  })

  expect(result).toEqual(delivered)
  expect(deliveries).toBe(1)
  expect(lines).toContain('report delivery: 1 due, 1 sent, 0 skipped, 0 failed')
})

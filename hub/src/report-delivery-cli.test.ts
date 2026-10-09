import { expect, test } from 'bun:test'
import { runScheduledReportDelivery } from './report-delivery-cli.ts'

const delivered = { due: 1, sent: 1, skipped: 0, failed: 0 }

test('scheduled report delivery prunes when sending is disabled', async () => {
  let pruned = 0
  let deliveries = 0
  const lines: string[] = []

  const result = await runScheduledReportDelivery({
    deliveryEnabled: false,
    dryRun: false,
    prune: async () => {
      pruned += 1
      return 4
    },
    deliver: async () => {
      deliveries += 1
      return delivered
    },
    print: (line) => lines.push(line),
    printError: (line) => lines.push(line),
  })

  expect(result).toEqual({ due: 0, sent: 0, skipped: 0, failed: 0 })
  expect(pruned).toBe(1)
  expect(deliveries).toBe(0)
  expect(lines).toContain('change log pruning: 4 deleted')
})

test('scheduled report delivery continues when pruning fails', async () => {
  let deliveries = 0
  const errors: string[] = []

  const result = await runScheduledReportDelivery({
    deliveryEnabled: true,
    dryRun: false,
    prune: async () => {
      throw new Error('prune unavailable')
    },
    deliver: async () => {
      deliveries += 1
      return delivered
    },
    print: () => {},
    printError: (line) => errors.push(line),
  })

  expect(result).toEqual(delivered)
  expect(deliveries).toBe(1)
  expect(errors).toEqual(['change log pruning failed: Error: prune unavailable'])
})

test('scheduled report delivery skips pruning during a dry run', async () => {
  let pruned = 0
  let deliveries = 0
  const lines: string[] = []

  const result = await runScheduledReportDelivery({
    deliveryEnabled: false,
    dryRun: true,
    prune: async () => {
      pruned += 1
      return 4
    },
    deliver: async () => {
      deliveries += 1
      return delivered
    },
    print: (line) => lines.push(line),
    printError: (line) => lines.push(line),
  })

  expect(result).toEqual(delivered)
  expect(pruned).toBe(0)
  expect(deliveries).toBe(1)
  expect(lines).toContain('change log pruning skipped for dry run')
})

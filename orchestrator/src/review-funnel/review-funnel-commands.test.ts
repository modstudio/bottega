import { expect, test } from 'bun:test'
import { replayReviewFunnelCommand } from './review-funnel-commands.ts'

test('replay requires exactly one policy source', () => {
  const flags = { has: () => false, flag: () => undefined }
  expect(() => replayReviewFunnelCommand(flags, { log: () => undefined })).toThrow(
    'supply exactly one of --policy <version> or --policy-file <path>',
  )
})

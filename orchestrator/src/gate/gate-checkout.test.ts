import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refuseInProgressCheckout } from './gate-checkout.ts'

test('a missing checkout path is named in the refusal', () => {
  const checkout = mkdtempSync(join(tmpdir(), 'gate-checkout-'))
  rmSync(checkout, { recursive: true })

  expect(() => refuseInProgressCheckout(checkout)).toThrow(
    `gate run needs git dir in ${checkout}: checkout path does not exist`,
  )
})

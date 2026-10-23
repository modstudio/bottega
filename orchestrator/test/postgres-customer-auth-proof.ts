import { expect, test } from 'bun:test'
import { signInCommand, whoamiCommand } from '../src/record/record-auth-command.ts'
import { recordSpaceListCommand, recordSpaceSwitchCommand } from '../src/record/record-command.ts'
import { recordMemberships } from '../src/record/record-space.ts'

/** Registers the proof that customer commands hold no hosted database credentials. */
export function registerCustomerAuthProof(input: {
  email: string
  password: string
  userId: () => string
}): void {
  test('customer authentication and space commands need only the hosted API address', async () => {
    const directUrl = process.env.BOTTEGA_RECORD_URL
    const authSecret = process.env.BETTER_AUTH_SECRET
    delete process.env.BOTTEGA_RECORD_URL
    delete process.env.BETTER_AUTH_SECRET
    try {
      const output: string[] = []
      await signInCommand(input.email, async () => input.password, {
        log: (value) => output.push(value),
      })
      await whoamiCommand({ log: (value) => output.push(value) })
      await recordSpaceListCommand({ log: (value) => output.push(value) })
      const listed = await recordMemberships()
      const selected = listed.memberships[0]
      if (!selected) throw new Error('hosted customer proof has no membership')
      await recordSpaceSwitchCommand(selected.slug, { log: (value) => output.push(value) })
      expect(output[0]).toBe(`signed in ${input.email}`)
      expect(JSON.parse(output[1]!) as { user: { id: string } }).toHaveProperty(
        'user.id',
        input.userId(),
      )
      expect(output).toContain(`active record space ${selected.slug}`)
    } finally {
      if (directUrl !== undefined) process.env.BOTTEGA_RECORD_URL = directUrl
      if (authSecret !== undefined) process.env.BETTER_AUTH_SECRET = authSecret
    }
  })
}

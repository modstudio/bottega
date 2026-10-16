import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { checkCustomerGuideCommands, customerGuideCommandRefusal } from './doc-command-check.ts'
import { setDoc } from './docs.ts'

const article = {
  scope: 'global',
  subject: null,
  title: 'Guide',
  delivery: 'demand' as const,
  audiences: ['customer'] as ['customer'],
  kind: 'article' as const,
  reason: 'test customer guide command validation',
}

describe('customer guide command write check', () => {
  test('refuses an unknown command and allows a known command', async () => {
    await expect(
      setDoc({
        ...article,
        slug: 'unknown-command-guide',
        body: `Run \`${PLATFORM_SLUG} task not-a-command\`.`,
      }),
    ).rejects.toThrow(
      `refusing customer guide write; unknown command mention:\n- ${PLATFORM_SLUG} task not-a-command`,
    )

    const written = await setDoc({
      ...article,
      slug: 'known-command-guide',
      body: `Run \`${PLATFORM_SLUG} task show DEV-1\`.`,
    })
    expect(written.slug).toBe('known-command-guide')
    expect(written.writeWarnings).toBeUndefined()
  })

  test('a command-set load failure allows the write and reports a warning', async () => {
    const written = await setDoc({
      ...article,
      slug: 'unchecked-command-guide',
      body: `Run \`${PLATFORM_SLUG} task not-a-command\`.`,
      loadKnownCommands: () => {
        throw new Error('fixture command inventory unavailable')
      },
    })
    expect(written.writeWarnings).toEqual([
      'customer guide command check unavailable: fixture command inventory unavailable; the write was allowed',
    ])
  })

  test('a retired spelling is refused without guessing a replacement', async () => {
    await expect(
      setDoc({
        ...article,
        slug: 'retired-command-guide',
        body: 'Run `orch do DEV-1`.',
      }),
    ).rejects.toThrow(
      `refusing customer guide write; unknown command mention:\n- orch do DEV-1\ncleared by: correct the named mentions; ${PLATFORM_SLUG} --help lists the commands`,
    )
  })

  test('reference articles are excluded', () => {
    const result = checkCustomerGuideCommands({
      body: `\`${PLATFORM_SLUG} no-such-group\``,
      kind: 'article',
      form: 'reference',
      audiences: ['customer'],
    })
    expect(result).toEqual({ findings: [], warning: null })
    expect(customerGuideCommandRefusal(result.findings)).toBeNull()
  })
})

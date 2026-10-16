import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { checkCustomerGuideCommands, customerGuideCommandRefusal } from './doc-command-check.ts'
import { getDocRevision, listDocRevisions, restoreDoc, setDoc } from './docs.ts'
import { commitDocSet } from './local-doc-write.ts'

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
  })

  test('a retired spelling is refused without guessing a replacement', async () => {
    await expect(
      setDoc({
        ...article,
        slug: 'retired-command-guide',
        body: 'Run `orch do DEV-1`.',
      }),
    ).rejects.toThrow(
      `refusing customer guide write; unknown command mention:\n- orch do\ncleared by: correct the named mentions; ${PLATFORM_SLUG} --help lists the commands`,
    )
  })

  test('local restore refuses an unknown command and accepts a known command', async () => {
    const input = {
      scope: 'global',
      subject: null,
      owner: null,
      slug: 'restore-command-guide',
      projectId: null,
      title: 'Restore command guide',
      body: `Run \`${PLATFORM_SLUG} task not-a-command\`.`,
      delivery: 'demand',
      audiences: ['customer'] as ['customer'],
      parentId: null,
      position: 0,
      kind: 'article',
      identity: { author: 'test', reason: 'seed historical fixture', session: null },
      recordId: newRecordId(),
    } as const
    const seeded = commitDocSet({ ...input, revisionId: newRecordId() })
    const known = await setDoc({
      ...article,
      slug: input.slug,
      body: `Run \`${PLATFORM_SLUG} task show DEV-1353\`.`,
      expectedRevision: seeded.revision!,
    })
    const revisions = listDocRevisions('global', null, input.slug)
    const unknownRevision = revisions.find(({ id }) =>
      getDocRevision(id)?.body.includes('not-a-command'),
    )
    const knownRevision = revisions.find(({ id }) => getDocRevision(id)?.body.includes('task show'))

    await expect(
      restoreDoc('global', null, input.slug, unknownRevision!.id, {
        reason: 'try unknown command revision',
        expectedRevision: known.revision!,
      }),
    ).rejects.toThrow(`${PLATFORM_SLUG} task not-a-command`)
    await expect(
      restoreDoc('global', null, input.slug, knownRevision!.id, {
        reason: 'restore known command revision',
        expectedRevision: known.revision!,
      }),
    ).resolves.toMatchObject({ body: `Run \`${PLATFORM_SLUG} task show DEV-1353\`.` })
  })

  test('reference articles are excluded', () => {
    const result = checkCustomerGuideCommands({
      body: `\`${PLATFORM_SLUG} no-such-group\``,
      kind: 'article',
      form: 'reference',
      audiences: ['customer'],
    })
    expect(result).toEqual({ findings: [] })
    expect(customerGuideCommandRefusal(result.findings)).toBeNull()
  })
})

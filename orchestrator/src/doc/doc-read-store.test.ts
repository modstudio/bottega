import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { setDoc } from '../../test/fixtures/docs.ts'
import { encodeContextItem } from './context-item-codec.ts'
import { CONTEXT_FACTS_PORTS_KEY, type ContextFactsPorts } from './context-write-adapter.ts'
import { upsertProject } from '../project/projects.ts'
import {
  getDocForAudienceStore,
  getDocStore,
  listDocMetadataStore,
  listDocsBySubjectPrefixStore,
} from './doc-read-store.ts'

describe('document read store', () => {
  test('lists documents by an escaped subject prefix', async () => {
    const session = newRecordId()
    ;(globalThis as typeof globalThis & { [CONTEXT_FACTS_PORTS_KEY]?: ContextFactsPorts })[
      CONTEXT_FACTS_PORTS_KEY
    ] = { tasks: async () => [], pointer: async () => null }
    const previousSession = process.env.CLAUDE_CODE_SESSION_ID
    process.env.CLAUDE_CODE_SESSION_ID = session
    await setDoc({
      scope: 'context',
      subject: `session:${session}`,
      slug: 'first',
      title: 'First',
      body: encodeContextItem({ kind: 'fact', source: 'test', body: 'body' }),
    })
    if (previousSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = previousSession
    expect(
      listDocsBySubjectPrefixStore('context', `session:${session}`).map((doc) => doc.slug),
    ).toEqual(['first'])
  })

  test('omitted subjects resolve only a unique slug in the scope', async () => {
    for (const name of ['first-project', 'second-project']) {
      upsertProject({
        recordId: newRecordId(),
        name,
        path: `/fixture/${name}`,
        settings: {},
      })
    }
    const resume = (project: string) =>
      `---\nstatus: open\nepic: DEV-1504\nproject: ${project}\nwritten: 2026-10-21T12:00:00.000Z\n---\n\nNEXT ACTION: continue\n`
    await setDoc({
      scope: 'resume',
      subject: 'first-project',
      slug: 'unique-brief',
      title: 'Unique brief',
      body: resume('first-project'),
    })
    expect(getDocStore('resume', undefined, 'unique-brief')).toMatchObject({
      subject: 'first-project',
      body: resume('first-project'),
    })

    await setDoc({
      scope: 'resume',
      subject: 'first-project',
      slug: 'shared-brief',
      title: 'First shared brief',
      body: resume('first-project'),
    })
    await setDoc({
      scope: 'resume',
      subject: 'second-project',
      slug: 'shared-brief',
      title: 'Second shared brief',
      body: resume('second-project'),
    })
    expect(() => getDocStore('resume', undefined, 'shared-brief')).toThrow(
      'several resume docs "shared-brief" match subjects: first-project, second-project; pass subject',
    )
    expect(getDocStore('resume', undefined, 'absent-brief')).toBeNull()
  })

  test('audience reads project sections while author reads retain marks', async () => {
    const body = 'Everyone.\n:::section{audience="internal"}\nPrivate margin.\n:::\nAfter.'
    const created = await setDoc({
      scope: 'global',
      subject: null,
      slug: 'sectioned',
      title: 'Sectioned',
      body,
      delivery: 'demand',
      audiences: ['internal', 'customer'],
      reason: 'exercise audience sections',
    })
    expect(getDocStore('global', null, created.slug)?.body).toBe(body)
    expect(getDocForAudienceStore('global', null, created.slug, 'customer')?.body).toBe(
      'Everyone.\nAfter.',
    )
    expect(getDocForAudienceStore('global', null, created.slug, 'internal')?.body).toContain(
      'Private margin.',
    )
    expect(listDocMetadataStore({ audience: 'customer', bodyMatch: 'Private margin' })).toEqual([])
    expect(
      listDocMetadataStore({ audience: 'internal', bodyMatch: 'Private margin' }),
    ).toHaveLength(1)
    expect(listDocMetadataStore({ audience: 'customer' })).toContainEqual(
      expect.objectContaining({
        slug: created.slug,
        summary: 'Everyone. After.',
        summarySource: 'derived',
      }),
    )
    await expect(
      setDoc({
        scope: 'global',
        subject: null,
        slug: created.slug,
        title: created.title,
        body,
        audiences: ['customer'],
        reason: 'orphan the internal section',
        expectedRevision: created.revision!,
      }),
    ).rejects.toThrow('document does not list')
  })
})

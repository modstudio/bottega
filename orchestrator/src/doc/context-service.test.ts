import { afterEach, describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { removeDoc, setDoc } from '../../test/fixtures/docs.ts'
import { upsertProject } from '../project/projects.ts'
import type { SecretScanner } from '../secret-scan/secret-scan.ts'
import { encodeContextItem } from './context-item-codec.ts'
import { CONTEXT_FACTS_PORTS_KEY, type ContextFactsPorts } from './context-write-adapter.ts'
import { DOC_SECRET_SCANNER_KEY } from './doc-secret-scan.ts'
import { importDoc, listDocMetadata, listDocs } from './docs.ts'

const globals = globalThis as typeof globalThis & {
  [CONTEXT_FACTS_PORTS_KEY]?: ContextFactsPorts
  [DOC_SECRET_SCANNER_KEY]?: SecretScanner
}
const tasks: ContextFactsPorts = {
  tasks: async () => [{ key: 'DEV-1844', record_id: newRecordId(), project: PLATFORM_SLUG }],
  pointer: async () => null,
}

afterEach(() => {
  delete globals[CONTEXT_FACTS_PORTS_KEY]
  globals[DOC_SECRET_SCANNER_KEY] = () => ({ status: 'clean' })
})

describe('context document integration', () => {
  test('uses per-item compare-and-set and names the stale item and revision', async () => {
    globals[CONTEXT_FACTS_PORTS_KEY] = tasks
    const body = encodeContextItem({
      kind: 'next-action',
      source: 'run:1',
      body: 'Continue the slice.',
    })
    const first = await setDoc({
      scope: 'context',
      subject: 'task:DEV-1844',
      slug: 'next',
      title: 'next',
      body,
      delivery: 'demand',
    })
    const second = await setDoc({
      scope: 'context',
      subject: 'task:DEV-1844',
      slug: 'next',
      title: 'next',
      body: body.replace('Continue', 'Finish'),
      delivery: 'demand',
      expectedRevision: first.revision!,
    })
    await expect(
      setDoc({
        scope: 'context',
        subject: 'task:DEV-1844',
        slug: 'next',
        title: 'next',
        body,
        delivery: 'demand',
        expectedRevision: first.revision!,
      }),
    ).rejects.toThrow(new RegExp(`context item next:.*current revision ${second.revision}`, 's'))
    await expect(
      setDoc({
        scope: 'context',
        subject: 'task:DEV-1844',
        slug: 'next',
        title: 'next',
        body,
        delivery: 'demand',
      }),
    ).rejects.toThrow(`pass --expected-revision ${second.revision}`)
  })

  test('every write verb applies the context policy, not only set', async () => {
    globals[CONTEXT_FACTS_PORTS_KEY] = tasks
    await setDoc({
      scope: 'context',
      subject: 'task:DEV-1844',
      slug: 'next',
      title: 'next',
      body: encodeContextItem({ kind: 'next-action', source: 'run:1', body: 'Continue.' }),
      delivery: 'demand',
    })
    await expect(removeDoc('context', 'task:DEV-1844', 'next')).rejects.toThrow(
      'cannot remove the last required next-action item',
    )
    await expect(
      importDoc({
        scope: 'context',
        subject: 'task:DEV-1844',
        slug: 'raw',
        title: 'raw',
        body: 'No frontmatter.',
        reason: 'test import',
      }),
    ).rejects.toThrow('requires YAML frontmatter')
  })

  test('fails closed for context while ordinary docs warn and write', async () => {
    globals[CONTEXT_FACTS_PORTS_KEY] = tasks
    globals[DOC_SECRET_SCANNER_KEY] = () => ({ status: 'unavailable', reason: 'scanner offline' })
    await expect(
      setDoc({
        scope: 'context',
        subject: 'task:DEV-1844',
        slug: 'next',
        title: 'next',
        body: encodeContextItem({ kind: 'next-action', source: 'run:1', body: 'Continue.' }),
        delivery: 'demand',
      }),
    ).rejects.toThrow('context writes fail closed')

    upsertProject({ recordId: newRecordId(), name: 'context-secret-warning', path: '/tmp/project' })
    const ordinary = await setDoc({
      scope: 'project',
      subject: 'context-secret-warning',
      slug: 'ordinary',
      title: 'Ordinary',
      body: 'Allowed with warning.',
    })
    expect(ordinary.writeWarnings?.[0]).toContain('write allowed unchecked')
  })

  test('refuses a task holder outside the platform task store', async () => {
    globals[CONTEXT_FACTS_PORTS_KEY] = {
      ...tasks,
      tasks: async () => [{ key: 'SHIP-7', record_id: newRecordId(), project: 'starship' }],
    }
    await expect(
      setDoc({
        scope: 'context',
        subject: 'task:SHIP-7',
        slug: 'next',
        title: 'next',
        body: encodeContextItem({ kind: 'next-action', source: 'run:1', body: 'Continue.' }),
        delivery: 'demand',
      }),
    ).rejects.toThrow(`task:SHIP-7 is not in the ${PLATFORM_SLUG} task store`)
  })

  test('refuses a write to a session holder by any other session', async () => {
    globals[CONTEXT_FACTS_PORTS_KEY] = tasks
    const other = newRecordId()
    await expect(
      setDoc({
        scope: 'context',
        subject: `session:${other}`,
        slug: 'next',
        title: 'next',
        body: encodeContextItem({ kind: 'next-action', source: 'run:1', body: 'Continue.' }),
        delivery: 'demand',
      }),
    ).rejects.toThrow(`only owning session ${other} may write session:${other}`)
  })

  test('default document listing excludes context', async () => {
    globals[CONTEXT_FACTS_PORTS_KEY] = tasks
    await setDoc({
      scope: 'context',
      subject: 'task:DEV-1844',
      slug: 'next',
      title: 'next',
      body: encodeContextItem({ kind: 'next-action', source: 'run:1', body: 'Continue.' }),
      delivery: 'demand',
    })
    expect(listDocMetadata().some((doc) => doc.scope === 'context')).toBe(false)
    expect(listDocs().some((doc) => doc.scope === 'context')).toBe(false)
    expect(listDocs({ scope: 'context' })).toHaveLength(1)
    expect(listDocMetadata({ scope: 'context' })).toHaveLength(1)
  })
})

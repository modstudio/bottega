import { describe, expect, test } from 'bun:test'
import { setDoc } from '../../test/fixtures/docs.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogue,
  setStepCatalogue,
} from '../workflow/step-catalogue.ts'
import { removeDoc } from './docs.ts'

const targetSlug = '.agents/reference/removal-target.md'
const targetBody = '---\ndescription: Removal target\n---\n\n# Target\n'
const citation = `Read [the target](${targetSlug}).\n`

describe('stored canon removal preflight', () => {
  test('removeDoc supplies shared workflow step bodies to the decision', async () => {
    const target = await setDoc({
      scope: 'canon',
      subject: null,
      slug: targetSlug,
      title: 'Target',
      body: targetBody,
      allowCanonBootstrap: true,
    })
    const current = productionStepCatalogue().definition
    const draft = setStepCatalogue(
      {
        steps: [
          ...current.steps,
          {
            slug: 'canon-removal-citer',
            title: 'Canon removal citer',
            body: citation,
            floor: ['ruling'],
            job: null,
            stage: 'review',
            autonomy: 'ask',
            needs: [],
          },
        ],
      },
      'test workflow citation',
      'test',
    )
    promoteStepCatalogue(draft.n, 'publish test workflow citation', 'test')

    await expect(
      removeDoc('canon', null, targetSlug, {
        reason: 'test removal',
        expectedRevision: target.revision!,
      }),
    ).rejects.toThrow('workflow step canon-removal-citer:1')
  })

  test("refuses removing a user row cited by another of the owner's rows", async () => {
    const owner = '01990000-0000-7000-8000-000000000954'
    const target = await setDoc({
      scope: 'canon',
      subject: null,
      owner,
      slug: targetSlug,
      title: 'Target',
      body: targetBody,
      allowCanonBootstrap: true,
    })
    await setDoc({
      scope: 'canon',
      subject: null,
      owner,
      slug: 'AGENTS.md',
      title: 'Citer',
      body: citation,
      allowCanonBootstrap: true,
    })

    await expect(
      removeDoc(
        'canon',
        null,
        targetSlug,
        { reason: 'test owned removal', expectedRevision: target.revision! },
        owner,
      ),
    ).rejects.toThrow('AGENTS.md:1')
  })

  test("checks an unmanaged project's canon before removing a global row", async () => {
    upsertProject({
      name: 'unmanaged',
      path: process.cwd(),
      canon: true,
      settings: { managedContext: false },
    })
    const target = await setDoc({
      scope: 'canon',
      subject: null,
      slug: targetSlug,
      title: 'Target',
      body: targetBody,
      allowCanonBootstrap: true,
    })
    await setDoc({
      scope: 'canon',
      subject: 'unmanaged',
      slug: 'AGENTS.md',
      title: 'Citer',
      body: citation,
      allowCanonBootstrap: true,
    })

    await expect(
      removeDoc('canon', null, targetSlug, {
        reason: 'test global removal',
        expectedRevision: target.revision!,
      }),
    ).rejects.toThrow('AGENTS.md:1')
    expect(db().query('SELECT COUNT(*) AS n FROM doc WHERE slug=?').get(targetSlug)).toEqual({
      n: 1,
    })
  })
})

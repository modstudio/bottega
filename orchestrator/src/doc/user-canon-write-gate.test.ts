import { expect, test } from 'bun:test'
import { setDoc } from './docs.ts'

test('a four-row user write uses the harness load budget instead of the repo tier budget', async () => {
  const owner = '01990000-0000-7000-8000-000000000093'
  const prose = (minimum: number) => {
    const sentence = 'Keep this rule current.\n'
    return sentence.repeat(Math.ceil(minimum / sentence.length))
  }
  const rule = (name: string) => `---\ndescription: ${name}\nalways: true\n---\n${prose(7_000)}`
  const rows = [
    { slug: 'AGENTS.md', title: 'Personal entry', body: prose(15_000) },
    { slug: '.agents/rules/alpha.md', title: 'Alpha', body: rule('Alpha rule') },
    { slug: '.agents/rules/bravo.md', title: 'Bravo', body: rule('Bravo rule') },
    { slug: '.agents/rules/charlie.md', title: 'Charlie', body: rule('Charlie rule') },
  ]

  for (const row of rows.slice(0, 3)) {
    await setDoc({
      scope: 'canon',
      subject: null,
      owner,
      ...row,
      reason: 'build owned budget fixture',
      allowCanonBootstrap: true,
    })
  }
  await expect(
    setDoc({
      scope: 'canon',
      subject: null,
      owner,
      ...rows[3]!,
      reason: 'cross only repository tier budget',
    }),
  ).resolves.toMatchObject({ owner, slug: rows[3]!.slug })
})

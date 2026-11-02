import { expect, test } from 'bun:test'
import { restoreDoc, setDoc } from './docs.ts'

test('canon writes and restores return clock-time numeral warnings', async () => {
  const first = await setDoc({
    scope: 'canon',
    subject: null,
    slug: 'AGENTS.md',
    title: 'Entry',
    body: 'Run from 11 PM to 7 AM US Eastern.\n',
    reason: 'store the clock-time revision',
    allowCanonBootstrap: true,
  })
  expect(first.writeWarnings).toContainEqual(
    expect.stringMatching(/AGENTS\.md:1 canon\/numeral .*11/),
  )
  const later = await setDoc({
    scope: 'canon',
    subject: null,
    slug: 'AGENTS.md',
    title: 'Entry',
    body: 'Keep the current rule.\n',
    reason: 'replace the clock-time revision',
    expectedRevision: first.revision!,
  })
  const restored = await restoreDoc('canon', null, 'AGENTS.md', first.revision!, {
    reason: 'restore the clock-time revision',
    expectedRevision: later.revision!,
  })
  expect(restored.writeWarnings).toContainEqual(expect.stringContaining('canon/numeral'))
})

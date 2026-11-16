import { expect, test } from 'bun:test'
import { packedResumePromptWithCarriedAttachments } from './run-resume-prompt.ts'

const TOKEN = 'attached-text:11111111-1111-4111-8111-111111111111'

test('a resumed prompt resolves and carries an attachment from the turn prompt', async () => {
  const prompt = await packedResumePromptWithCarriedAttachments(
    'implement',
    `CONTINUATION MESSAGE ${TOKEN}`,
    'missing-root',
    {
      readAttachment: async () => ({
        kind: 'live',
        id: TOKEN.slice('attached-text:'.length),
        cursor: 42,
        stepSlug: 'design',
        body: 'ATTACHMENT BODY',
      }),
    },
  )

  expect(prompt).toContain('ATTACHMENT BODY')
  expect(prompt.indexOf('ATTACHMENT BODY')).toBeLessThan(prompt.indexOf('CONTINUATION MESSAGE'))
})

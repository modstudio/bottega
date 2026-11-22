import { expect, test } from 'bun:test'
import { maskHostedWrite, withHostedMaskWarnings } from './hosted-secret-mask.ts'
import { redactSecretShaped } from './secret-shaped.ts'

const token = 'ghp_123456789012345678901234567890123456'

test('deny-list masks a newly added free-text field and preserves structured strings', async () => {
  const generic = 'a key=value line with bearer prose and VGhpcyBpcyBhIGdlbmVyaWMgcHJvc2Ugc2FtcGxl'
  const input = {
    title: token,
    addedLater: { prose: token },
    projectId: token,
    status: token,
    body: generic,
  }
  const response = await withHostedMaskWarnings(async () => {
    expect(maskHostedWrite('hub.task.create', input)).toEqual({
      title: redactSecretShaped(token, { precision: 'high' }).text,
      addedLater: { prose: redactSecretShaped(token, { precision: 'high' }).text },
      projectId: token,
      status: token,
      body: generic,
    })
    return new Response('ok')
  })
  expect(response.headers.get('warning')).toContain('title (provider-prefix)')
  expect(response.headers.get('warning')).toContain('addedLater.prose (provider-prefix)')
  expect(input.title).toBe(token)
})

test('reap reasons are masked while structured fields survive byte-identical', () => {
  const input = { stale: [{ recordId: token, reason: token, at: token }], cutoff: token }
  expect(maskHostedWrite('hub.note.reap', input)).toEqual({
    stale: [
      { recordId: token, reason: redactSecretShaped(token, { precision: 'high' }).text, at: token },
    ],
    cutoff: token,
  })
})

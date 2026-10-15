import { expect } from 'bun:test'

export async function proveHostedCanonRefusal(
  origin: string,
  headers: Record<string, string>,
): Promise<void> {
  const canon = await fetch(`${origin}/v1/docs`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      scope: 'canon',
      subject: null,
      slug: '.agents/rules/unlinted.md',
      title: 'No',
      body: 'Rule without required metadata.\n',
      delivery: 'demand',
      reason: 'prove canon refusal',
      author: 'proof',
    }),
  })
  expect(canon.status).toBe(400)
  expect(await canon.json()).toMatchObject({
    error: expect.stringContaining('refusing canon write'),
  })
}

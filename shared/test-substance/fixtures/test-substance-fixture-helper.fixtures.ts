import { expect } from 'bun:test'

export function expectImported() {
  expect('fixture').toBe('fixture')
}

export async function refusedBy(value: Promise<unknown>, _constraint: string) {
  await expect(value).rejects.toBeDefined()
}

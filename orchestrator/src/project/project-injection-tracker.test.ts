import { expect, test } from 'bun:test'
import { validateProjectSettings } from './projects.ts'

test('the register accepts updatedSince only for protocols that define the filter', () => {
  for (const protocol of ['workspace-mcp', 'cursor-mcp'] as const) {
    expect(
      validateProjectSettings({ tracker: { protocol, updatedSince: true } }, 'strict'),
    ).toEqual([])
  }
  for (const protocol of ['array-mcp', 'hub'] as const) {
    expect(
      validateProjectSettings({ tracker: { protocol, updatedSince: true } }, 'strict'),
    ).toEqual([
      expect.stringContaining(
        'updatedSince is accepted only by the workspace-mcp and cursor-mcp protocols',
      ),
    ])
  }
})

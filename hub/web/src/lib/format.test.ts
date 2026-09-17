import { expect, test } from 'bun:test'
import { vendorFigures } from './format'

test('vendor figures remain separate currencies', () => {
  expect(
    vendorFigures([
      { agent: 'grok', tokens: 1_200_000 },
      { agent: 'codex', tokens: 340_000 },
    ]),
  ).toBe('grok 1.2M · codex 340K')
})

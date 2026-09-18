import { expect, test } from 'bun:test'
import { compactTokens, vendorFigures } from './format'

test('token counts use one abbreviated spelling', () => {
  expect([1_200, 3_400_000, 1_100_000_000, 999].map(compactTokens)).toEqual([
    '1.2K',
    '3.4M',
    '1.1B',
    '999',
  ])
})

test('vendor figures remain separate currencies', () => {
  expect(
    vendorFigures([
      { agent: 'grok', tokens: 1_200_000 },
      { agent: 'codex', tokens: 340_000 },
    ]),
  ).toBe('grok 1.2M · codex 340K')
})

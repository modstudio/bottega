import { expect, test } from 'bun:test'
import { viewStyles } from './view.styles.ts'

test('the document rail preserves its drawer and desktop class strings', () => {
  expect(viewStyles().rail({ inDrawer: true })).toBe('flex h-full flex-col p-4')
  expect(viewStyles().rail({ inDrawer: false })).toBe(
    'flex max-h-[min(24rem,70dvh)] flex-col border-border-default border-b p-5 lg:sticky lg:top-(--docs-stick) lg:max-h-[calc(100dvh-var(--docs-stick))] lg:self-start lg:border-b-0',
  )
})

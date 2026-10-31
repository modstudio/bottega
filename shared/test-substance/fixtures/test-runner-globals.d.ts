type FixtureMatcher = {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
  toBeDefined(): void
  toBeNull(): void
  toHaveTitle(expected: string): Promise<void>
  toThrow(expected?: unknown): void
  rejects: FixtureMatcher
  resolves: FixtureMatcher
}

type FixturePage = { goto(url: string): Promise<unknown> }
type FixtureCallback = (context: { page: FixturePage }) => unknown
type FixtureTest = {
  (name: string, callback: FixtureCallback | (() => unknown)): void
  only(name: string, callback: FixtureCallback | (() => unknown)): void
  skip(name: string, callback: FixtureCallback | (() => unknown)): void
  describe(name: string, callback: () => unknown): void
  extend(fixtures: Record<string, unknown>): FixtureTest
}
type FixtureExpect = (value: unknown, message?: string) => FixtureMatcher

declare const test: FixtureTest
declare const expect: FixtureExpect

declare module '@playwright/test' {
  export const test: FixtureTest
  export const expect: FixtureExpect
}

declare module 'vitest' {
  export const test: FixtureTest
  export const expect: FixtureExpect
  export const describe: FixtureTest['describe']
}

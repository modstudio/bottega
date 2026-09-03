import type { FetchCreateContextFnOptions } from '@trpc/server/adapters/fetch'

export type Context = Record<string, never>

export function createContext(_options: FetchCreateContextFnOptions): Context {
  return {}
}

import type { FetchCreateContextFnOptions } from '@trpc/server/adapters/fetch'

export type Context = {
  cookie?: string
  authorization?: string
}

export function createContext(options: FetchCreateContextFnOptions): Context {
  return {
    cookie: options.req.headers.get('cookie') ?? undefined,
    authorization: options.req.headers.get('authorization') ?? undefined,
  }
}

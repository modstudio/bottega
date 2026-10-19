import type { FetchCreateContextFnOptions } from '@trpc/server/adapters/fetch'
import type { SQL } from 'bun'

export type Context = {
  cookie?: string
  authorization?: string
  recordDatabase?: SQL
}

export function createContext(options: FetchCreateContextFnOptions, recordDatabase?: SQL): Context {
  return {
    cookie: options.req.headers.get('cookie') ?? undefined,
    authorization: options.req.headers.get('authorization') ?? undefined,
    recordDatabase,
  }
}

/** A value that proves a protected callback settles synchronously. */
export type SynchronousResult =
  | void
  | null
  | string
  | number
  | boolean
  | bigint
  | symbol
  | (object & { readonly then?: never })

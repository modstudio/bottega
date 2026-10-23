export type FlagInput = Record<string, string | string[] | boolean>

export const flags = (input: FlagInput = {}) => ({
  has: (name: string) =>
    input[name] === true || typeof input[name] === 'string' || Array.isArray(input[name]),
  flag: (name: string) =>
    typeof input[name] === 'string'
      ? (input[name] as string)
      : Array.isArray(input[name])
        ? (input[name] as string[])[0]
        : undefined,
  values: (name: string) =>
    Array.isArray(input[name])
      ? (input[name] as string[])
      : typeof input[name] === 'string'
        ? [input[name] as string]
        : [],
})

// concern: cli
/** Commander-only argv plumbing. Must not know any application concern. */
import type { Command, OptionValues } from 'commander'
import { format } from 'node:util'

export type CliFlags = {
  has(name: string): boolean
  flag(name: string): string | undefined
  values(name: string): string[]
}

let invocationArgv: string[] = []
export function setRawArgv(argv: string[]): void {
  invocationArgv = argv
}
export function rawArgv(_command: Command): string[] {
  return invocationArgv
}

const optionKey = (name: string) =>
  name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())

/** Adapts Commander's already-parsed values to existing service flag ports. */
export function optionFlags(options: OptionValues): CliFlags {
  return {
    has: (name) =>
      name.startsWith('no-')
        ? options[optionKey(name.slice(3))] === false || Boolean(options[optionKey(name)])
        : Boolean(options[optionKey(name)]),
    flag: (name) => {
      const value = options[optionKey(name)]
      if (Array.isArray(value)) {
        if (value.length > 1) throw new Error(`--${name} may be supplied only once`)
        return value[0] === undefined ? undefined : String(value[0])
      }
      return value === undefined || typeof value === 'boolean' ? undefined : String(value)
    },
    values: (name) => {
      const value = options[optionKey(name)]
      if (Array.isArray(value)) return value.map(String)
      return value === undefined || typeof value === 'boolean' ? [] : [String(value)]
    },
  }
}

export const collect = (value: string, previous: string[]): string[] => [...previous, value]

/** Carries parsed Commander values to product grammars retained for a later slice. */
export function productArgv(command: string, args: string[], options: OptionValues): string[] {
  const flags = Object.entries(options).flatMap(([name, value]) => {
    const flag = `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
    if (value === false || value === undefined) return []
    if (value === true) return [flag]
    if (Array.isArray(value)) return value.flatMap((item) => [flag, String(item)])
    return [flag, String(value)]
  })
  return [command, ...args, ...flags]
}

export function duration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function writeStdout(value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(value, (error) => (error ? reject(error) : resolve()))
  })
}

/**
 * Every adapter writes stdout through here and the program awaits the queue
 * before it returns. Under Bun a bare console.log to a slow pipe is cut at the
 * pipe buffer once node:process is loaded (Commander loads it), so a large JSON
 * document reached a shell capture as a 65,536-byte fragment; a write with a
 * completion callback is delivered whole. A closed reader is not an error here.
 */
const pending: Promise<void>[] = []
export function log(...values: unknown[]): void {
  pending.push(writeStdout(`${format(...values)}\n`).catch(() => undefined))
}
export function write(value: string): void {
  pending.push(writeStdout(value).catch(() => undefined))
}
export async function drainStdout(): Promise<void> {
  while (pending.length) await Promise.all(pending.splice(0))
}

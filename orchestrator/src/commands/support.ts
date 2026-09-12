// concern: cli
/** Commander-only argv plumbing. Must not know any application concern. */
import type { Command } from 'commander'
import { format } from 'node:util'
import { flagValue, flagValues } from '../args.ts'

export type CliFlags = {
  has(name: string): boolean
  flag(name: string): string | undefined
  values(name: string): string[]
}

let invocationArgv: string[] = []
export function setRawArgv(argv: string[]): void { invocationArgv = argv }
export function rawArgv(_command: Command): string[] { return invocationArgv }

export function cliFlags(argv: string[]): CliFlags {
  return {
    has: (name) => argv.includes(`--${name}`) || argv.some((arg) => arg.startsWith(`--${name}=`)),
    flag: (name) => flagValue(argv, name),
    values: (name) => flagValues(argv, name),
  }
}

export function valueOptions(command: Command, names: readonly string[]): Command {
  for (const name of names) command.option(`--${name} <value>`)
  return command
}

export function booleanOptions(command: Command, names: readonly string[]): Command {
  for (const name of names) command.option(`--${name}`)
  return command
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
    process.stdout.write(value, (error) => error ? reject(error) : resolve())
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

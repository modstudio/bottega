import { readFileSync, rmSync, writeFileSync } from 'node:fs'

export function reportPathFromArguments(argv: string[]): string | undefined {
  return argv.find((argument) => argument.startsWith('--report='))?.slice(9) || undefined
}

export function readRemainingReport(path: string | undefined): number | undefined {
  if (!path) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { remaining?: unknown }
    return Number.isInteger(parsed.remaining) && Number(parsed.remaining) >= 0
      ? Number(parsed.remaining)
      : undefined
  } catch {
    return undefined
  } finally {
    rmSync(path, { force: true })
  }
}

export function reportRemaining(path: string | undefined, remaining: number): void {
  if (path) writeFileSync(path, JSON.stringify({ remaining }))
}

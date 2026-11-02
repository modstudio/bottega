#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Ruled bottega-api memory floor; lowering it is an operator ruling. */
export const HOSTED_API_MEMORY_FLOOR_MB = 1024

/** The tracked hosted API Fly config the floor applies to. */
export const HOSTED_API_FLY_CONFIG = 'orchestrator/deploy/api/fly.toml'

type HostedMemoryInputs = {
  path: string
  text: string
  floorMb: number
}

function memoryMb(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const match = value.match(/^(\d+)(mb|gb)$/i)
  if (!match) return undefined
  const amount = Number(match[1])
  return match[2]!.toLowerCase() === 'gb' ? amount * 1024 : amount
}

function namedValue(value: unknown): string {
  return JSON.stringify(value) ?? String(value)
}

/** Decide whether every hosted API VM pins memory at or above the ruled floor. */
export function decideHostedMemory({ path, text, floorMb }: HostedMemoryInputs): string[] {
  let parsed: Record<string, unknown>
  try {
    parsed = Bun.TOML.parse(text) as Record<string, unknown>
  } catch (error) {
    return [`${path}: TOML parse failed: ${String(error)}; fix the TOML syntax in ${path}`]
  }

  if (!Array.isArray(parsed.vm) || parsed.vm.length === 0) {
    return [
      `${path}: memory is not pinned and the deploy would use Fly's default; set memory = "${floorMb}mb" under [[vm]]`,
    ]
  }

  const findings: string[] = []
  for (const vm of parsed.vm) {
    if (typeof vm !== 'object' || vm === null || !('memory' in vm)) {
      findings.push(
        `${path}: memory is not pinned and the deploy would use Fly's default; set memory = "${floorMb}mb" under [[vm]]`,
      )
      continue
    }
    const value = (vm as Record<string, unknown>).memory
    const parsedMb = memoryMb(value)
    if (parsedMb === undefined) {
      findings.push(
        `${path}: memory value ${namedValue(value)} does not parse; write it as <digits>mb, <digits>gb or integer megabytes`,
      )
    } else if (parsedMb < floorMb) {
      findings.push(
        `${path}: memory value ${namedValue(value)} is below the ${floorMb}mb floor; raise it to at least ${floorMb}mb; lowering the floor is an operator ruling in scripts/check-hosted-memory.ts`,
      )
    }
  }
  return findings
}

if (import.meta.main) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const path = HOSTED_API_FLY_CONFIG
  const text = readFileSync(resolve(root, path), 'utf8')
  const findings = decideHostedMemory({ path, text, floorMb: HOSTED_API_MEMORY_FLOOR_MB })
  if (findings.length) {
    console.error('hosted memory check failed')
    for (const finding of findings) console.error(finding)
    process.exit(1)
  }
  console.log(`hosted memory check passed (${path} at or above ${HOSTED_API_MEMORY_FLOOR_MB}mb)`)
}

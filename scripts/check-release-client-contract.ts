import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CURRENT_CONTRACT_PATH, RELEASED_CONTRACT_DIRECTORY } from './record-client-contract.ts'

export function releaseClientContractRefusal(tag: string): string | null {
  const version = tag.startsWith('v') ? tag.slice(1) : tag
  const snapshot = resolve(RELEASED_CONTRACT_DIRECTORY, `${version}.json`)
  const remedy = 'bun scripts/record-client-contract.ts --snapshot'
  if (!existsSync(snapshot)) return `released client contract ${version} is missing; run ${remedy}`
  if (readFileSync(snapshot, 'utf8') !== readFileSync(CURRENT_CONTRACT_PATH, 'utf8'))
    return `released client contract ${version} differs from the current contract; run ${remedy}`
  return null
}

if (import.meta.main) {
  const tag = process.argv[2]
  if (!tag) throw new Error('usage: bun scripts/check-release-client-contract.ts <tag>')
  const refusal = releaseClientContractRefusal(tag)
  if (refusal) {
    console.error(refusal)
    process.exitCode = 1
  }
}

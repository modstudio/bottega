import { resolve } from 'node:path'
import {
  readReleaseClientContract,
  releaseClientContractContentsRefusal,
} from '../orchestrator/src/release/release-client-contract.ts'

function releaseClientContractRefusal(tag: string): string | null {
  const contract = readReleaseClientContract(resolve(import.meta.dir, '..'), tag)
  return releaseClientContractContentsRefusal(contract.version, contract.snapshot, contract.current)
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

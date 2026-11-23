import { dirname, normalize } from 'node:path'
import type { ArchitectureModule } from './architecture.ts'

const module = (file: string, allowed: string[]): ArchitectureModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const recordBoardClientModules = [
  module('orchestrator/src/record/record-api-client-board-claims.ts', [
    './record-api-client-paths.ts',
    './record-board-contract.ts',
  ]),
]

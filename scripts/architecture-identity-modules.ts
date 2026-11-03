import { dirname, normalize } from 'node:path'
import type { ArchitectureModule } from './architecture.ts'

const module = (file: string, allowed: string[]): ArchitectureModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const identityModules = [
  module('scripts/identity-typed-question-manifest.ts', ['./identity-inventory.ts']),
  module('scripts/identity-ruled-reference-manifest.ts', ['./identity-inventory.ts']),
  module('scripts/identity-undeclared-reference-manifest.ts', ['./identity-inventory.ts']),
]

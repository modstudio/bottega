// concern: architecture-manifest
/** Key-store module allowlists, kept outside the root manifest to preserve its ceiling. */
import { dirname, normalize } from 'node:path'

type KeyStoreModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): KeyStoreModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const keyStoreModules: KeyStoreModule[] = [
  module('shared/key-store.ts', ['./brand.ts']),
  module('shared/file-backed-secret-paths.ts', [
    'node:path',
    './config-directory.ts',
    './state-directory.ts',
  ]),
  module('shared/machine-key-store.ts', [
    'node:crypto',
    'node:fs',
    'node:path',
    './brand.ts',
    './config-directory.ts',
    './file-backed-secret-paths.ts',
    './key-store.ts',
    './machine-key-id.ts',
    './secret-envelope.ts',
    './keychain.ts',
  ]),
  module('shared/record-session.ts', [
    'node:crypto',
    'node:fs',
    'node:path',
    './brand.ts',
    './key-store.ts',
    './keychain.ts',
    './state-directory.ts',
  ]),
]

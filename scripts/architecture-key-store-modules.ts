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
  module('shared/key-store-constants.ts', ['./brand.ts']),
  module('shared/key-store.ts', [
    './config-directory.ts',
    './key-store-constants.ts',
    './machine-config.ts',
  ]),
  module('shared/file-backed-secret-paths.ts', [
    'node:fs',
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
    './key-store-constants.ts',
    './key-store.ts',
    './machine-key-id.ts',
    './secret-envelope.ts',
    './keychain.ts',
  ]),
  module('shared/machine-signing-key.ts', [
    '@noble/curves/ed25519.js',
    'node:fs',
    'node:path',
    './brand.ts',
    './config-directory.ts',
    './file-backed-secret-paths.ts',
    './keychain.ts',
    './machine-key-store.ts',
  ]),
  module('shared/record-session.ts', [
    'node:crypto',
    'node:fs',
    'node:path',
    './brand.ts',
    './file-backed-secret-paths.ts',
    './key-store.ts',
    './keychain.ts',
    './refusal.ts',
    './state-directory.ts',
  ]),
]

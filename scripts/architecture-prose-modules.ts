// concern: architecture-manifest
/** Shared prose module allowlists, kept outside the root manifests to preserve their ceilings. */
import { dirname, normalize } from 'node:path'

type ProseModule = { file: string; allowed: string[] }

type ProseBoundarySpec = ProseModule & {
  name: string
  reason: string
  typeOnlyAllowed: string[]
}

const module = (file: string, allowed: string[]): ProseModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const proseModules: ProseModule[] = [
  module('orchestrator/src/check/check-prose.ts', [
    'node:fs',
    '../../../shared/prose/prose-gate.ts',
    '../prose-service.ts',
  ]),
  module('orchestrator/src/doc/doc-prose.ts', [
    '../prose-service.ts',
    './doc-article-fields.ts',
    './doc-body-prose.ts',
    './doc-read-store.ts',
  ]),
  module('orchestrator/src/doc/doc-body-prose.ts', ['../settings/settings.ts']),
  module('orchestrator/src/prose-service.ts', [
    '../../shared/machine-config.ts',
    '../../shared/prose/prose-gate.ts',
    './record/record-session.ts',
  ]),
  module('orchestrator/src/record/record-api-doc-prose.ts', [
    '../../../shared/prose/prose-gate.ts',
    '../doc/doc-body-prose.ts',
    './record-api-prose.ts',
    './record-auth.ts',
    './record-doc-errors.ts',
  ]),
  module('orchestrator/src/record/record-api-prose.ts', ['./record-auth.ts']),
  module('shared/prose/prose-mask.ts', []),
  module('shared/prose/prose-lint.ts', ['./prose-mask.ts']),
  module('shared/prose/naming-rule.ts', ['./prose-mask.ts']),
  module('shared/prose/english-words.ts', ['../../node_modules/word-list/words.txt']),
  module('shared/prose/prose-check.ts', [
    './harper-adapter.ts',
    './naming-rule.ts',
    './prose-mask.ts',
  ]),
  module('shared/prose/harper-adapter.ts', [
    './dictionary.txt',
    './record-rules.json',
    'harper.js',
    'harper.js/binary',
  ]),
  module('shared/prose/prose-gate.ts', [
    './english-words.ts',
    './harper-adapter.ts',
    './prose-check.ts',
  ]),
]

export const proseBoundarySpecs: ProseBoundarySpec[] = [
  {
    name: 'english-words-boundary',
    file: 'shared/prose/english-words.ts',
    allowed: ['../../node_modules/word-list/words.txt'],
    typeOnlyAllowed: [],
    reason: 'Keep the embedded word-list adapter independent of prose policy and platform concerns.',
  },
  {
    name: 'prose-gate-boundary',
    file: 'shared/prose/prose-gate.ts',
    allowed: ['./english-words.ts', './harper-adapter.ts', './prose-check.ts'],
    typeOnlyAllowed: [],
    reason: 'Keep the write gate shared while its callers own transport and persistence.',
  },
  {
    name: 'prose-lint-boundary',
    file: 'shared/prose/prose-lint.ts',
    allowed: ['./prose-mask.ts'],
    typeOnlyAllowed: [],
    reason:
      'Keep shared prose lint decisions pure and independent of filesystems, stores, commands, and processes.',
  },
  {
    name: 'prose-mask-boundary',
    file: 'shared/prose/prose-mask.ts',
    allowed: [],
    typeOnlyAllowed: [],
    reason:
      'Keep prose masking pure and independent of filesystems, stores, commands, and processes.',
  },
  {
    name: 'naming-rule-boundary',
    file: 'shared/prose/naming-rule.ts',
    allowed: ['./prose-mask.ts'],
    typeOnlyAllowed: [],
    reason:
      'Keep record naming decisions pure and independent of filesystems, stores, commands, and processes.',
  },
  {
    name: 'prose-check-boundary',
    file: 'shared/prose/prose-check.ts',
    allowed: ['./naming-rule.ts', './prose-mask.ts'],
    typeOnlyAllowed: ['./harper-adapter.ts'],
    reason:
      'Keep prose check composition pure and independent of filesystems, stores, commands, and processes.',
  },
  {
    name: 'harper-adapter-boundary',
    file: 'shared/prose/harper-adapter.ts',
    allowed: ['./dictionary.txt', './record-rules.json', 'harper.js', 'harper.js/binary'],
    typeOnlyAllowed: [],
    reason: 'Keep Harper I/O isolated from pure prose decisions and every platform concern.',
  },
]

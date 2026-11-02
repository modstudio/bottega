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
  module('shared/prose/prose-check.ts', ['./naming-rule.ts', './prose-mask.ts']),
  module('shared/prose/spelling-lists.ts', [
    '../../typos.toml',
    './british-spellings.txt',
    './dictionary.txt',
    './misspellings.txt',
  ]),
  module('shared/prose/prose-gate.ts', ['./prose-check.ts', './spelling-lists.ts']),
]

export const proseBoundarySpecs: ProseBoundarySpec[] = [
  {
    name: 'spelling-lists-boundary',
    file: 'shared/prose/spelling-lists.ts',
    allowed: ['typos.toml', './british-spellings.txt', './dictionary.txt', './misspellings.txt'],
    typeOnlyAllowed: [],
    reason: 'Keep embedded correction-list data access independent of prose policy and platforms.',
  },
  {
    name: 'prose-gate-boundary',
    file: 'shared/prose/prose-gate.ts',
    allowed: ['./prose-check.ts', './spelling-lists.ts'],
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
    typeOnlyAllowed: [],
    reason:
      'Keep prose check composition pure and independent of filesystems, stores, commands, and processes.',
  },
]

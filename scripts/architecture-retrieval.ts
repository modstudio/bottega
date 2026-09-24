// concern: architecture-manifest
/** The retrieval concern's module allowlists, kept beside the root manifest so it stays within its file ceiling. */
import { dirname, normalize } from 'node:path'

type RetrievalModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): RetrievalModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const retrievalModules: RetrievalModule[] = [
  module('retrieval/src/corpus/chunks.ts', ['node:fs/promises', 'node:path', 'bun']),
  module('retrieval/src/contract.ts', []),
  module('retrieval/src/services/endpoints.ts', ['../contract.ts']),
  module('retrieval/src/refresh-plan.ts', ['./contract.ts', './corpus/chunks.ts']),
  module('retrieval/src/vector-ranking.ts', []),
  module('retrieval/src/index-store.ts', [
    'node:fs',
    'node:path',
    'bun:sqlite',
    './contract.ts',
    './refresh-plan.ts',
  ]),
  module('retrieval/src/code-search.ts', [
    'node:crypto',
    '../../shared/orch-contract.ts',
    '../../shared/state-directory.ts',
    './contract.ts',
    './corpus/chunks.ts',
    './index-store.ts',
    './refresh-plan.ts',
    './services/endpoints.ts',
    './vector-ranking.ts',
  ]),
  module('retrieval/src/search.ts', [
    'node:crypto',
    'node:path',
    '../../shared/orch-contract.ts',
    '../../shared/state-directory.ts',
    './contract.ts',
    './corpus/chunks.ts',
    './index-store.ts',
    './refresh-plan.ts',
    './services/endpoints.ts',
    './vector-ranking.ts',
  ]),
  module('retrieval/src/search-cli.ts', [
    'node:path',
    '../../shared/orch-contract.ts',
    './code-search.ts',
    './search.ts',
    './services/endpoints.ts',
  ]),
  module('retrieval/src/benchmark/metrics.ts', ['../corpus/chunks.ts']),
  module('retrieval/src/benchmark/queries.ts', ['../../../shared/brand.ts']),
  module('retrieval/src/benchmark/keyword.ts', ['../corpus/chunks.ts']),
  module('retrieval/src/benchmark/benchmark.ts', [
    'node:fs/promises',
    'node:path',
    '../../../shared/brand.ts',
    '../code-search.ts',
    '../corpus/chunks.ts',
    '../contract.ts',
    '../search.ts',
    '../services/endpoints.ts',
    '../vector-ranking.ts',
    './keyword.ts',
    './metrics.ts',
    './queries.ts',
  ]),
]

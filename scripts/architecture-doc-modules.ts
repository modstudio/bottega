// concern: architecture-manifest
/** Document module allowlists kept outside the root manifest's file ceiling. */
import { dirname, normalize } from 'node:path'

type DocModule = { file: string; allowed: string[] }
const module = (file: string, allowed: string[]): DocModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const docModules: DocModule[] = [
  module('orchestrator/src/doc/doc-command-mentions.ts', ['../../../shared/brand.ts']),
  module('orchestrator/src/doc/doc-command-check.ts', [
    '../../../shared/command-spellings.ts',
    '../../../shared/brand.ts',
    '../../../shared/doc-sections.ts',
    '../../../shared/docs.ts',
    './doc-command-mentions.ts',
  ]),
  module('orchestrator/src/doc/doc-order.ts', []),
  module('orchestrator/src/doc/local-doc-order.ts', [
    '../database/db.ts',
    './doc-order.ts',
    './doc-write-allowed.ts',
    './doc-write-guard.ts',
  ]),
  module('orchestrator/src/doc/reference-publish.ts', [
    'node:fs',
    'node:path',
    '../../../shared/brand.ts',
    '../../../shared/git.ts',
    './docs.ts',
    './doc-generator.ts',
  ]),
  module('orchestrator/src/doc/doc-generator.ts', []),
  module('orchestrator/src/doc/doc-reference-write.ts', [
    './doc-generator.ts',
    './doc-write-allowed.ts',
  ]),
  module('orchestrator/src/doc/doc-resume-frontmatter.ts', []),
  module('orchestrator/src/doc/doc-article-fields.ts', [
    '../../../shared/brand.ts',
    '../../../shared/docs.ts',
    '../canon/canon-files.ts',
    '../canon/canon-hydrate.ts',
    '../subject/subjects.ts',
    './doc-read-store.ts',
    './doc-write-allowed.ts',
    './doc-generator.ts',
  ]),
  module('shared/doc-sections.ts', [
    'mdast-util-directive',
    'mdast-util-from-markdown',
    'micromark-extension-directive',
    './docs.ts',
  ]),
  module('shared/doc-snippet.ts', []),
  module('orchestrator/src/doc/doc-audiences-codec.ts', ['../../../shared/docs.ts']),
  module('orchestrator/src/doc/doc-hosted-client.ts', [
    '../project/projects.ts',
    '../record/record-api-client.ts',
    '../record/record-project-destination-client.ts',
    './doc-write-allowed.ts',
  ]),
  module('orchestrator/src/doc/canon-import-collision.ts', ['../../../shared/brand.ts']),
  module('orchestrator/src/doc/doc-files.ts', [
    'node:fs',
    'node:path',
    '../../../shared/docs.ts',
    './doc-read-store.ts',
    './doc-write-allowed.ts',
  ]),
  module('orchestrator/src/doc/doc-status.ts', [
    '../../../shared/brand.ts',
    '../../../shared/docs.ts',
  ]),
  module('orchestrator/src/doc/doc-write-guard.ts', ['../worker-store-write.ts']),
  module('orchestrator/src/doc/local-doc-status.ts', [
    '../../../shared/docs.ts',
    './doc-read-store.ts',
    './doc-status.ts',
  ]),
  module('orchestrator/src/doc/doc-read-store.ts', [
    '../../../shared/doc-sections.ts',
    '../../../shared/docs.ts',
    '../database/db.ts',
    './doc-audiences-codec.ts',
    './doc-write-allowed.ts',
  ]),
  module('orchestrator/src/doc/doc-tree-rules.ts', [
    '../../../shared/brand.ts',
    '../../../shared/docs.ts',
  ]),
  module('orchestrator/src/doc/doc-subjects.ts', [
    '../../../shared/docs.ts',
    '../agent/agent-registry.ts',
    '../database/db.ts',
    '../jobs/jobs.ts',
  ]),
  module('orchestrator/src/doc/local-doc-tree-service.ts', [
    '../../../shared/brand.ts',
    '../../../shared/docs.ts',
    '../database/db.ts',
    './doc-audiences-codec.ts',
    './doc-read-store.ts',
    './doc-tree-rules.ts',
  ]),
  module('orchestrator/src/doc/local-doc-write.ts', [
    '../../../shared/docs.ts',
    '../../../shared/record/schema.ts',
    '../database/db.ts',
    './doc-audiences-codec.ts',
    './doc-read-store.ts',
    './doc-revision-store.ts',
    './doc-write-allowed.ts',
  ]),
  module('orchestrator/src/doc/doc-owner.ts', [
    '../record/record-attribution.ts',
    '../record/record-auth.ts',
    '../record/machine-identity.ts',
    '../record/record-write-authority.ts',
  ]),
]

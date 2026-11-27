export const noteEvaluationModuleSpecs = [
  {
    file: 'hub/src/note-classes.ts',
    allowed: [
      '../../shared/brand.ts',
      './note-evaluation-reader.ts',
      './note-evaluation-record.ts',
    ],
  },
  {
    file: 'hub/src/note-classification.ts',
    allowed: [
      '../../shared/brand.ts',
      './note-curation-decisions.ts',
      './note-duplicate-question.ts',
      './note-evaluation.ts',
      './task-row.ts',
      './task.ts',
      './typed-question-declarations.ts',
      './typed-question-service.ts',
    ],
  },
  {
    file: 'hub/src/note-evaluate.ts',
    allowed: [
      './note-classification.ts',
      './note-curation-decisions.ts',
      './note-curation.ts',
      './note-evaluation-record.ts',
      './note-evaluation.ts',
      './note-read.ts',
      './orch.ts',
      './projects.ts',
    ],
  },
  { file: 'hub/src/note-evaluation-identity.ts', allowed: [] },
  {
    file: 'hub/src/note-evaluation-reader.ts',
    allowed: ['./note-evaluation-identity.ts', './orch-doc-revision.ts', './orch.ts'],
  },
  {
    file: 'hub/src/note-curation-decisions.ts',
    allowed: ['./note-evaluation.ts'],
  },
  {
    file: 'hub/src/note-curation.ts',
    allowed: [
      'zod',
      './note-curation-decisions.ts',
      './note-curator-orch.ts',
      './note-evaluation.ts',
    ],
  },
  {
    file: 'hub/src/note-curator-orch.ts',
    allowed: [
      'node:fs/promises',
      '../../shared/brand.ts',
      '../../shared/bounded-process.ts',
      '../../shared/runtime-assets.ts',
      '../../shared/self-spawn.ts',
      './orch-project-register.ts',
    ],
  },
  {
    file: 'hub/src/note-evaluation-record.ts',
    allowed: [
      './note-classification.ts',
      './note-curation-decisions.ts',
      './note-curation.ts',
      './note-evaluation-identity.ts',
      './note-evaluation.ts',
    ],
  },
] as const

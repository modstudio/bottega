// concern: note classification
/** Reads the live class seed and performs the fail-open Jev class pass. */

import { resolveActiveSpaceCredentialValue } from '../../shared/credential-value.ts'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  resolveTypesafeCredential,
  TYPESAFE_CREDENTIAL_SET_COMMAND,
} from '../../shared/typed-question/client.ts'
import type { TaskRow } from './task-row.ts'
import { NOTE_DUPLICATE_CONCURRENCY } from './note-duplicate-question.ts'
import type { CuratorNote, NoteProposal, SeedClass } from './note-curation-decisions.ts'
import { listTasks } from './task.ts'
import {
  NOTE_CLASS_ACCEPT_CONFIDENCE,
  NOTE_CLASS_QUESTION,
} from './typed-question-declarations.ts'
import { askHubTypedQuestionWithReuse } from './typed-question-service.ts'

const NOTE_CLASS_EPIC = 'DEV-2079'
const NOTE_CLASS_SUBJECT_KIND = 'note'

const CLASS_TITLE = /^Class (C[1-9][0-9]*): (.+)$/

export function seedClassesFromTasks(tasks: readonly TaskRow[]): SeedClass[] {
  return tasks
    .flatMap((task) => {
      const title = task.title?.match(CLASS_TITLE)
      if (!title || (task.status_category !== 'open' && task.status_category !== 'active')) return []
      const definition = NOTE_CLASS_QUESTION.criteria[title[1]!]
      return definition
        ? [{ code: title[1]!, name: title[2]!, definition }]
        : [{ code: title[1]!, name: title[2]!, definition: task.body?.trim() || title[2]! }]
    })
    .sort((left, right) => left.code.localeCompare(right.code))
}

export async function readLiveSeedClasses(project = PLATFORM_SLUG): Promise<SeedClass[]> {
  return seedClassesFromTasks(await listTasks({ project, parent: NOTE_CLASS_EPIC }))
}

type ClassPassDependencies = {
  credential(): Promise<{ available: true } | { available: false; reason: string }>
  ask: typeof askHubTypedQuestionWithReuse
}

export type NoteClassPass = {
  ran: boolean
  status: string
  answers: number
  proposals: NoteProposal[]
  remaining: CuratorNote[]
}

function optionCodes(): string[] {
  return Object.keys(NOTE_CLASS_QUESTION.criteria)
    .filter((code) => code !== 'none')
    .sort()
}

export function seedMismatch(seed: readonly SeedClass[]): string | null {
  const seedCodes = seed.map(({ code }) => code).sort()
  const declared = optionCodes()
  return seedCodes.join(',') === declared.join(',')
    ? null
    : `Jev class pass skipped: seed ${seedCodes.join(',')} differs from note_class v1 options ${declared.join(',')}; declare a new note_class version`
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor++
      results[index] = await operation(values[index]!)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(NOTE_DUPLICATE_CONCURRENCY, values.length) }, worker),
  )
  return results
}

export async function runNoteClassPass(
  notes: readonly CuratorNote[],
  seed: readonly SeedClass[],
  dependencies: ClassPassDependencies = defaultDependencies,
): Promise<NoteClassPass> {
  const mismatch = seedMismatch(seed)
  if (mismatch)
    return { ran: false, status: mismatch, answers: 0, proposals: [], remaining: [...notes] }
  const credential = await dependencies.credential()
  if (!credential.available)
    return {
      ran: false,
      status: credential.reason,
      answers: 0,
      proposals: [],
      remaining: [...notes],
    }
  const seedCodes = new Set(seed.map(({ code }) => code))
  const results = await mapConcurrent(notes, (note) =>
    dependencies.ask({
      question: NOTE_CLASS_QUESTION,
      subjectKind: NOTE_CLASS_SUBJECT_KIND,
      subjectRef: note.record_id,
      state: note.text,
    }),
  )
  const proposals: NoteProposal[] = []
  const remaining: CuratorNote[] = []
  let answers = 0
  notes.forEach((note, index) => {
    const result = results[index]
    if (result) answers++
    const answer = result?.answer
    if (
      answer &&
      'choice' in answer &&
      seedCodes.has(answer.choice) &&
      answer.confidence >= NOTE_CLASS_ACCEPT_CONFIDENCE
    ) {
      proposals.push({
        label: note.label,
        class: { seed: answer.choice },
        duplicate_of: null,
        still_holds: 'unsure',
        reason: `note_class v1 confidence ${answer.confidence.toFixed(3)}`,
        source: 'jev',
      })
    } else remaining.push(note)
  })
  return {
    ran: true,
    status:
      notes.length > 0 && answers === 0
        ? 'Jev class pass obtained no answers: the typed-question service returned no answers'
        : `Jev class pass obtained ${answers}/${notes.length} answers`,
    answers,
    proposals,
    remaining,
  }
}

async function credentialAvailability() {
  try {
    const credential = await resolveTypesafeCredential(resolveActiveSpaceCredentialValue)
    return credential.kind === 'resolved'
      ? ({ available: true } as const)
      : ({
          available: false,
          reason: `Jev class pass obtained no answers: the typesafe/api-key credential is not configured; run ${TYPESAFE_CREDENTIAL_SET_COMMAND}`,
        } as const)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return { available: false, reason: `Jev class pass obtained no answers: ${message}` } as const
  }
}

const defaultDependencies: ClassPassDependencies = {
  credential: credentialAvailability,
  ask: askHubTypedQuestionWithReuse,
}

// concern: note classification
/** Reads the live class seed and performs the fail-open Jev class pass. */

import { PLATFORM_SLUG } from '../../shared/brand.ts'
import type { CuratorNote, NoteProposal, SeedClass } from './note-curation-decisions.ts'
import { NOTE_DUPLICATE_CONCURRENCY } from './note-duplicate-question.ts'
import { mapConcurrent } from './note-evaluation.ts'
import { listTasks } from './task.ts'
import type { TaskRow } from './task-row.ts'
import {
  NOTE_CLASS_ACCEPT_CONFIDENCE,
  NOTE_CLASS_QUESTION,
  TYPED_QUESTION_DECLARATIONS,
} from './typed-question-declarations.ts'
import {
  askHubTypedQuestionWithReuse,
  typedQuestionCredentialAvailability,
} from './typed-question-service.ts'

const NOTE_CLASS_EPIC = 'DEV-2079'
const NOTE_CLASS_SUBJECT_KIND = 'note'

const CLASS_TITLE = /^Class (C[1-9][0-9]*): (.+)$/

export function seedClassesFromTasks(tasks: readonly TaskRow[]): SeedClass[] {
  const liveClasses = tasks.flatMap((task) => {
    const title = task.title?.match(CLASS_TITLE)
    return title && (task.status_category === 'open' || task.status_category === 'active')
      ? [{ task, code: title[1]!, name: title[2]! }]
      : []
  })
  const question = selectNoteClassQuestion(liveClasses.map(({ code }) => code))
  return liveClasses
    .flatMap(({ task, code, name }) => {
      // The newest declaration is the intentional fallback when no version matches the seed.
      const definition = (question ?? NOTE_CLASS_QUESTION).criteria[code]
      return definition
        ? [{ code, name, definition }]
        : [{ code, name, definition: task.body?.trim() || name }]
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

function optionCodes(criteria: Readonly<Record<string, string>>): string[] {
  return Object.keys(criteria)
    .filter((code) => code !== 'none')
    .sort()
}

const NOTE_CLASS_QUESTIONS = TYPED_QUESTION_DECLARATIONS.filter(
  (question): question is typeof NOTE_CLASS_QUESTION =>
    question.id === 'note_class' && question.type === 'choice',
)

export function selectNoteClassQuestion(seedCodes: readonly string[]) {
  const seed = [...seedCodes].sort().join(',')
  return NOTE_CLASS_QUESTIONS.filter(
    (question) => optionCodes(question.criteria).join(',') === seed,
  ).reduce<(typeof NOTE_CLASS_QUESTIONS)[number] | undefined>(
    (selected, question) =>
      !selected || question.version > selected.version ? question : selected,
    undefined,
  )
}

function classPassRefusal(seed: readonly SeedClass[]): string {
  const seedCodes = [...new Set(seed.map(({ code }) => code))].sort()
  const declarations = [...NOTE_CLASS_QUESTIONS]
    .sort((left, right) => left.version - right.version)
    .map((question) => `v${question.version} ${optionCodes(question.criteria).join(',')}`)
    .join('; ')
  return `Jev class pass skipped: seed ${seedCodes.join(',')} matches no declared note_class version (${declarations}); declare a new note_class version`
}

export async function runNoteClassPass(
  notes: readonly CuratorNote[],
  seed: readonly SeedClass[],
  dependencies: ClassPassDependencies = defaultDependencies,
): Promise<NoteClassPass> {
  const question = selectNoteClassQuestion(seed.map(({ code }) => code))
  if (!question)
    return {
      ran: false,
      status: classPassRefusal(seed),
      answers: 0,
      proposals: [],
      remaining: [...notes],
    }
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
  const results = await mapConcurrent(notes, NOTE_DUPLICATE_CONCURRENCY, (note) =>
    dependencies.ask({
      question,
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
        reason: `note_class v${question.version} confidence ${answer.confidence.toFixed(3)}`,
        source: 'jev',
      })
    } else remaining.push(note)
  })
  return {
    ran: true,
    status:
      notes.length > 0 && answers === 0
        ? `Jev class pass obtained no answers: the typed-question service returned no answers (note_class v${question.version})`
        : `Jev class pass obtained ${answers}/${notes.length} answers (note_class v${question.version})`,
    answers,
    proposals,
    remaining,
  }
}

const defaultDependencies: ClassPassDependencies = {
  credential: () => typedQuestionCredentialAvailability('Jev class pass obtained no answers'),
  ask: askHubTypedQuestionWithReuse,
}

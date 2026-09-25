import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { type OperatorWaitingItem, queryClient, trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { Button } from '@/ui/button/button'
import { Textarea } from '@/ui/field/textarea'
import { DisplayRow } from '@/ui/form-layout/form-layout'
import { PageHeader } from '@/ui/page-header/page-header'
import { RadioRows } from '@/ui/radio-rows/radio-rows'

export const Route = createFileRoute('/inbox_/$kind/$id')({ component: InboxDetailPage })

function InboxDetailPage() {
  const { kind, id } = Route.useParams()
  const [answeredQuestions, setAnsweredQuestions] = useState<OperatorWaitingItem[] | null>(null)
  const waiting = useQuery(
    trpc.operator.waiting.queryOptions(undefined, { refetchInterval: 20_000 }),
  )
  const item = waiting.data?.find((row) => row.kind === kind && row.id === Number(id))
  if (waiting.isPending) return <p className="text-text-muted">Loading question...</p>
  if (waiting.error)
    return (
      <p data-tone="error" className="text-status-text">
        Could not load this item: {waiting.error.message}
      </p>
    )
  if (!item && !answeredQuestions)
    return (
      <section>
        <PageHeader
          title="No longer waiting"
          subtitle="This item may already have been answered."
        />
        <Link to="/inbox">Return to the inbox</Link>
      </section>
    )
  const questions =
    answeredQuestions ??
    (item?.kind === 'question'
      ? (waiting.data ?? []).filter(
          (candidate) => candidate.kind === 'question' && candidate.run_id === item.run_id,
        )
      : [])
  return item?.kind === 'workflow' && !answeredQuestions ? (
    <WorkflowRuling item={item} />
  ) : (
    <QuestionRuling
      key={questions.map((question) => question.id).join(':')}
      questions={questions}
      onAnswered={setAnsweredQuestions}
    />
  )
}

function WorkflowRuling({ item }: { item: { question: string; session_id: string | null } }) {
  return (
    <section className="max-w-3xl">
      <PageHeader title="Workflow ruling" subtitle="Waiting on you" />
      <h2 className="mb-4 font-mono text-xl">{item.question}</h2>
      <p className="text-text-muted">
        Answer this ruling in the waiting session <strong>{item.session_id ?? '(unknown)'}</strong>.
        Workflow rulings cannot be answered from the hub yet.
      </p>
    </section>
  )
}

type Draft = { choice: string; freeText: string }

function QuestionRuling({
  questions,
  onAnswered,
}: {
  questions: OperatorWaitingItem[]
  onAnswered: (questions: OperatorWaitingItem[]) => void
}) {
  const first = questions[0]!
  const [drafts, setDrafts] = useState<Record<number, Draft>>(() =>
    Object.fromEntries(
      questions.map((question) => [
        question.id,
        {
          choice: question.recommendation ?? question.options[0] ?? '',
          freeText: '',
        },
      ]),
    ),
  )
  const answer = useMutation({
    ...trpc.operator.answer.mutationOptions(),
    onSuccess: async () => {
      onAnswered(questions)
      await queryClient.invalidateQueries({ queryKey: trpc.operator.waiting.queryKey() })
    },
  })
  const runId = first.run_id
  const rulings = questions.map((question) => ({
    questionId: question.id,
    ruling: drafts[question.id]?.freeText.trim() || drafts[question.id]?.choice || '',
  }))
  return (
    <section className="max-w-3xl">
      <PageHeader
        title="Operator question"
        subtitle={`${first.project ?? 'no project'}${first.task_key ? ` · ${first.task_key}` : ''}`}
      />
      <div className="space-y-6 border border-border-default bg-surface-raised p-6">
        <Badge tone="warning">waiting on you</Badge>
        {questions.map((question, index) => {
          const draft = drafts[question.id] ?? { choice: '', freeText: '' }
          const update = (change: Partial<Draft>) =>
            setDrafts((current) => ({
              ...current,
              [question.id]: { ...draft, ...change },
            }))
          return (
            <div
              key={question.id}
              className="space-y-4 border-b border-border-default pb-6 last:border-0 last:pb-0"
            >
              <h2 className="font-mono text-xl">
                {questions.length > 1 ? `${index + 1}. ` : ''}
                {question.question}
              </h2>
              {question.why ? <DisplayRow label="Why" value={question.why} /> : null}
              {question.options.length ? (
                <RadioRows
                  label="Ruling"
                  value={draft.choice}
                  options={question.options.map((option) => ({
                    value: option,
                    label: option,
                    recommended: option === question.recommendation,
                  }))}
                  onChange={(value) => update({ choice: value, freeText: '' })}
                />
              ) : null}
              <div>
                <label
                  htmlFor={`custom-ruling-${question.id}`}
                  className="mb-2 block font-medium text-sm"
                >
                  Free-text ruling
                </label>
                <Textarea
                  id={`custom-ruling-${question.id}`}
                  value={draft.freeText}
                  placeholder="Write a different ruling"
                  onChange={(event) => update({ freeText: event.target.value })}
                />
              </div>
            </div>
          )
        })}
        <Button
          variant="primary"
          disabled={
            !runId || rulings.some(({ ruling }) => !ruling) || answer.isPending || answer.isSuccess
          }
          onClick={() => runId && answer.mutate({ runId, rulings })}
        >
          {answer.isPending ? 'Submitting...' : 'Submit ruling'}
        </Button>
        {answer.data ? (
          <div className="space-y-4">
            <p data-tone="success" className="text-status-text">
              {answer.data.outcome === 'resumed'
                ? `resumed as run ${answer.data.resumed_as}`
                : answer.data.outcome === 'delivered-live'
                  ? 'delivered to the live worker'
                  : 'recorded'}
            </p>
            {questions.map((question) => (
              <FileRulingControl key={question.id} question={question} />
            ))}
          </div>
        ) : null}
        {answer.error ? (
          <p data-tone="error" className="text-status-text">
            refused: {answer.error.message}
          </p>
        ) : null}
      </div>
    </section>
  )
}

function FileRulingControl({ question }: { question: OperatorWaitingItem }) {
  const [kind, setKind] = useState<'doc' | 'canon'>('doc')
  const file = useMutation(trpc.operator.file.mutationOptions())
  return (
    <div className="space-y-3 border border-border-default bg-surface-sunken p-4">
      <h3 className="font-medium text-sm">File this ruling</h3>
      <p className="text-text-muted text-sm">{question.question}</p>
      <RadioRows
        label="File as"
        value={kind}
        options={[
          { value: 'doc', label: 'Document' },
          { value: 'canon', label: 'Canon proposal' },
        ]}
        onChange={(value) => setKind(value === 'canon' ? 'canon' : 'doc')}
      />
      <Button
        variant="secondary"
        disabled={file.isPending || file.isSuccess}
        onClick={() => file.mutate({ questionId: question.id, as: kind })}
      >
        {file.isPending ? 'Filing...' : 'File this ruling'}
      </Button>
      {file.data ? (
        <p data-tone="success" className="text-status-text">
          filed as {file.data.filed_as} at {file.data.filed_ref}
        </p>
      ) : null}
      {file.error ? (
        <p data-tone="error" className="text-status-text">
          refused: {file.error.message}
        </p>
      ) : null}
    </div>
  )
}

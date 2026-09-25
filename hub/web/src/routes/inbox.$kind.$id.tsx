import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { waitingRunId } from '@/lib/operator-waiting'
import { queryClient, trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { Button } from '@/ui/button/button'
import { Textarea } from '@/ui/field/textarea'
import { DisplayRow } from '@/ui/form-layout/form-layout'
import { PageHeader } from '@/ui/page-header/page-header'
import { Segmented } from '@/ui/segmented/segmented'
import type { OperatorWaitingItem } from '../../../src/orch.ts'

export const Route = createFileRoute('/inbox/$kind/$id')({ component: InboxDetailPage })

function InboxDetailPage() {
  const { kind, id } = Route.useParams()
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
  if (!item)
    return (
      <section>
        <PageHeader
          title="No longer waiting"
          subtitle="This item may already have been answered."
        />
        <Link to="/inbox">Return to the inbox</Link>
      </section>
    )
  return item.kind === 'workflow' ? <WorkflowRuling item={item} /> : <QuestionRuling item={item} />
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

function QuestionRuling({ item }: { item: OperatorWaitingItem }) {
  const recommended = item.recommendation ?? item.options[0] ?? ''
  const [choice, setChoice] = useState(recommended)
  const [freeText, setFreeText] = useState('')
  useEffect(() => setChoice(recommended), [recommended])
  const answer = useMutation({
    ...trpc.operator.answer.mutationOptions(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: trpc.operator.waiting.queryKey() })
    },
  })
  const runId = waitingRunId(item)
  const ruling = freeText.trim() || choice
  return (
    <section className="max-w-3xl">
      <PageHeader
        title="Operator question"
        subtitle={`${item.project}${item.task_key ? ` · ${item.task_key}` : ''}`}
      />
      <div className="space-y-6 border border-border-default bg-surface-raised p-6">
        <div>
          <Badge tone="warning">waiting on you</Badge>
          <h2 className="mt-3 font-mono text-xl">{item.question}</h2>
        </div>
        {item.why ? <DisplayRow label="Why" value={item.why} /> : null}
        {item.options.length ? (
          <Segmented
            label="Ruling"
            size="md"
            value={choice}
            options={item.options.map((option) => ({
              value: option,
              label: option === item.recommendation ? `${option} (recommended)` : option,
            }))}
            onChange={(value) => {
              setChoice(value)
              setFreeText('')
            }}
          />
        ) : null}
        <div>
          <label htmlFor="custom-ruling" className="mb-2 block font-medium text-sm">
            Free-text ruling
          </label>
          <Textarea
            id="custom-ruling"
            value={freeText}
            placeholder="Write a different ruling"
            onChange={(event) => setFreeText(event.target.value)}
          />
        </div>
        <Button
          variant="primary"
          disabled={!runId || !ruling || answer.isPending || answer.isSuccess}
          onClick={() => runId && answer.mutate({ runId, questionId: item.id, ruling })}
        >
          {answer.isPending ? 'Submitting...' : 'Submit ruling'}
        </Button>
        {answer.data ? (
          <p data-tone="success" className="text-status-text">
            {answer.data.outcome}: {answer.data.message}
          </p>
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

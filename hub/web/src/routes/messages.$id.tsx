import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { isHostedMode } from '@/lib/hub-mode'
import { HostedMessagesPage, originText } from '@/routes/messages'
import { queryClient, trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { Button } from '@/ui/button/button'
import { Companion } from '@/ui/companion/companion'
import { Dialog } from '@/ui/dialog/dialog'
import { Textarea } from '@/ui/field/textarea'
import { DisplayRow, FieldSection } from '@/ui/form-layout/form-layout'

type Origin = Parameters<typeof originText>[0]
type Message = {
  id: string
  kind: string | null
  title: string | null
  body: string | null
  audience: string | null
  origin: Origin | null
  senderTags: { kind: 'task' | 'path' | 'topic'; value: string }[] | null
  createdAt: string | null
  expiresAt: string | null
  state: string | null
  acceptedReplyId: string | null
  ackRequired: boolean | null
}
type Reply = { id: string; body: string; origin: Origin; createdAt: string }
type Receipt = {
  readerSession: string
  deliveredAt: string | null
  acknowledgedAt: string | null
}

export const Route = createFileRoute('/messages/$id')({ component: MessageDetailRoute })

function timestamp(value: string | null) {
  return value ? new Date(value).toLocaleString() : '-'
}

function MessageDetailRoute() {
  if (isHostedMode()) return <HostedMessagesPage />
  return <LocalMessageDetail />
}

function LocalMessageDetail() {
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const thread = useQuery(trpc.board.thread.queryOptions({ id }))
  const status = useQuery(trpc.board.status.queryOptions({ id }))
  const [replyBody, setReplyBody] = useState('')
  const [withdrawing, setWithdrawing] = useState(false)
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.board.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.board.thread.queryKey({ id }) }),
      queryClient.invalidateQueries({ queryKey: trpc.board.status.queryKey({ id }) }),
    ])
  }
  const reply = useMutation(trpc.board.reply.mutationOptions({ onSuccess: invalidate }))
  const accept = useMutation(trpc.board.accept.mutationOptions({ onSuccess: invalidate }))
  const withdraw = useMutation(
    trpc.board.withdraw.mutationOptions({
      onSuccess: async () => {
        setWithdrawing(false)
        await invalidate()
      },
    }),
  )
  const close = () => void navigate({ to: '/messages', resetScroll: false })
  const error = thread.error ?? status.error
  if (thread.isPending || status.isPending) {
    return (
      <Companion onClose={close} title="Message" subtitle="Loading message...">
        <p className="text-text-muted">Loading...</p>
      </Companion>
    )
  }
  if (error) {
    return (
      <Companion onClose={close} title="Message">
        <p data-tone="error" className="text-status-text">
          Could not load this message. {error.message}
        </p>
      </Companion>
    )
  }
  const root = thread.data?.root as Message | undefined
  if (!root) return null
  const replies = (thread.data?.replies ?? []) as Reply[]
  const receipts = (status.data?.receipts ?? []) as Receipt[]
  const actionError = reply.error ?? accept.error ?? withdraw.error
  const tags = root.senderTags?.map((tag) => `${tag.kind}:${tag.value}`).join(', ') || '-'
  return (
    <Companion
      onClose={close}
      title={root.title ?? `Message ${id}`}
      subtitle={`${root.kind ?? 'message'} · ${root.audience ?? 'unknown audience'}`}
      actions={
        root.state ? (
          <Badge tone={root.state === 'open' ? 'progress' : 'neutral'}>{root.state}</Badge>
        ) : null
      }
      footer={
        root.state === 'open' ? (
          <Button
            variant="danger"
            disabled={withdraw.isPending}
            onClick={() => setWithdrawing(true)}
          >
            Withdraw
          </Button>
        ) : undefined
      }
    >
      <DisplayRow label="From" value={root.origin ? originText(root.origin) : '-'} />
      <DisplayRow label="Audience" value={root.audience} />
      <DisplayRow label="Sender tags" value={tags} />
      <DisplayRow label="Created" value={timestamp(root.createdAt)} />
      <DisplayRow label="Expires" value={root.expiresAt ? timestamp(root.expiresAt) : 'Never'} />
      <DisplayRow label="State" value={root.state} />
      <FieldSection title="Message">
        <blockquote className="border-border-strong border-l-2 pl-3">
          <pre className="whitespace-pre-wrap font-sans">{root.body ?? ''}</pre>
        </blockquote>
      </FieldSection>
      <FieldSection title="Receipts">
        {receipts.length ? (
          <ul className="grid gap-2">
            {receipts.map((receipt) => (
              <li key={receipt.readerSession}>
                <strong>{receipt.readerSession}</strong> · delivered{' '}
                {timestamp(receipt.deliveredAt)} · acknowledged {timestamp(receipt.acknowledgedAt)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-text-muted">This message reached no session.</p>
        )}
        {root.kind === 'notice' && root.ackRequired && status.data?.unacknowledged?.length ? (
          <p>
            <strong>Not acknowledged:</strong> {status.data.unacknowledged.join(', ')}
          </p>
        ) : null}
      </FieldSection>
      <FieldSection title="Replies">
        {replies.length ? (
          <ol className="grid gap-4">
            {replies.map((item) => (
              <li key={item.id} className="border-border-subtle border-b pb-4 last:border-b-0">
                <p className="text-sm text-text-muted">
                  {originText(item.origin)} · {timestamp(item.createdAt)}
                </p>
                <blockquote className="mt-2 border-border-strong border-l-2 pl-3">
                  <pre className="whitespace-pre-wrap font-sans">{item.body}</pre>
                </blockquote>
                {root.kind === 'question' && !root.acceptedReplyId ? (
                  <Button
                    className="mt-3"
                    size="sm"
                    disabled={accept.isPending}
                    onClick={() => accept.mutate({ questionId: id, replyId: item.id })}
                  >
                    Accept this answer
                  </Button>
                ) : root.acceptedReplyId === item.id ? (
                  <Badge tone="success">Accepted answer</Badge>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-text-muted">No replies yet.</p>
        )}
        {root.kind === 'question' ? (
          <div className="grid gap-2">
            <Textarea
              aria-label="Reply"
              placeholder="Write a reply"
              value={replyBody}
              onChange={(event) => setReplyBody(event.target.value)}
            />
            <Button
              className="justify-self-start"
              variant="primary"
              disabled={reply.isPending || !replyBody.trim()}
              onClick={() => reply.mutate({ id, body: replyBody })}
            >
              {reply.isPending ? 'Replying...' : 'Reply'}
            </Button>
          </div>
        ) : null}
      </FieldSection>
      {actionError ? (
        <p data-tone="error" className="mt-3 text-status-text">
          {actionError.message}
        </p>
      ) : null}
      <Dialog
        open={withdrawing}
        onOpenChange={setWithdrawing}
        title="Withdraw message?"
        description="It will no longer be open for action."
        footer={
          <>
            <Button onClick={() => setWithdrawing(false)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={withdraw.isPending}
              onClick={() => withdraw.mutate({ id })}
            >
              {withdraw.isPending ? 'Withdrawing...' : 'Withdraw'}
            </Button>
          </>
        }
      />
    </Companion>
  )
}

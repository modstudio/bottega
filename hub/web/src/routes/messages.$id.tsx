import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { inferRouterOutputs } from '@trpc/server'
import { useRef, useState } from 'react'
import { sendTimestamp } from '@/lib/format'
import { originText } from '@/routes/messages'
import { queryClient, trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { Button } from '@/ui/button/button'
import { Companion } from '@/ui/companion/companion'
import { Dialog } from '@/ui/dialog/dialog'
import { Textarea } from '@/ui/field/textarea'
import { DisplayRow, FieldSection } from '@/ui/form-layout/form-layout'
import type { AppRouter } from '../../../src/trpc/router.ts'

type BoardOutputs = inferRouterOutputs<AppRouter>['board']
type ThreadRoot = BoardOutputs['thread']['root']
type ThreadReply = BoardOutputs['thread']['replies'][number]
type StatusReceipt = BoardOutputs['status']['receipts'][number]

export function MessageReceipts({
  receipts,
  reached,
  unacknowledged,
}: {
  receipts: StatusReceipt[]
  reached: number | null
  unacknowledged: string[]
}) {
  return (
    <FieldSection title="Receipts">
      {receipts.length ? (
        <ul className="grid gap-2">
          {receipts.map((receipt) => (
            <li key={receipt.readerSession}>
              <strong>{receipt.readerSession}</strong> · delivered{' '}
              {receipt.deliveredAt ? sendTimestamp(receipt.deliveredAt) : '-'} · acknowledged{' '}
              {receipt.acknowledgedAt ? sendTimestamp(receipt.acknowledgedAt) : '-'}
            </li>
          ))}
        </ul>
      ) : reached === null ? (
        <p className="text-text-muted">Receipts are visible to the message's author only.</p>
      ) : (
        <p className="text-text-muted">This message reached no session.</p>
      )}
      {unacknowledged.length ? (
        <p>
          <strong>Not acknowledged:</strong> {unacknowledged.join(', ')}
        </p>
      ) : null}
    </FieldSection>
  )
}

function MessageReplies({
  root,
  replies,
  replyBody,
  replyPending,
  acceptPending,
  onReplyBody,
  onReply,
  onAccept,
}: {
  root: ThreadRoot
  replies: ThreadReply[]
  replyBody: string
  replyPending: boolean
  acceptPending: boolean
  onReplyBody: (value: string) => void
  onReply: () => void
  onAccept: (replyId: string) => void
}) {
  return (
    <FieldSection title="Replies">
      {replies.length ? (
        <ol className="grid gap-4">
          {replies.map((item) => (
            <li key={item.id} className="border-border-subtle border-b pb-4 last:border-b-0">
              <p className="text-sm text-text-muted">
                {originText(item.origin)} · {sendTimestamp(item.createdAt)}
              </p>
              <blockquote className="mt-2 border-border-strong border-l-2 pl-3">
                <pre className="whitespace-pre-wrap font-sans">{item.body}</pre>
              </blockquote>
              {root.kind === 'question' && !root.acceptedReplyId ? (
                <Button
                  className="mt-3"
                  size="sm"
                  disabled={acceptPending}
                  onClick={() => onAccept(item.id)}
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
            onChange={(event) => onReplyBody(event.target.value)}
          />
          <Button
            className="justify-self-start"
            variant="primary"
            disabled={replyPending || !replyBody.trim()}
            onClick={onReply}
          >
            {replyPending ? 'Replying...' : 'Reply'}
          </Button>
        </div>
      ) : null}
    </FieldSection>
  )
}

export const Route = createFileRoute('/messages/$id')({ component: MessageDetailRoute })

function MessageDetailRoute() {
  return <LocalMessageDetail />
}

function LocalMessageDetail() {
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const thread = useQuery(trpc.board.thread.queryOptions({ id }))
  const status = useQuery(trpc.board.status.queryOptions({ id }))
  const [replyBody, setReplyBody] = useState('')
  const [withdrawing, setWithdrawing] = useState(false)
  const [acceptedNotePendingError, setAcceptedNotePendingError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<{
    action: 'reply' | 'accept' | 'withdraw'
    message: string
  } | null>(null)
  const actionSequence = useRef(0)
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.board.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.board.thread.queryKey({ id }) }),
      queryClient.invalidateQueries({ queryKey: trpc.board.status.queryKey({ id }) }),
    ])
  }
  const reply = useMutation(
    trpc.board.reply.mutationOptions({
      onSuccess: async () => {
        setReplyBody('')
        await invalidate()
      },
    }),
  )
  const accept = useMutation(
    trpc.board.accept.mutationOptions({
      onSuccess: async (result) => {
        setAcceptedNotePendingError(result.notePendingError)
        await invalidate()
      },
    }),
  )
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
  const root = thread.data?.root
  if (!root) return null
  const replies = thread.data?.replies ?? []
  const receipts = status.data?.receipts ?? []
  const runAction = (
    action: 'reply' | 'accept' | 'withdraw',
    mutate: (onError: (error: { message: string }) => void) => void,
  ) => {
    const sequence = ++actionSequence.current
    setActionError(null)
    mutate((error) => {
      if (sequence === actionSequence.current) setActionError({ action, message: error.message })
    })
  }
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
      <DisplayRow label="Created" value={root.createdAt ? sendTimestamp(root.createdAt) : '-'} />
      <DisplayRow
        label="Expires"
        value={root.expiresAt ? sendTimestamp(root.expiresAt) : 'Never'}
      />
      <DisplayRow label="State" value={root.state} />
      <FieldSection title="Message">
        <blockquote className="border-border-strong border-l-2 pl-3">
          <pre className="whitespace-pre-wrap font-sans">{root.body ?? ''}</pre>
        </blockquote>
      </FieldSection>
      <MessageReceipts
        receipts={receipts}
        reached={status.data?.reached ?? null}
        unacknowledged={status.data?.unacknowledged ?? []}
      />
      <MessageReplies
        root={root}
        replies={replies}
        replyBody={replyBody}
        replyPending={reply.isPending}
        acceptPending={accept.isPending}
        onReplyBody={setReplyBody}
        onReply={() =>
          runAction('reply', (onError) => reply.mutate({ id, body: replyBody }, { onError }))
        }
        onAccept={(replyId) =>
          runAction('accept', (onError) => accept.mutate({ questionId: id, replyId }, { onError }))
        }
      />
      {acceptedNotePendingError ? (
        <p data-tone="warning" className="mt-3 text-status-text">
          The answer is accepted and its note has not been filed yet:{' '}
          <q>{acceptedNotePendingError}</q>
        </p>
      ) : null}
      {actionError && actionError.action !== 'withdraw' ? (
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
              onClick={() =>
                runAction('withdraw', (onError) => withdraw.mutate({ id }, { onError }))
              }
            >
              {withdraw.isPending ? 'Withdrawing...' : 'Withdraw'}
            </Button>
          </>
        }
      >
        {actionError?.action === 'withdraw' ? (
          <p data-tone="error" className="text-status-text">
            {actionError.message}
          </p>
        ) : null}
      </Dialog>
    </Companion>
  )
}

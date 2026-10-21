import { Button } from '@bottega/hub-ui/button'
import { Menu } from '@bottega/hub-ui/menu'
import { MoreHorizontal, Pencil, Reply, Trash } from 'lucide-react'
import { useState } from 'react'
import { EditorBody } from '../document-editor/document-editor.tsx'
import { Markdown } from '../markdown/markdown.tsx'
import { historyCommentStyles } from './history-comment.styles.ts'
import type { HistoryAction } from './history-model.ts'

export type HistoryCommentProps = {
  id: string
  at: string
  body: string
  /** The agent that wrote it for the author, if one did. */
  agent?: string | null
  /** Whether this reader may change this comment; the screen's data decides. */
  canEdit?: boolean
  canDelete?: boolean
  time: string
  editing: boolean
  onReply?: () => void
  onEditStart: () => void
  onEditEnd: () => void
  edit?: HistoryAction<{ id: string; body: string }>
  /** Runs a confirmed delete of this comment; absent when the reader may not delete. */
  onDelete?: () => void
  deleting?: boolean
  /** The last delete's failure, when it was this comment's. */
  deleteError?: string | null
}

type Action = { label: string; icon: typeof Reply; danger?: boolean; onSelect: () => void }

function Actions({ actions }: { actions: Action[] }) {
  if (!actions.length) return null
  return (
    <span className={historyCommentStyles().actions()}>
      <span className={historyCommentStyles().inline()}>
        {actions.map(({ label, icon: Icon, onSelect }) => (
          <button
            key={label}
            type="button"
            className={historyCommentStyles().action()}
            onClick={onSelect}
          >
            <Icon size={13} aria-hidden />
            {label}
          </button>
        ))}
      </span>
      <span className={historyCommentStyles().compact()}>
        <Menu
          side="bottom"
          align="end"
          items={actions}
          trigger={
            <button
              type="button"
              className={historyCommentStyles().more()}
              aria-label="Comment actions"
            >
              <MoreHorizontal size={14} aria-hidden />
            </button>
          }
        />
      </span>
    </span>
  )
}

function Editor({
  props,
}: {
  props: HistoryCommentProps & { edit: NonNullable<HistoryCommentProps['edit']> }
}) {
  const { id, body, edit, onEditEnd } = props
  const [draft, setDraft] = useState(body)
  const [mode, setMode] = useState<'rich' | 'markdown'>('rich')
  const changed = draft.trim() && draft !== body
  const save = async () => {
    if (!changed || edit.pending) return
    await edit.run({ id, body: draft })
    onEditEnd()
  }
  return (
    <>
      <div className={historyCommentStyles().editor()}>
        <EditorBody
          value={draft}
          onChange={setDraft}
          mode={mode}
          onModeChange={setMode}
          onSaveShortcut={() => void save()}
          bodyLabel="Comment"
        />
      </div>
      {edit.error ? <p className={historyCommentStyles().error()}>{edit.error}</p> : null}
      <div className={historyCommentStyles().editActions()}>
        <Button size="sm" variant="ghost" onClick={onEditEnd}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!changed || edit.pending}
          onClick={() => void save()}
        >
          {edit.pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </>
  )
}

/** One comment in the history feed: a head with its actions and time, then its prose. */
export function HistoryComment(props: HistoryCommentProps) {
  const { at, body, agent, canEdit, canDelete, time, editing, onReply, onEditStart, edit } = props
  const { onDelete, deleting, deleteError } = props
  const [confirming, setConfirming] = useState(false)
  const actions: Action[] = [
    ...(onReply ? [{ label: 'Reply', icon: Reply, onSelect: onReply }] : []),
    ...(canEdit && edit && !edit.refused
      ? [{ label: 'Edit', icon: Pencil, onSelect: onEditStart }]
      : []),
    ...(canDelete && onDelete
      ? [{ label: 'Delete', icon: Trash, danger: true, onSelect: () => setConfirming(true) }]
      : []),
  ]
  return (
    <div className={historyCommentStyles().root()}>
      <div className={historyCommentStyles().head()}>
        <span className={historyCommentStyles().kind()}>
          Comment
          {agent ? <span className={historyCommentStyles().agent()}> · {agent}</span> : null}
        </span>
        {confirming ? (
          <span className={historyCommentStyles().confirm()}>
            Delete this comment?
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={deleting}
              onClick={() => {
                setConfirming(false)
                onDelete?.()
              }}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </span>
        ) : editing ? null : (
          <Actions actions={actions} />
        )}
        <time className={historyCommentStyles().time()} dateTime={at}>
          {time}
        </time>
      </div>
      <div className={historyCommentStyles().body()}>
        {editing && edit ? <Editor props={{ ...props, edit }} /> : <Markdown content={body} />}
      </div>
      {deleteError ? <p className={historyCommentStyles().error()}>{deleteError}</p> : null}
    </div>
  )
}

import type { Editor } from '@tiptap/core'
import {
  Bold,
  Code,
  Columns2,
  Columns3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  Rows2,
  Rows3,
  SquareCode,
  Table,
  Trash2,
} from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { IconButton } from '@bottega/hub-ui/button'
import { Input } from '@bottega/hub-ui/field/input'
import { Select } from '@bottega/hub-ui/listbox/select'
import { Popover } from '@bottega/hub-ui/popover'

const BLOCKS = [
  { value: 'paragraph', label: 'Paragraph' },
  { value: '2', label: 'Heading 2' },
  { value: '3', label: 'Heading 3' },
  { value: '4', label: 'Heading 4' },
] as const

function currentBlock(editor: Editor): string {
  if (editor.isActive('heading', { level: 2 })) return '2'
  if (editor.isActive('heading', { level: 3 })) return '3'
  if (editor.isActive('heading', { level: 4 })) return '4'
  return 'paragraph'
}

function setBlock(editor: Editor, value: string) {
  if (value === 'paragraph') {
    editor.chain().focus().setParagraph().run()
    return
  }
  const level = Number(value)
  if (level === 2 || level === 3 || level === 4) {
    editor.chain().focus().setHeading({ level }).run()
  }
}

function MarkButton({
  editor,
  mark,
  label,
  icon: Icon,
  run,
}: {
  editor: Editor
  mark: string
  label: string
  icon: typeof Bold
  run: () => void
}) {
  return (
    <IconButton
      size="sm"
      variant={editor.isActive(mark) ? 'secondary' : 'ghost'}
      label={label}
      onClick={run}
    >
      <Icon />
    </IconButton>
  )
}

function LinkControl({ editor }: { editor: Editor }) {
  const [href, setHref] = useState('')
  const active = editor.isActive('link')
  return (
    <Popover
      label="Link"
      trigger={
        <IconButton size="sm" variant={active ? 'secondary' : 'ghost'} label="Link">
          <LinkIcon />
        </IconButton>
      }
      onOpenChange={(open) => {
        if (!open) return
        const attrs = editor.getAttributes('link')
        setHref(typeof attrs.href === 'string' ? attrs.href : '')
      }}
    >
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          const next = href.trim()
          if (!next) editor.chain().focus().unsetLink().run()
          else editor.chain().focus().setLink({ href: next }).run()
        }}
      >
        <label htmlFor="doc-edit-link" className="grid gap-1 text-sm">
          <span className="text-text-muted">URL or article slug</span>
          <Input
            id="doc-edit-link"
            value={href}
            onChange={(event) => setHref(event.target.value)}
          />
        </label>
      </form>
    </Popover>
  )
}

function insertThreeByThree(editor: Editor) {
  editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
}

function TableControls({ editor }: { editor: Editor }) {
  if (!editor.isActive('table')) {
    return (
      <IconButton
        size="sm"
        variant="ghost"
        label="Table"
        onClick={() => insertThreeByThree(editor)}
      >
        <Table />
      </IconButton>
    )
  }
  return (
    <>
      <IconButton
        size="sm"
        variant="ghost"
        label="Add row"
        onClick={() => editor.chain().focus().addRowAfter().run()}
      >
        <Rows3 />
      </IconButton>
      <IconButton
        size="sm"
        variant="ghost"
        label="Remove row"
        onClick={() => editor.chain().focus().deleteRow().run()}
      >
        <Rows2 />
      </IconButton>
      <IconButton
        size="sm"
        variant="ghost"
        label="Add column"
        onClick={() => editor.chain().focus().addColumnAfter().run()}
      >
        <Columns3 />
      </IconButton>
      <IconButton
        size="sm"
        variant="ghost"
        label="Remove column"
        onClick={() => editor.chain().focus().deleteColumn().run()}
      >
        <Columns2 />
      </IconButton>
      <IconButton
        size="sm"
        variant="ghost"
        label="Delete table"
        onClick={() => editor.chain().focus().deleteTable().run()}
      >
        <Trash2 />
      </IconButton>
    </>
  )
}

function useEditorTick(editor: Editor) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const update = () => setTick((tick) => tick + 1)
    editor.on('selectionUpdate', update)
    editor.on('transaction', update)
    return () => {
      editor.off('selectionUpdate', update)
      editor.off('transaction', update)
    }
  }, [editor])
}

export function RichToolbar({ editor }: { editor: Editor }) {
  useEditorTick(editor)
  return (
    <div className="flex h-control-sm min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden">
      {/* The toolbar row is tight: the block menu takes less than a select's usual minimum. */}
      <div className="shrink-0 [&>button]:min-w-28">
        <Select
          size="sm"
          label="Block type"
          value={currentBlock(editor)}
          options={[...BLOCKS]}
          onChange={(value) => setBlock(editor, value)}
        />
      </div>
      <MarkButton
        editor={editor}
        mark="bold"
        label="Bold"
        icon={Bold}
        run={() => editor.chain().focus().toggleBold().run()}
      />
      <MarkButton
        editor={editor}
        mark="italic"
        label="Italic"
        icon={Italic}
        run={() => editor.chain().focus().toggleItalic().run()}
      />
      <MarkButton
        editor={editor}
        mark="code"
        label="Inline code"
        icon={Code}
        run={() => editor.chain().focus().toggleCode().run()}
      />
      <MarkButton
        editor={editor}
        mark="bulletList"
        label="Bulleted list"
        icon={List}
        run={() => editor.chain().focus().toggleBulletList().run()}
      />
      <MarkButton
        editor={editor}
        mark="orderedList"
        label="Numbered list"
        icon={ListOrdered}
        run={() => editor.chain().focus().toggleOrderedList().run()}
      />
      <MarkButton
        editor={editor}
        mark="blockquote"
        label="Quote"
        icon={Quote}
        run={() => editor.chain().focus().toggleBlockquote().run()}
      />
      <LinkControl editor={editor} />
      <MarkButton
        editor={editor}
        mark="codeBlock"
        label="Code block"
        icon={SquareCode}
        run={() => editor.chain().focus().toggleCodeBlock().run()}
      />
      <TableControls editor={editor} />
    </div>
  )
}

import { type AnyExtension, getSchema } from '@tiptap/core'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { MarkdownManager } from '@tiptap/markdown'
import type { Schema } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import { LockedBlock } from './rich-locked.ts'

/** Extensions shared by the rich editor and the block-preserving save manager. */
export function richExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      trailingNode: false,
      link: { openOnClick: false },
    }),
    TableKit,
    TaskList,
    TaskItem.configure({ nested: true }),
    LockedBlock,
  ]
}

let manager: MarkdownManager | undefined

/** One MarkdownManager so marked tokenizers are registered once. */
export function richMarkdownManager(): MarkdownManager {
  manager ??= new MarkdownManager({
    extensions: richExtensions(),
    markedOptions: { gfm: true },
  })
  return manager
}

let schema: Schema | undefined

/** The schema the editor builds from the shared extensions, with its attribute defaults. */
export function richSchema(): Schema {
  schema ??= getSchema(richExtensions())
  return schema
}

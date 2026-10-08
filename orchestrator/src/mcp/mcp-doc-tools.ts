import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { DOC_AUDIENCES, DOC_KINDS, DOC_STATUSES } from '../../../shared/docs.ts'
import { checkDoc, repoRootForDoc } from '../canon/canon.ts'
import { selectCanonWriteTree } from '../doc/doc-canon-tree.ts'
import {
  consumeDoc,
  getDoc,
  getDocRevision,
  listDocMetadata,
  listDocRevisions,
  removeDoc,
  setDoc,
  setDocStatus,
  signedInDocOwner,
} from '../doc/docs.ts'
import { decideMcpDocWrite } from './mcp-doc-write.ts'

const text = (value: unknown) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) },
  ],
})

function rethrowMcpDocWriteError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  const currentRevision = message.match(/current revision ([^;,\s]+)/)?.[1]
  if (!currentRevision || !message.includes('re-read with orch doc get and re-apply the edit')) {
    throw error
  }

  const withoutCliRemedy = message
    .replace(/; pass --expect [^\s]+/, '')
    .replace(/\nre-read with orch doc get and re-apply the edit/, '')
  throw new Error(
    `${withoutCliRemedy}; pass expected_revision ${currentRevision}; ` +
      're-read with get_doc and re-apply the edit',
  )
}

async function withMcpDocWriteRemedy<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    rethrowMcpDocWriteError(error)
  }
}

export function registerDocTools(server: McpServer): void {
  server.registerTool(
    'list_docs',
    {
      description: 'List operator document metadata without bodies. Use get_doc to fetch one body.',
      inputSchema: z.object({
        scope: z.string().optional().describe('Exact scope match.'),
        subject: z.string().nullable().optional().describe('Exact subject match.'),
        scopes: z.array(z.string()).optional().describe('Exact match against any of these scopes.'),
        match: z
          .string()
          .optional()
          .describe('Case-insensitive substring match on title, slug, or subject.'),
        body_match: z
          .string()
          .optional()
          .describe('Case-insensitive substring match on body; bodies stay omitted.'),
        updated_at_order: z
          .enum(['asc', 'desc'])
          .optional()
          .describe('Order by updated_at; omit for scope, subject, slug order.'),
        user: z.boolean().optional(),
        audience: z.enum(DOC_AUDIENCES).optional(),
        status: z.enum(DOC_STATUSES).optional(),
        kind: z.enum(DOC_KINDS).optional(),
      }),
    },
    async ({
      scope,
      subject,
      scopes,
      match,
      body_match,
      updated_at_order,
      user,
      audience,
      status,
      kind,
    }) => {
      if (user && subject !== undefined) throw new Error('user cannot be used with subject')
      const owner = user ? await signedInDocOwner() : null
      return text(
        listDocMetadata({
          scope: user ? 'canon' : scope,
          subject: user ? null : subject,
          scopes,
          match,
          bodyMatch: body_match,
          updatedAtOrder: updated_at_order,
          owner,
          audience,
          status,
          kind,
        }),
      )
    },
  )

  server.registerTool(
    'get_doc',
    {
      description: 'Get one operator document.',
      inputSchema: z.object({
        scope: z.string().optional(),
        subject: z.string().nullable().optional(),
        slug: z.string(),
        user: z.boolean().optional(),
      }),
    },
    async ({ scope, subject, slug, user }) => {
      if (user && subject !== undefined) throw new Error('user cannot be used with subject')
      if (!user && !scope) throw new Error('scope is required unless user is true')
      const resolvedScope = user ? 'canon' : scope!
      const doc = getDoc(
        resolvedScope,
        user ? null : (subject ?? null),
        slug,
        user ? await signedInDocOwner() : null,
      )
      if (!doc) throw new Error(`no ${scope} doc "${slug}"`)
      return text(doc)
    },
  )

  server.registerTool(
    'set_doc',
    {
      description: 'Create or replace an operator document.',
      inputSchema: z.object({
        scope: z.string(),
        subject: z.string().nullable().optional(),
        slug: z.string(),
        title: z.string(),
        body: z.string(),
        delivery: z.enum(['inject', 'demand']).optional(),
        audience: z.enum(DOC_AUDIENCES).optional(),
        parent: z.string().trim().min(1).nullable().optional(),
        position: z.number().int().optional(),
        featured: z.boolean().optional(),
        status: z.enum(DOC_STATUSES).optional(),
        kind: z.enum(DOC_KINDS).optional(),
        replacement: z.string().trim().min(1).nullable().optional(),
        force_inject: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            'Required justification when an injected document exceeds the write-time size threshold.',
          ),
        reason: z
          .string({ error: 'reason is required: explain why this operator doc is changing' })
          .trim()
          .min(1, 'reason is required: explain why this operator doc is changing'),
        author: z.string().trim().min(1).optional(),
        expected_revision: z.string().trim().min(1).optional(),
        cwd: z.string().trim().min(1).optional(),
      }),
    },
    async ({
      scope,
      subject,
      slug,
      title,
      body,
      delivery,
      audience,
      parent,
      position,
      featured,
      status,
      kind,
      replacement,
      force_inject,
      reason,
      author,
      expected_revision,
      cwd,
    }) => {
      const refusal = decideMcpDocWrite('set_doc', scope)
      if (refusal) throw new Error(refusal)
      const canonTree = selectCanonWriteTree({ scope, subject: subject ?? null, cwd })
      const doc = await withMcpDocWriteRemedy(() =>
        setDoc({
          scope,
          subject: subject ?? null,
          slug,
          title,
          body,
          delivery,
          audience,
          parentSlug: parent,
          position,
          featured,
          status,
          kind,
          replacementSlug: replacement,
          forceInject: force_inject,
          reason,
          author,
          expectedRevision: expected_revision,
          canonTree,
        }),
      )
      const root = repoRootForDoc(doc, canonTree?.root)
      return text({
        ...doc,
        warnings: root ? checkDoc(body, { repoRoot: root }) : [],
        tree: canonTree?.root,
      })
    },
  )

  server.registerTool(
    'set_doc_status',
    {
      description: 'Change an existing document status without rewriting its body.',
      inputSchema: z.object({
        scope: z.string(),
        subject: z.string().nullable().optional(),
        slug: z.string(),
        status: z.enum(DOC_STATUSES),
        replacement: z.string().trim().min(1).nullable().optional(),
        reason: z.string().trim().min(1),
        author: z.string().trim().min(1).optional(),
        expected_revision: z.string().trim().min(1).optional(),
      }),
    },
    async ({ scope, subject, slug, status, replacement, reason, author, expected_revision }) => {
      const refusal = decideMcpDocWrite('set_doc', scope)
      if (refusal) throw new Error(refusal)
      return text(
        await withMcpDocWriteRemedy(() =>
          setDocStatus(scope, subject ?? null, slug, status, replacement, {
            reason,
            author,
            expectedRevision: expected_revision,
          }),
        ),
      )
    },
  )

  server.registerTool(
    'remove_doc',
    {
      description: 'Remove an operator document.',
      inputSchema: z.object({
        scope: z.string(),
        subject: z.string().nullable().optional(),
        slug: z.string(),
        reason: z
          .string({ error: 'reason is required: explain why this operator doc is being removed' })
          .trim()
          .min(1, 'reason is required: explain why this operator doc is being removed'),
        author: z.string().trim().min(1).optional(),
        expected_revision: z.string().trim().min(1).optional(),
        cwd: z.string().trim().min(1).optional(),
      }),
    },
    async ({ scope, subject, slug, reason, author, expected_revision, cwd }) => {
      const refusal = decideMcpDocWrite('remove_doc', scope)
      if (refusal) throw new Error(refusal)
      const canonTree = selectCanonWriteTree({ scope, subject: subject ?? null, cwd })
      const removed = await withMcpDocWriteRemedy(() =>
        removeDoc(scope, subject ?? null, slug, {
          reason,
          author,
          expectedRevision: expected_revision,
          canonTree,
        }),
      )
      return text({ removed, tree: canonTree?.root })
    },
  )

  server.registerTool(
    'consume_doc',
    {
      description:
        'Mark an operator document consumed by rewriting its YAML status/stamps and updated_at.',
      inputSchema: z.object({
        scope: z.string(),
        subject: z.string().nullable().optional(),
        slug: z.string(),
      }),
    },
    async ({ scope, subject, slug }) => {
      const refusal = decideMcpDocWrite('consume_doc', scope)
      if (refusal) throw new Error(refusal)
      return text(await consumeDoc(scope, subject ?? null, slug, { reason: 'consumed by session' }))
    },
  )

  server.registerTool(
    'list_doc_revisions',
    {
      description:
        'List revision metadata for one operator document, newest first; bodies are omitted.',
      inputSchema: z.object({
        scope: z.string().optional(),
        subject: z.string().nullable().optional(),
        slug: z.string(),
        user: z.boolean().optional(),
      }),
    },
    async ({ scope, subject, slug, user }) => {
      if (user && subject !== undefined) throw new Error('user cannot be used with subject')
      if (!user && !scope) throw new Error('scope is required unless user is true')
      return text(
        listDocRevisions(
          user ? 'canon' : scope!,
          user ? null : (subject ?? null),
          slug,
          user ? await signedInDocOwner() : null,
        ),
      )
    },
  )

  server.registerTool(
    'get_doc_revision',
    {
      description: 'Get one operator document revision, including its body.',
      inputSchema: z.object({ id: z.number().int().positive(), user: z.boolean().optional() }),
    },
    async ({ id, user }) => {
      const revision = getDocRevision(id, user ? await signedInDocOwner() : null)
      if (!revision) throw new Error(`no doc revision ${id}`)
      return text(revision)
    },
  )
}

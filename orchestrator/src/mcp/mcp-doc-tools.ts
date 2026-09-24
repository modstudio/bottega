import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { checkDoc, repoRootForDoc } from '../canon/canon.ts'
import {
  consumeDoc,
  getDoc,
  getDocRevision,
  listDocMetadata,
  listDocRevisions,
  setDoc,
  signedInDocOwner,
} from '../doc/docs.ts'
import { decideMcpDocWrite } from './mcp-doc-write.ts'

const text = (value: unknown) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) },
  ],
})

export function registerDocTools(server: McpServer): void {
  server.registerTool(
    'list_docs',
    {
      description: 'List operator document metadata without bodies. Use get_doc to fetch one body.',
      inputSchema: {
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
      },
    },
    async ({ scope, subject, scopes, match, body_match, updated_at_order, user }) => {
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
        }),
      )
    },
  )

  server.registerTool(
    'get_doc',
    {
      description: 'Get one operator document.',
      inputSchema: {
        scope: z.string().optional(),
        subject: z.string().nullable().optional(),
        slug: z.string(),
        user: z.boolean().optional(),
      },
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
      inputSchema: {
        scope: z.string(),
        subject: z.string().nullable().optional(),
        slug: z.string(),
        title: z.string(),
        body: z.string(),
        delivery: z.enum(['inject', 'demand']).optional(),
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
      },
    },
    async ({ scope, subject, slug, title, body, delivery, force_inject, reason, author }) => {
      const refusal = decideMcpDocWrite('set_doc', scope)
      if (refusal) throw new Error(refusal)
      const doc = await setDoc({
        scope,
        subject: subject ?? null,
        slug,
        title,
        body,
        delivery,
        forceInject: force_inject,
        reason,
        author,
      })
      const root = repoRootForDoc(doc)
      return text({ ...doc, warnings: root ? checkDoc(body, { repoRoot: root }) : [] })
    },
  )

  server.registerTool(
    'consume_doc',
    {
      description:
        'Mark an operator document consumed by rewriting its YAML status/stamps and updated_at.',
      inputSchema: {
        scope: z.string(),
        subject: z.string().nullable().optional(),
        slug: z.string(),
      },
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
      inputSchema: {
        scope: z.string().optional(),
        subject: z.string().nullable().optional(),
        slug: z.string(),
        user: z.boolean().optional(),
      },
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
      inputSchema: { id: z.number().int().positive(), user: z.boolean().optional() },
    },
    async ({ id, user }) => {
      const revision = getDocRevision(id, user ? await signedInDocOwner() : null)
      if (!revision) throw new Error(`no doc revision ${id}`)
      return text(revision)
    },
  )
}

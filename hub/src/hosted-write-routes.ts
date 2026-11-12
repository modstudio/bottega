// concern: hosted-write-routes
/** Owns the hosted write registry used by dispatch, identity, telemetry, and its guard. */

import { recordRequestNature } from '../../shared/record-space-request.ts'

export type HostedWriteRoute = {
  method: 'DELETE' | 'POST' | 'PUT'
  pattern: RegExp
  path: string
  example: string
  owner: 'changes' | 'tasks' | 'notes' | 'waiting-email' | 'reports'
  destination: 'required' | 'exempt'
  reason?: string
}

export const HOSTED_WRITE_ROUTES: readonly HostedWriteRoute[] = [
  {
    method: 'POST',
    pattern: /^\/v1\/tasks$/,
    path: '/v1/tasks',
    example: '/v1/tasks',
    owner: 'tasks',
    destination: 'required',
  },
  {
    method: 'POST',
    pattern: /^\/v1\/tasks\/[^/]+\/documents$/,
    path: '/v1/tasks/:key/documents',
    example: '/v1/tasks/DEV-1/documents',
    owner: 'tasks',
    destination: 'required',
  },
  {
    method: 'POST',
    pattern: /^\/v1\/tasks\/presence$/,
    path: '/v1/tasks/presence',
    example: '/v1/tasks/presence',
    owner: 'tasks',
    destination: 'required',
  },
  {
    method: 'DELETE',
    pattern: /^\/v1\/tasks$/,
    path: '/v1/tasks',
    example: '/v1/tasks',
    owner: 'tasks',
    destination: 'required',
  },
  {
    method: 'POST',
    pattern: /^\/v1\/notes$/,
    path: '/v1/notes',
    example: '/v1/notes',
    owner: 'notes',
    destination: 'required',
  },
  {
    method: 'POST',
    pattern: /^\/v1\/notes\/[0-9a-f-]{36}\/promote$/i,
    path: '/v1/notes/:id/promote',
    example: '/v1/notes/01990000-0000-7000-8000-000000000001/promote',
    owner: 'notes',
    destination: 'required',
  },
  {
    method: 'POST',
    pattern: /^\/v1\/notes\/reap$/,
    path: '/v1/notes/reap',
    example: '/v1/notes/reap',
    owner: 'notes',
    destination: 'required',
  },
  {
    method: 'PUT',
    pattern: /^\/v1\/notes\/mirror$/,
    path: '/v1/notes/mirror',
    example: '/v1/notes/mirror',
    owner: 'notes',
    destination: 'required',
  },
  {
    method: 'POST',
    pattern: /^\/v1\/notes\/outside$/,
    path: '/v1/notes/outside',
    example: '/v1/notes/outside',
    owner: 'notes',
    destination: 'exempt',
    reason: "user-scoped authentication precedes the project's intake-space resolution",
  },
  {
    method: 'POST',
    pattern: /^\/v1\/changes$/,
    path: '/v1/changes',
    example: '/v1/changes',
    owner: 'changes',
    destination: 'required',
  },
  {
    method: 'POST',
    pattern: /^\/v1\/sends$/,
    path: '/v1/sends',
    example: '/v1/sends',
    owner: 'reports',
    destination: 'required',
  },
  {
    method: 'PUT',
    pattern: /^\/v1\/sends\/mirror$/,
    path: '/v1/sends/mirror',
    example: '/v1/sends/mirror',
    owner: 'reports',
    destination: 'required',
  },
  {
    method: 'POST',
    pattern: /^\/v1\/report-subscriptions$/,
    path: '/v1/report-subscriptions',
    example: '/v1/report-subscriptions',
    owner: 'reports',
    destination: 'required',
  },
  {
    method: 'PUT',
    pattern: /^\/v1\/report-subscriptions\/[^/]+$/,
    path: '/v1/report-subscriptions/:id',
    example: '/v1/report-subscriptions/subscription',
    owner: 'reports',
    destination: 'required',
  },
  {
    method: 'DELETE',
    pattern: /^\/v1\/report-subscriptions\/[^/]+$/,
    path: '/v1/report-subscriptions/:id',
    example: '/v1/report-subscriptions/subscription',
    owner: 'reports',
    destination: 'required',
  },
  {
    method: 'POST',
    pattern: /^\/v1\/operator-waiting-emails$/,
    path: '/v1/operator-waiting-emails',
    example: '/v1/operator-waiting-emails',
    owner: 'waiting-email',
    destination: 'required',
  },
  {
    method: 'POST',
    pattern: /^\/v1\/report-unsubscribe\/[^/]+\/[^/]+$/,
    path: '/v1/report-unsubscribe/:space/:token',
    example: '/v1/report-unsubscribe/01990000-0000-7000-8000-000000000001/token',
    owner: 'reports',
    destination: 'exempt',
    reason: 'signed unsubscribe token names its recipient without user identity',
  },
  {
    method: 'POST',
    pattern: /^\/unsubscribe\/[^/]+\/[^/]+$/,
    path: '/unsubscribe/:space/:token',
    example: '/unsubscribe/01990000-0000-7000-8000-000000000001/token',
    owner: 'reports',
    destination: 'exempt',
    reason: 'signed unsubscribe token names its recipient without user identity',
  },
]

export function registeredHostedWriteRoute(
  method: string,
  pathname: string,
): HostedWriteRoute | undefined {
  const normalized = method.toUpperCase()
  return HOSTED_WRITE_ROUTES.find(
    (route) => route.method === normalized && route.pattern.test(pathname),
  )
}

export function isUnregisteredHostedWrite(method: string, pathname: string): boolean {
  if (recordRequestNature(method) === 'read') return false
  if (!pathname.startsWith('/v1/') && !pathname.startsWith('/unsubscribe/')) return false
  return registeredHostedWriteRoute(method, pathname) === undefined
}

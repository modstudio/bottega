import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { CURSOR_CREATE_REFUSAL, TASK_STATUSES, type TrackerProject } from '../../shared/trackers.ts'
import {
  documentsRefusal,
  GIT_WRITE_REFUSAL,
  TRACKER_BODY_WRITE_REFUSAL,
  TRACKER_COMMENT_WRITE_REFUSAL,
  TRACKER_STATUS_WRITE_REFUSAL,
  TRACKER_TITLE_WRITE_REFUSAL,
  trackerCapabilities,
  UNKNOWN_TRACKER_REFUSAL,
} from './tracker-capabilities.ts'

const project = (
  name: string,
  protocol?: 'workspace-mcp' | 'cursor-mcp' | 'array-mcp',
): TrackerProject => ({
  name,
  settings: protocol
    ? {
        tracker: {
          protocol,
          envPrefix: 'FIXTURE',
          team: 'team',
          projectId: 'project',
          states: { todo: 'backlog', done: 'done' },
        },
      }
    : {},
})

describe('tracker capabilities', () => {
  test('local records expose every hub write', () => {
    expect(trackerCapabilities({ source: 'local', project: project('workshop') })).toEqual({
      create: { allowed: true },
      setStatus: { allowed: true },
      setTitle: { allowed: true },
      setBody: { allowed: true },
      comment: { allowed: true },
      documents: { allowed: true },
      statusVocabulary: [...TASK_STATUSES],
      keyFormat: null,
    })
  })

  for (const protocol of ['workspace-mcp', 'cursor-mcp', 'array-mcp'] as const) {
    test(`${protocol} exposes only its evidenced create support`, () => {
      expect(
        trackerCapabilities({ source: 'mcp', project: project('external', protocol) }),
      ).toEqual({
        create: { allowed: true },
        setStatus: { allowed: false, reason: TRACKER_STATUS_WRITE_REFUSAL },
        setTitle: { allowed: false, reason: TRACKER_TITLE_WRITE_REFUSAL },
        setBody: { allowed: false, reason: TRACKER_BODY_WRITE_REFUSAL },
        comment: { allowed: false, reason: TRACKER_COMMENT_WRITE_REFUSAL },
        documents: { allowed: false, reason: documentsRefusal(protocol) },
        statusVocabulary: ['todo', 'done'],
        keyFormat: null,
      })
    })
  }

  test('cursor-mcp create capability refuses without projectId and names the remedy', () => {
    const missingProjectId = project('stopal', 'cursor-mcp')
    delete missingProjectId.settings.tracker!.projectId
    expect(trackerCapabilities({ source: 'mcp', project: missingProjectId }).create).toEqual({
      allowed: false,
      reason:
        `${CURSOR_CREATE_REFUSAL}; set it with: ` +
        `${PLATFORM_SLUG} project set stopal --settings '{"tracker":{"projectId":"…"}}'`,
    })
  })

  test('git and unknown provenance are read-only with their own exact reasons', () => {
    const git = trackerCapabilities({
      source: 'git',
      project: {
        name: 'old',
        settings: { keyPrefixes: ['OLD', 'LEG'], tracker: { protocol: 'array-mcp' } },
      },
    })
    expect(git.keyFormat).toBe('OLD-* | LEG-*')
    expect(git.setTitle).toEqual({ allowed: false, reason: GIT_WRITE_REFUSAL })
    for (const unknown of [
      trackerCapabilities({ source: 'mcp', project: null }),
      trackerCapabilities({ source: 'git', project: null }),
      trackerCapabilities({ source: 'git', project: project('protocol-less') }),
    ]) {
      expect(unknown.statusVocabulary).toBeNull()
      expect(unknown.keyFormat).toBeNull()
      expect(unknown.setTitle).toEqual({ allowed: false, reason: UNKNOWN_TRACKER_REFUSAL })
    }
  })
})

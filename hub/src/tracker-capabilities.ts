import {
  cursorProjectRefusal,
  TASK_STATUSES,
  type TrackerProject,
  type TrackerRowSource,
  workspaceTeamRefusal,
} from '../../shared/trackers.ts'

type Capability = { allowed: true } | { allowed: false; reason: string }
export type Capabilities = {
  create: Capability
  setStatus: Capability
  setTitle: Capability
  setBody: Capability
  comment: Capability
  documents: Capability
  statusVocabulary: string[] | null
  keyFormat: string | null
}

export const TRACKER_STATUS_WRITE_REFUSAL =
  'No adapter has proven a status write to this tracker; hub refuses to guess a payload.'
export const TRACKER_TITLE_WRITE_REFUSAL =
  'No adapter has proven a title write to this tracker; hub refuses to guess a payload.'
export const TRACKER_BODY_WRITE_REFUSAL =
  'No adapter has proven a task description write to this tracker; hub refuses to guess a payload.'
export const TRACKER_COMMENT_WRITE_REFUSAL =
  'No adapter has proven a comment write to this tracker; hub refuses to guess a payload.'
export const GIT_WRITE_REFUSAL = 'Derived from git history; there is no tracker to write to.'
export const UNKNOWN_TRACKER_REFUSAL =
  "This record's project is not registered on this machine (or declares no tracker protocol), so hub cannot establish what its tracker accepts."

const allow: Capability = { allowed: true }
const refuse = (reason: string): Capability => ({ allowed: false, reason })
export const documentsRefusal = (protocol: string): string =>
  `Documents are hub-native; this record lives in ${protocol} and carries none.`
const keyFormat = (project: TrackerProject | null): string | null => {
  const prefixes = project?.settings.keyPrefixes
  return Array.isArray(prefixes) && prefixes.length
    ? prefixes.map((prefix) => `${prefix}-*`).join(' | ')
    : null
}

/** Dashboard mutation facts for one served row. Unknown provenance stays readable and read-only. */
export function trackerCapabilities({
  source,
  project,
}: {
  source: TrackerRowSource
  project: TrackerProject | null
}): Capabilities {
  if (source === 'local') {
    return {
      create: allow,
      setStatus: allow,
      setTitle: allow,
      setBody: allow,
      comment: allow,
      documents: allow,
      statusVocabulary: [...TASK_STATUSES],
      keyFormat: keyFormat(project),
    }
  }
  const protocol = project?.settings.tracker?.protocol
  if (!project || !protocol) {
    return {
      create: refuse(UNKNOWN_TRACKER_REFUSAL),
      setStatus: refuse(UNKNOWN_TRACKER_REFUSAL),
      setTitle: refuse(UNKNOWN_TRACKER_REFUSAL),
      setBody: refuse(UNKNOWN_TRACKER_REFUSAL),
      comment: refuse(UNKNOWN_TRACKER_REFUSAL),
      documents: refuse(UNKNOWN_TRACKER_REFUSAL),
      statusVocabulary: null,
      keyFormat: null,
    }
  }
  if (source === 'git') {
    return {
      create: refuse(GIT_WRITE_REFUSAL),
      setStatus: refuse(GIT_WRITE_REFUSAL),
      setTitle: refuse(GIT_WRITE_REFUSAL),
      setBody: refuse(GIT_WRITE_REFUSAL),
      comment: refuse(GIT_WRITE_REFUSAL),
      documents: refuse(GIT_WRITE_REFUSAL),
      statusVocabulary: null,
      keyFormat: keyFormat(project),
    }
  }
  if (!['workspace-mcp', 'cursor-mcp', 'array-mcp'].includes(protocol)) {
    return {
      create: refuse(UNKNOWN_TRACKER_REFUSAL),
      setStatus: refuse(UNKNOWN_TRACKER_REFUSAL),
      setTitle: refuse(UNKNOWN_TRACKER_REFUSAL),
      setBody: refuse(UNKNOWN_TRACKER_REFUSAL),
      comment: refuse(UNKNOWN_TRACKER_REFUSAL),
      documents: refuse(UNKNOWN_TRACKER_REFUSAL),
      statusVocabulary: null,
      keyFormat: null,
    }
  }
  return {
    create:
      protocol === 'array-mcp' ||
      (protocol === 'workspace-mcp' && Boolean(project.settings.tracker?.team)) ||
      (protocol === 'cursor-mcp' && Boolean(project.settings.tracker?.projectId))
        ? allow
        : refuse(
            protocol === 'workspace-mcp'
              ? workspaceTeamRefusal(project)
              : cursorProjectRefusal(project),
          ),
    setStatus: refuse(TRACKER_STATUS_WRITE_REFUSAL),
    setTitle: refuse(TRACKER_TITLE_WRITE_REFUSAL),
    setBody: refuse(TRACKER_BODY_WRITE_REFUSAL),
    comment: refuse(TRACKER_COMMENT_WRITE_REFUSAL),
    documents: refuse(documentsRefusal(protocol)),
    statusVocabulary: project.settings.tracker?.states
      ? Object.keys(project.settings.tracker.states)
      : null,
    keyFormat: keyFormat(project),
  }
}

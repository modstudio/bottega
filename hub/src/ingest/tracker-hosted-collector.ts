import type { Database } from 'bun:sqlite'
import type { TrackerSource, TrackerTask } from '../../../shared/trackers.ts'
import { sendHostedChangesWithOutcomes } from '../hosted-change-sender.ts'
import { statusEventRowHostedChange, taskRowHostedChange } from '../outbox-row.ts'
import { collectorTaskShouldQueue } from '../task-hosted-row.ts'
import type { TaskRow } from '../task-row.ts'
import {
  type HostedTaskWriteOptions,
  hostedTaskChangeSendOptions,
} from '../task-write-destination.ts'
import { retireTrackerRowPlan, type TrackerTaskRowPlan } from './tracker-row-plan.ts'

type HostedPlanResult = { accepted: TrackerTaskRowPlan[]; rejected: string[] }

export async function sendTrackerPlans(
  plans: TrackerTaskRowPlan[],
  options?: HostedTaskWriteOptions,
): Promise<HostedPlanResult> {
  const changed = plans.filter(
    (plan) =>
      plan.stored?.source !== 'local' && collectorTaskShouldQueue('mcp', plan.row, plan.changed),
  )
  if (!changed.length) return { accepted: plans, rejected: [] }
  const sendOptions = hostedTaskChangeSendOptions(
    changed[0]!.row.key,
    changed[0]!.row.project,
    options,
  )
  const [taskOutcomes] = await sendHostedChangesWithOutcomes(
    [changed.map((plan) => taskRowHostedChange(plan.row))],
    sendOptions,
  )
  const acceptedTaskIds = new Set(
    taskOutcomes!.filter((outcome) => outcome.status !== 'rejected').map((outcome) => outcome.id),
  )
  const events = changed.filter(
    (plan) => acceptedTaskIds.has(plan.row.record_id) && plan.event !== null,
  )
  const acceptedEventIds = new Set<string>()
  const rejected = taskOutcomes!
    .filter((outcome) => outcome.status === 'rejected')
    .map((outcome) => `${outcome.id}: ${outcome.reason}`)
  if (events.length) {
    const [eventOutcomes] = await sendHostedChangesWithOutcomes(
      [events.map((plan) => statusEventRowHostedChange(plan.event!))],
      sendOptions,
    )
    for (const outcome of eventOutcomes!) {
      if (outcome.status === 'rejected') rejected.push(`${outcome.id}: ${outcome.reason}`)
      else acceptedEventIds.add(outcome.id)
    }
  }
  const accepted = plans.filter(
    (plan) =>
      !changed.includes(plan) ||
      (acceptedTaskIds.has(plan.row.record_id) &&
        (!plan.event || acceptedEventIds.has(plan.event.record_id))),
  )
  return { accepted, rejected }
}

type CollectorPorts = {
  conn: Database
  planTask(task: TrackerTask): TrackerTaskRowPlan
  applyPlans(plans: TrackerTaskRowPlan[]): void
  inScope(key: string): boolean
  prefix(key: string): string
}

function taskRowAsTrackerTask(row: TaskRow): TrackerTask {
  return {
    externalId: row.external_id,
    key: row.key,
    project: row.project,
    title: row.title ?? '',
    status: row.status ?? '',
    category: row.status_category ?? 'open',
    updatedAt: row.updated_at,
    assignee: row.assignee,
    parentKey: row.parent_key,
  }
}

function changedObservation(plan: TrackerTaskRowPlan, at: string) {
  return {
    task: plan.task,
    observation: {
      at,
      taskRecordId: plan.stored?.source === 'local' ? null : plan.row.record_id,
      taskKey: plan.row.key,
      event: plan.event
        ? {
            recordId: plan.event.record_id,
            fromCategory: plan.event.from_status,
            toCategory: plan.event.to_status,
          }
        : null,
      times: {
        openedAt: plan.row.opened_at,
        closedAt: plan.row.closed_at,
        firstSeen: plan.row.first_seen,
        lastSeen: plan.row.last_seen,
        updatedAt: plan.row.updated_at ?? at,
      },
      changed: plan.changed,
      ambiguousParentKeys: [],
      priorCategory: plan.stored?.status_category ?? null,
    },
  }
}

function deletionPlans(project: string, keys: Iterable<string>, at: string, ports: CollectorPorts) {
  const plans: TrackerTaskRowPlan[] = []
  for (const key of new Set(keys)) {
    if (!ports.inScope(key)) continue
    const row = ports.conn
      .query<TaskRow, [string, string]>(
        `SELECT * FROM task WHERE project=? AND key=? AND source='mcp'`,
      )
      .get(project, key)
    if (!row || row.status_category === 'dropped') continue
    const plan = ports.planTask({
      ...taskRowAsTrackerTask(row),
      status: 'deleted',
      category: 'dropped',
      updatedAt: at,
    })
    plan.row.opened_at = row.opened_at
    plan.row.closed_at = row.closed_at ?? at
    plans.push(plan)
  }
  return plans
}

function retirementPlans(
  source: TrackerSource,
  prefixes: readonly string[],
  at: string,
  ports: CollectorPorts,
) {
  if (!prefixes.length) return []
  const plans: TrackerTaskRowPlan[] = []
  const rows = ports.conn
    .query<TaskRow, [string]>(
      `SELECT * FROM task WHERE project=? AND source='mcp' AND retired_reason IS NULL`,
    )
    .all(source.project)
  for (const row of rows) {
    if (ports.inScope(row.key)) continue
    const reason =
      `out of scope: key prefix ${ports.prefix(row.key)} is not among ${source.project}'s declared key prefixes ` +
      prefixes.join(', ')
    const retired = retireTrackerRowPlan(row, at, reason)
    plans.push({
      task: taskRowAsTrackerTask(retired.row),
      stored: row,
      row: retired.row,
      changed: retired.changed,
      event: null,
    })
  }
  return plans
}

export async function applyHostedCollectorPass(input: {
  source: TrackerSource
  tasks: Iterable<TrackerTask>
  deletedKeys: Iterable<string>
  backfillTasks: TrackerTask[]
  prefixes: readonly string[]
  at: string
  options?: HostedTaskWriteOptions
  ports: CollectorPorts
}) {
  const regular = [...input.tasks]
    .filter((task) => input.ports.inScope(task.key))
    .map(input.ports.planTask)
  const deleted = deletionPlans(input.source.project, input.deletedKeys, input.at, input.ports)
  const retired = retirementPlans(input.source, input.prefixes, input.at, input.ports)
  const backfill = input.backfillTasks.map(input.ports.planTask)
  const plans = [...regular, ...deleted, ...retired, ...backfill]
  const sent = await sendTrackerPlans(plans, input.options)
  input.ports.applyPlans(sent.accepted)
  return {
    observations: regular.map((plan) => changedObservation(plan, input.at)),
    retired: retired.length,
    deletions: {
      dropped: deleted.length,
      activity: deleted.length > 0,
      changed: deleted.filter((plan) => plan.event).length,
    },
    backfill: {
      filled: backfill.length,
      activity: backfill.some((plan) => plan.changed),
      ambiguousParentKeys: [] as string[],
    },
    rejected: sent.rejected,
  }
}

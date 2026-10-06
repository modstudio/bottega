import { PLATFORM_NAME } from '../../../../shared/brand.ts'
import { RunShowcase } from './run-showcase'
import { Cards, Cta, PageHero, Section } from './shared'

export function BoardPage() {
  return (
    <main className="site-page">
      <PageHero
        crumb="Board"
        title="Every project on one board."
        muted="Whatever runs them."
        copy={`Each project keeps the tracker it already has — its own database, its own MCP server, its own conventions. ${PLATFORM_NAME} speaks to each one over MCP and aggregates the result: one board, one cost view, one place where a run is already attributed to the task that caused it.`}
        actions={[['/docs', 'Connect a project']]}
      />
      <Section title="In flight" intro="Three projects · four trackers · nine open">
        <RunShowcase />
      </Section>
      <Section
        eyebrow="Aggregation"
        title="One board without migrating anything"
        intro={`A project that already has a tracker does not need a second one. ${PLATFORM_NAME} reads and writes each project's own system over MCP, and keeps the register of which project owns what.`}
      >
        <Cards
          items={[
            {
              eyebrow: 'Register',
              title: 'Each project declares itself',
              text: 'Task-key prefix, landing branch, which concerns it keeps, and how to provision a worktree. The register is the authority — not a guess in a prompt.',
            },
            {
              eyebrow: 'Provider-agnostic',
              title: 'Whatever is behind it',
              text: `A project's own database, an app's task tables, a hosted issue tracker, or ${PLATFORM_NAME}'s native store. The board does not care which.`,
            },
            {
              eyebrow: 'Two directions',
              title: 'Read and write',
              text: 'Statuses, comments and new tasks go back to the system of record. The aggregate view never becomes a second source of truth.',
            },
            {
              eyebrow: 'Attribution',
              title: 'Cost per change, per project',
              text: 'Runs, tokens and time roll up to the task and to the project, so you can see what a feature cost and where the spend concentrated.',
            },
            {
              eyebrow: 'Docs',
              title: 'A store, not a folder',
              text: 'Plans, briefs and project rules live in one queryable store and hydrate into the tree, so a prompt cites a source instead of copying it.',
            },
            {
              eyebrow: 'Notes',
              title: 'Observations, not a backlog',
              text: 'One line, anchored to a file, run and commit. Repeat sightings are the promotion signal; nothing becomes a task by itself.',
            },
          ]}
        />
      </Section>
      <Section
        eyebrow="Suggestion box"
        title="Agents find things. The board should not drown in them."
        intro="A note is the third option: one line, filed in a second, that never reaches the board on its own."
      >
        <Cards
          items={[
            {
              title: 'Anchored automatically',
              text: 'Project, run, branch, session, commit and file anchor are derived when it is filed.',
            },
            {
              title: 'Repeated, not duplicated',
              text: 'A repeat finding adds a sighting. Repetition with cost is the promotion signal.',
            },
            {
              title: 'Promoted by a person',
              text: 'Scheduled work never promotes, so the board never grows by itself.',
            },
          ]}
        />
      </Section>
      <Cta
        title={
          <>
            Connect a project
            <br />
            without moving its tasks.
          </>
        }
      />
    </main>
  )
}

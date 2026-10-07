import { Cards, Cta, PageHero, Section } from './shared'

export function DocStorePage() {
  return (
    <main className="site-page">
      <PageHero
        crumb="Doc store"
        title="One source of truth"
        muted="for the team and the models."
        copy="Your technical documentation lives in a store that people read and agents query — the same text, the same version, at the same moment. Nobody maintains a second copy for the machines, and no worker builds against a document that stopped being true last month."
        actions={[
          ['/docs', 'Read the docs guide'],
          ['/product/workflows', 'See workflows'],
        ]}
      />
      <Section
        eyebrow="The problem it removes"
        title="Documentation written twice is documentation wrong once"
      >
        <Cards
          two
          items={[
            {
              title: 'One store',
              text: 'Written once. Read by people in the dashboard and by agents over MCP.',
              bullets: [
                'Revisions are kept, so you can see what a worker was actually given.',
                'Cited by source in a prompt, never pasted into one.',
                'Agents write back too — a docs workflow reconciles the store with the code.',
              ],
            },
            {
              title: 'Same store, two readers',
              text: 'People browse and edit. Agents list documents, fetch a named subject and read the project brief.',
            },
          ]}
        />
      </Section>
      <Section
        eyebrow="Scopes"
        title="A worker is given what applies, and nothing else"
        intro="Scope is what keeps a prompt small without keeping it ignorant. The pack compiled for a run carries the documents that bear on it."
      >
        <Cards
          items={[
            {
              eyebrow: 'global',
              title: 'True everywhere',
              text: 'Standards that hold across every project.',
            },
            {
              eyebrow: 'stack',
              title: 'True of this runtime',
              text: 'What applies because of the language, framework or toolchain.',
            },
            {
              eyebrow: 'project',
              title: 'True here',
              text: "This repository's architecture, conventions and domain knowledge.",
            },
            {
              eyebrow: 'Into the tree',
              title: 'Rules written from the store',
              text: 'Rules agents read as files are written into the worktree from the store.',
            },
            {
              eyebrow: 'Revisions',
              title: 'What was true then',
              text: 'A run records the document revisions it was given.',
            },
            {
              eyebrow: 'Search',
              title: 'Indexed with the code',
              text: 'Docs sit in the same retrieval index as source and past runs.',
            },
          ]}
        />
      </Section>
      <Cta
        title={
          <>
            Write it once.
            <br />
            Everyone reads the same thing.
          </>
        }
      />
    </main>
  )
}

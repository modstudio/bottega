import { Cards, Check, Cta, PageHero, Panel, Section } from './shared'

const checks = [
  'Written once. Read by people in the dashboard and by agents over MCP.',
  'Revisions are kept, so you can see what a worker was actually given.',
  'Cited by source in a prompt, never pasted into one.',
  'Agents write back too — a docs workflow reconciles the store with the code.',
]
const scopes = [
  [
    'global',
    'True everywhere',
    'Standards that hold across every project — how work is reviewed, landed and recorded.',
  ],
  [
    'stack',
    'True of this runtime',
    'What applies because of the language, framework or toolchain in play.',
  ],
  ['project', 'True here', "This repository's architecture, conventions and domain knowledge."],
  [
    'Into the tree',
    'Rules written from the store',
    'Rules that agents read as files are written into the worktree from the store, so a hand-edited copy is replaced rather than quietly obeyed.',
  ],
  [
    'Revisions',
    'What was true then',
    'A run records the document revisions it was given, so a bad result can be traced to the text that caused it.',
  ],
  [
    'Search',
    'Indexed with the code',
    'Docs sit in the same retrieval index as source and past runs, so “where is this decided?” is one question.',
  ],
].map(([eyebrow, title, text]) => ({ eyebrow, title, text }))
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
      <section className="section-tight">
        <div className="wrap">
          <div className="split split-start">
            <div>
              <div className="sec-head left">
                <span className="eyebrow">The problem it removes</span>
                <h2>Documentation written twice is documentation wrong once</h2>
                <p>
                  The usual arrangement is a wiki for the team and a pile of pasted context for the
                  agents. The two drift immediately, and the drift is invisible until a worker
                  confidently builds the wrong thing from a copy nobody remembered to update.
                </p>
              </div>
              <ul className="checks">
                {checks.map((item) => (
                  <li key={item}>
                    <Check />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <Panel eyebrow="Same store, two readers">
              <pre>
                <span className="c">
                  {'// a person'}
                  {`\n`} hub serve → browse, search, edit{`\n\n`}
                  {'// an agent, mid-run'}
                </span>
                {`\n`}
                <b>list_docs</b>({'{ scope: "project" }'}){`\n`}
                <b>get_doc</b>({'{ subject: "payments" }'}){`\n`}
                <b>project_brief</b>(){`\n\n`}
                <span className="c">{'// the architect, writing a ruling down'}</span>
                {`\n`}$ <b>orch doc set</b> --scope project \{`\n`} --subject payments --file
                ruling.md{`\n\n`}
                <span className="c"> revision recorded · readable by both</span>
              </pre>
            </Panel>
          </div>
        </div>
      </section>
      <hr className="rule" />
      <Section
        eyebrow="Scopes"
        title="A worker is given what applies, and nothing else"
        intro="Scope is what keeps a prompt small without keeping it ignorant. The pack compiled for a run carries the documents that bear on it."
      >
        <Cards items={scopes} />
      </Section>
      <Cta
        title={
          <>
            Write it once.
            <br />
            Everyone reads the same thing.
          </>
        }
        actions={[['/docs', 'Read the docs guide']]}
      />
    </main>
  )
}

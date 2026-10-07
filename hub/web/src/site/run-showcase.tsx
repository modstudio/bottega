import { Link } from '@tanstack/react-router'
import { PLATFORM_SLUG } from '../../../../shared/brand.ts'

const rows = [
  ['r-4f19', 'implement', 'codex', 'ATL-412 webhook retries', 'running', '—', 'run'],
  ['r-4f17', 'implement', 'qwen3-32b · local', 'HBR-208 tenant cache', 'asking', '—', 'ask'],
  ['r-4f12', 'review · lens', 'claude', 'MER-117 duplicate records', 'accepted', '4 / 4', 'ok'],
  ['r-4f08', 'fix', 'grok', 'HBR-205 audit pagination', 'accepted', '3 / 4', 'ok'],
  [
    'r-4f02',
    'summarize',
    'llama3.1-8b · local',
    'MER-114 export throttling',
    'voided',
    '—',
    'void',
  ],
]
export function RunShowcase() {
  return (
    <div className="showcase">
      <div className="showcase-in">
        <div className="app">
          <div className="app-bar">
            <div className="lights" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <span className="path mono">{PLATFORM_SLUG} — orch board</span>
          </div>
          <div className="app-body">
            <aside className="app-side">
              <b>Orchestration</b>
              <Link to="/product/orchestration" className="on">
                Board
              </Link>
              <Link to="/product/orchestration">Runs</Link>
              <Link to="/product/orchestration">
                Inbox <span>2</span>
              </Link>
              <Link to="/product/workers">Routing</Link>
              <b>Workspace</b>
              <Link to="/product/board">Tasks</Link>
              <Link to="/product/board">Docs</Link>
              <Link to="/product/board">Workflows</Link>
              <Link to="/product/board">Notes</Link>
            </aside>
            <div className="app-main">
              <div className="app-h">
                <h3>Runs</h3>
                <span>4 live · 2 waiting on a ruling · 11 scored today</span>
              </div>
              <div className="runs-scroll">
                <table className="runs">
                  <thead>
                    <tr>
                      <th>Run</th>
                      <th>Job</th>
                      <th>Agent</th>
                      <th>Task</th>
                      <th>State</th>
                      <th>Fidelity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(([run, job, agent, task, state, score, tone]) => (
                      <tr key={run}>
                        <td className="k">{run}</td>
                        <td>{job}</td>
                        <td>{agent}</td>
                        <td>{task}</td>
                        <td>
                          <span className={`tag ${tone}`}>
                            <i />
                            {state}
                          </span>
                        </td>
                        <td className="score">{score}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="app-note">
                <span className="q">ask ↑</span>
                <p>
                  <b>r-4f17 stopped and asked.</b> “The spec says retry on a 5xx. Two existing
                  callers also retry on a 429. Do I change them too, or scope the retry to the new
                  path?” — waiting on your ruling, nothing guessed.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

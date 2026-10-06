import { PLATFORM_SLUG } from '../../../../shared/brand.ts'

export function RunShowcase() {
  return (
    <div className="site-showcase">
      <div className="site-window">
        <div className="site-window-bar">{PLATFORM_SLUG} — orch board</div>
        <div className="site-window-body">
          <h2>Runs</h2>
          <table className="site-table">
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
              <tr>
                <td>r-4f19</td>
                <td>implement</td>
                <td>codex</td>
                <td>ATL-412 webhook retries</td>
                <td>running</td>
                <td>—</td>
              </tr>
              <tr>
                <td>r-4f17</td>
                <td>implement</td>
                <td>qwen3-32b · local</td>
                <td>HBR-208 tenant cache</td>
                <td>asking</td>
                <td>—</td>
              </tr>
              <tr>
                <td>r-4f12</td>
                <td>review · lens</td>
                <td>claude</td>
                <td>MER-117 duplicate records</td>
                <td>accepted</td>
                <td>4 / 4</td>
              </tr>
            </tbody>
          </table>
          <p>
            <strong>r-4f17 stopped and asked.</strong> “The spec says retry on a 5xx. Two existing
            callers also retry on a 429. Do I change them too, or scope the retry to the new path?”
            — waiting on your ruling, nothing guessed.
          </p>
        </div>
      </div>
    </div>
  )
}

import { useState, useEffect } from 'react'
import { useSnapshot } from '../hooks/useSnapshot.js'
import { apiFetch } from '../lib/client.js'

function fmt(ms) {
  return ms != null ? `${Math.round(ms).toLocaleString()}ms` : '—'
}

function fmtTime(iso) {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleTimeString() } catch { return iso }
}

export default function Overview() {
  const { snapshot, loading, error, refresh } = useSnapshot()
  const [models, setModels] = useState(null)

  useEffect(() => {
    apiFetch('/v1/models').then(setModels).catch(() => {})
  }, [])

  if (loading && !snapshot) {
    return <div role="status" aria-label="Loading overview data">Loading…</div>
  }

  if (error && !snapshot) {
    return (
      <div role="alert">
        <p>Failed to load data.</p>
        <button type="button" onClick={refresh}>Retry</button>
      </div>
    )
  }

  const { metrics, activeJobs, takenAt } = snapshot
  const totalActivity = metrics.queuedJobs + metrics.runningJobs + metrics.completedJobs + metrics.failedJobs + metrics.cancelledJobs

  return (
    <main>
      <h1>Overview</h1>

      {error && (
        <div role="alert">
          <span>Update failed — showing last data. </span>
          <button type="button" onClick={refresh}>Retry</button>
        </div>
      )}

      <section aria-label="Job statistics">
        <h2>Jobs</h2>
        {totalActivity === 0 && <p>No jobs recorded yet.</p>}
        <dl>
          <div><dt>Queued</dt><dd data-testid="kpi-queued">{metrics.queuedJobs}</dd></div>
          <div><dt>Running</dt><dd data-testid="kpi-running">{metrics.runningJobs}</dd></div>
          <div><dt>Completed</dt><dd data-testid="kpi-completed">{metrics.completedJobs}</dd></div>
          <div><dt>Failed</dt><dd data-testid="kpi-failed">{metrics.failedJobs}</dd></div>
          <div><dt>Cancelled</dt><dd data-testid="kpi-cancelled">{metrics.cancelledJobs}</dd></div>
        </dl>
      </section>

      <section aria-label="Active jobs">
        <h2>Active Jobs ({activeJobs.length})</h2>
        {activeJobs.length === 0 ? (
          <p>No active jobs.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Job ID</th>
                <th scope="col">Status</th>
                <th scope="col">Queued</th>
                <th scope="col">Started</th>
              </tr>
            </thead>
            <tbody>
              {activeJobs.map(job => (
                <tr key={job.jobId}>
                  <td>{job.jobId}</td>
                  <td>{job.status}</td>
                  <td>{fmtTime(job.queuedAt)}</td>
                  <td>{fmtTime(job.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-label="Queue statistics">
        <h2>Queue Statistics</h2>
        <dl>
          <div><dt>Avg Queue Wait</dt><dd>{fmt(metrics.averageQueueWaitMs)}</dd></div>
          <div><dt>Avg Runtime</dt><dd>{fmt(metrics.averageRuntimeMs)}</dd></div>
          <div><dt>Max Runtime</dt><dd>{fmt(metrics.maximumRuntimeMs)}</dd></div>
        </dl>
      </section>

      <section aria-label="Health">
        <h2>Health</h2>
        <dl>
          <div><dt>Events Processed</dt><dd data-testid="health-event-count">{metrics.eventCount}</dd></div>
          <div>
            <dt>Last Updated</dt>
            <dd><time dateTime={takenAt}>{fmtTime(takenAt)}</time></dd>
          </div>
        </dl>
      </section>

      {models && (
        <section aria-label="Model configuration">
          <h2>Models</h2>
          <dl>
            <div><dt>Default Model</dt><dd data-testid="models-default-model">{models.defaults.model}</dd></div>
            <div><dt>Default Effort</dt><dd>{models.defaults.effort}</dd></div>
          </dl>
        </section>
      )}
    </main>
  )
}

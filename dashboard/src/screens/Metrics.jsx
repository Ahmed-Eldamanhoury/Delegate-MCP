import { useMetrics } from '../hooks/useMetrics.js'
import { fmtMs } from '../lib/fmt.js'

export default function Metrics() {
  const { metrics: m, loading, error, refresh } = useMetrics()

  if (loading && !m) {
    return <div role="status" aria-label="Loading metrics">Loading…</div>
  }

  if (error && !m) {
    return (
      <div role="alert">
        <p>Failed to load metrics.</p>
        <button type="button" onClick={refresh} aria-label="Retry">Retry</button>
      </div>
    )
  }

  const totalActivity = m.queuedJobs + m.runningJobs + m.completedJobs + m.failedJobs + m.cancelledJobs + m.eventCount

  return (
    <main>
      <h1>Metrics</h1>

      {error && (
        <div role="alert">
          <span>Update failed — showing last data. </span>
          <button type="button" onClick={refresh} aria-label="Retry">Retry</button>
        </div>
      )}

      {totalActivity === 0 ? (
        <p>No metrics recorded yet.</p>
      ) : (
        <>
          <section aria-label="Job counts">
            <h2>Job Counts</h2>
            <dl>
              <div><dt>Queued</dt><dd data-testid="metric-queued">{m.queuedJobs}</dd></div>
              <div><dt>Running</dt><dd data-testid="metric-running">{m.runningJobs}</dd></div>
              <div><dt>Completed</dt><dd data-testid="metric-completed">{m.completedJobs}</dd></div>
              <div><dt>Failed</dt><dd data-testid="metric-failed">{m.failedJobs}</dd></div>
              <div><dt>Cancelled</dt><dd data-testid="metric-cancelled">{m.cancelledJobs}</dd></div>
            </dl>
          </section>

          <section aria-label="Runtime statistics">
            <h2>Runtime Statistics</h2>
            <dl>
              <div><dt>Avg Runtime</dt><dd data-testid="metric-avg-runtime">{fmtMs(m.averageRuntimeMs)}</dd></div>
              <div><dt>Max Runtime</dt><dd data-testid="metric-max-runtime">{fmtMs(m.maximumRuntimeMs)}</dd></div>
              <div><dt>Avg Queue Wait</dt><dd data-testid="metric-avg-wait">{fmtMs(m.averageQueueWaitMs)}</dd></div>
            </dl>
          </section>

          <section aria-label="Event statistics">
            <h2>Event Statistics</h2>
            <dl>
              <div><dt>Events</dt><dd data-testid="metric-events">{m.eventCount}</dd></div>
              <div><dt>Streaming Events</dt><dd data-testid="metric-streaming">{m.streamingEvents}</dd></div>
              <div><dt>Output Chunks</dt><dd data-testid="metric-chunks">{m.outputChunks}</dd></div>
            </dl>
          </section>
        </>
      )}
    </main>
  )
}

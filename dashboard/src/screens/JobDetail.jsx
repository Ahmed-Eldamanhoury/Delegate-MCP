import { useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useJobSubscription } from '../hooks/useJobSubscription.js'
import { apiFetch } from '../lib/client.js'
import { fmtMs } from '../lib/fmt.js'

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

function fmtTime(iso) {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

export default function JobDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { job, loading, error } = useJobSubscription(id)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState(null)
  const [replayData, setReplayData] = useState(null)
  const [replayLoading, setReplayLoading] = useState(false)
  const [replayError, setReplayError] = useState(null)

  const cancel = useCallback(async () => {
    setCancelling(true)
    setCancelError(null)
    try {
      const result = await apiFetch(`/v1/jobs/${id}`, { method: 'DELETE' })
      if (result?.error) setCancelError(result.error.message || 'Could not cancel job')
    } catch (err) {
      setCancelError(err.message || 'Cancel failed')
    } finally {
      setCancelling(false)
    }
  }, [id])

  const loadReplay = useCallback(async () => {
    setReplayLoading(true)
    setReplayError(null)
    try {
      const data = await apiFetch(`/v1/jobs/${id}/replay`)
      setReplayData(data)
    } catch (err) {
      setReplayError(err.message || 'Failed to load replay')
    } finally {
      setReplayLoading(false)
    }
  }, [id])

  if (loading && !job) {
    return <div role="status" aria-label="Loading job details">Loading…</div>
  }

  if (error && !job) {
    return (
      <div role="alert">
        <p>Failed to load job.</p>
        <button type="button" onClick={() => navigate('/jobs')} aria-label="Back to jobs">Back to Jobs</button>
      </div>
    )
  }

  const isTerminal = TERMINAL.has(job.status)

  return (
    <main>
      <nav aria-label="Breadcrumb">
        <button type="button" onClick={() => navigate('/jobs')} aria-label="Back to jobs">← Jobs</button>
      </nav>

      <h1>Job Detail</h1>

      {error && <div role="alert"><span>Update failed — retrying…</span></div>}
      {cancelError && <div role="alert">{cancelError}</div>}

      {!isTerminal && (
        <button type="button" onClick={cancel} disabled={cancelling} aria-label="Cancel job">
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </button>
      )}

      <section aria-label="Job details">
        <dl>
          <div><dt>ID</dt><dd data-testid="job-id">{job.id}</dd></div>
          <div><dt>Status</dt><dd data-testid="job-status">{job.status}</dd></div>
          <div><dt>Phase</dt><dd>{job.phase}</dd></div>
          <div><dt>Progress</dt><dd>{job.progressMessage}</dd></div>
          <div><dt>Model</dt><dd>{job.metadata?.model ?? '—'}</dd></div>
          <div><dt>Queued</dt><dd>{fmtTime(job.queuedAt)}</dd></div>
          <div><dt>Started</dt><dd>{fmtTime(job.startedAt)}</dd></div>
          <div><dt>Finished</dt><dd>{fmtTime(job.finishedAt)}</dd></div>
          <div><dt>Runtime</dt><dd>{fmtMs(job.runtimeMs)}</dd></div>
          {job.exitCode != null && <div><dt>Exit Code</dt><dd>{job.exitCode}</dd></div>}
          {job.error && <div><dt>Error</dt><dd>{job.error}</dd></div>}
        </dl>
      </section>

      {job.result && (
        <section aria-label="Job result">
          <h2>Result</h2>
          <pre data-testid="job-result">{JSON.stringify(job.result, null, 2)}</pre>
        </section>
      )}

      <section aria-label="Replay">
        <h2>Replay</h2>
        {!replayData && !replayLoading && !replayError && (
          <button type="button" onClick={loadReplay} aria-label="Load replay">Load Replay</button>
        )}
        {replayLoading && <div role="status">Loading replay…</div>}
        {replayError && (
          <div role="alert">
            {replayError}
            <button type="button" onClick={loadReplay} aria-label="Retry replay">Retry</button>
          </div>
        )}
        {replayData && (
          <>
            <p>Source: {replayData.source}</p>
            {replayData.source === 'unavailable' ? (
              <p>No replay data available for this job.</p>
            ) : (
              <ol aria-label="Job timeline">
                {replayData.timeline.map((entry, i) => (
                  <li key={entry.eventId ?? i}>
                    <time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleString()}</time>
                    {' '}
                    <span>{entry.type}</span>
                    {entry.synthetic && <span> (reconstructed)</span>}
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </section>
    </main>
  )
}

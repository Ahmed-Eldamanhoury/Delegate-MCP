import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useJobs } from '../hooks/useJobs.js'
import { fmtMs } from '../lib/fmt.js'

const STATUSES = ['queued', 'starting', 'running', 'completed', 'failed', 'cancelled']

function fmtTime(iso) {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleTimeString() } catch { return iso }
}

export default function Jobs() {
  const navigate = useNavigate()
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(20)
  const { jobs, count, loading, error, refresh } = useJobs({ status: statusFilter || undefined, limit })

  const visible = search.trim() ? jobs.filter(j => j.id.includes(search.trim())) : jobs

  if (loading && jobs.length === 0) {
    return <div role="status" aria-label="Loading jobs">Loading…</div>
  }

  if (error && jobs.length === 0) {
    return (
      <div role="alert">
        <p>Failed to load jobs.</p>
        <button type="button" onClick={refresh}>Retry</button>
      </div>
    )
  }

  return (
    <main>
      <h1>Jobs</h1>

      {error && jobs.length > 0 && (
        <div role="alert">
          <span>Update failed — showing last data. </span>
          <button type="button" onClick={refresh}>Retry</button>
        </div>
      )}

      <section aria-label="Filters">
        <label htmlFor="status-filter">Status</label>
        <select
          id="status-filter"
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setLimit(20) }}
        >
          <option value="">All</option>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>

        <label htmlFor="job-search">Search</label>
        <input
          id="job-search"
          type="search"
          placeholder="Filter by job ID"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />

        <button type="button" onClick={refresh} aria-label="Refresh job list">Refresh</button>
      </section>

      {visible.length === 0 ? (
        <p>No jobs found.</p>
      ) : (
        <>
          <table>
            <caption>{count} job{count !== 1 ? 's' : ''}{statusFilter ? ` (${statusFilter})` : ''}</caption>
            <thead>
              <tr>
                <th scope="col">Job ID</th>
                <th scope="col">Status</th>
                <th scope="col">Model</th>
                <th scope="col">Queued</th>
                <th scope="col">Runtime</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(job => (
                <tr key={job.id}>
                  <td>
                    <button
                      type="button"
                      onClick={() => navigate(`/jobs/${job.id}`)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                    >
                      {job.id}
                    </button>
                  </td>
                  <td><span data-status={job.status}>{job.status}</span></td>
                  <td>{job.model ?? '—'}</td>
                  <td>{fmtTime(job.queuedAt)}</td>
                  <td>{fmtMs(job.runtimeMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {count > limit && (
            <button type="button" onClick={() => setLimit(l => Math.min(l + 20, 500))} aria-label="Load more jobs">
              Load more
            </button>
          )}
        </>
      )}
    </main>
  )
}

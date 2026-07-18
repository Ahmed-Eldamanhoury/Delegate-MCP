import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/client.js'

export default function Models() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tick, setTick] = useState(0)
  const [search, setSearch] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    apiFetch('/v1/models')
      .then(d => { if (active) { setData(d); setLoading(false) } })
      .catch(err => { if (active) { setError(err); setLoading(false) } })
    return () => { active = false }
  }, [tick])

  if (loading) {
    return <div role="status" aria-label="Loading models">Loading…</div>
  }

  if (error) {
    return (
      <div role="alert">
        <p>Failed to load models.</p>
        <button type="button" onClick={() => setTick(t => t + 1)} aria-label="Retry">Retry</button>
      </div>
    )
  }

  const visible = search.trim()
    ? data.models.filter(m => m.model.includes(search.trim()))
    : data.models

  return (
    <main>
      <h1>Models</h1>

      <section aria-label="Defaults">
        <h2>Defaults</h2>
        <dl>
          <div><dt>Default Model</dt><dd data-testid="default-model">{data.defaults.model}</dd></div>
          <div><dt>Default Effort</dt><dd data-testid="default-effort">{data.defaults.effort}</dd></div>
          <div><dt>Default Budget</dt><dd data-testid="default-budget">${data.defaults.maxBudgetUsd}</dd></div>
        </dl>
      </section>

      <section aria-label="Effort presets">
        <h2>Effort Presets</h2>
        <ul>
          {data.efforts.map(ef => <li key={ef}>{ef}</li>)}
        </ul>
      </section>

      <section aria-label="Available models">
        <h2>Available Models</h2>
        <div>
          <label htmlFor="model-search">Search</label>
          <input
            id="model-search"
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter by name"
          />
        </div>
        {visible.length === 0 ? (
          <p>No models match your search.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Fallback</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(m => (
                <tr key={m.model} data-testid={`model-${m.model}`}>
                  <td>{m.model}</td>
                  <td>{m.fallback ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  )
}

import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/client.js'

const MODELS = ['haiku', 'sonnet', 'opus', 'fable']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

export default function Submit() {
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('sonnet')
  const [effort, setEffort] = useState('low')
  const [budget, setBudget] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const submit = useCallback(async () => {
    if (!prompt.trim()) {
      setError('Prompt is required.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const body = { prompt: prompt.trim(), model, effort }
      if (budget) body.max_budget_usd = Number(budget)
      const result = await apiFetch('/v1/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (result?.error) {
        setError(result.error.message || 'Submission failed.')
      } else {
        navigate(`/jobs/${result.job_id}`)
      }
    } catch (err) {
      setError(err.message || 'Submission failed.')
    } finally {
      setSubmitting(false)
    }
  }, [prompt, model, effort, budget, navigate])

  return (
    <main>
      <h1>Submit Job</h1>

      {error && (
        <div role="alert">
          <p>{error}</p>
          <button type="button" onClick={submit} aria-label="Retry">Retry</button>
        </div>
      )}

      <form onSubmit={e => { e.preventDefault(); submit() }} noValidate>
        <div>
          <label htmlFor="prompt">Prompt</label>
          <textarea
            id="prompt"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            rows={6}
            aria-required="true"
          />
        </div>

        <div>
          <label htmlFor="model">Model</label>
          <select id="model" value={model} onChange={e => setModel(e.target.value)}>
            {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div>
          <label htmlFor="effort">Effort</label>
          <select id="effort" value={effort} onChange={e => setEffort(e.target.value)}>
            {EFFORTS.map(ef => <option key={ef} value={ef}>{ef}</option>)}
          </select>
        </div>

        <div>
          <label htmlFor="budget">Max Budget (USD)</label>
          <input
            id="budget"
            type="number"
            min="0.01"
            step="0.01"
            value={budget}
            onChange={e => setBudget(e.target.value)}
            placeholder="default"
          />
        </div>

        <button type="submit" disabled={submitting} aria-label="Submit job">
          {submitting ? 'Submitting…' : 'Submit'}
        </button>
      </form>
    </main>
  )
}

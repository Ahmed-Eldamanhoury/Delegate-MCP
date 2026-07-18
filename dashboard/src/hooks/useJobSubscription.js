import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/client.js'

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

export function useJobSubscription(jobId) {
  const [job, setJob] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    let timer

    async function poll() {
      try {
        const data = await apiFetch(`/v1/jobs/${jobId}`)
        if (!active) return
        setJob(data)
        setLoading(false)
        setError(null)
        if (TERMINAL.has(data.status)) return
        timer = setTimeout(poll, 2000)
      } catch (err) {
        if (!active) return
        setError(err)
        setLoading(false)
        timer = setTimeout(poll, 2000)
      }
    }

    poll()
    return () => { active = false; clearTimeout(timer) }
  }, [jobId])

  return { job, error, loading }
}

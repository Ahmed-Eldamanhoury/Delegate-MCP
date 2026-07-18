import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../lib/client.js'

export function useJobs({ status, limit = 20 } = {}) {
  const [jobs, setJobs] = useState([])
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick(t => t + 1), [])

  useEffect(() => {
    let active = true
    let timer

    setLoading(true)
    setError(null)

    async function poll() {
      try {
        const params = new URLSearchParams()
        if (status) params.set('status', status)
        params.set('limit', String(limit))
        const data = await apiFetch(`/v1/jobs?${params}`)
        if (!active) return
        setJobs(data.jobs)
        setCount(data.count)
        setLoading(false)
        setError(null)
      } catch (err) {
        if (!active) return
        setError(err)
        setLoading(false)
      }
      if (active) timer = setTimeout(poll, 5000)
    }

    poll()
    return () => { active = false; clearTimeout(timer) }
  }, [status, limit, tick])

  return { jobs, count, loading, error, refresh }
}

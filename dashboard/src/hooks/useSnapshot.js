import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../lib/client.js'

export function useSnapshot(intervalMs = 5000) {
  const [snapshot, setSnapshot] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => {
    setError(null)
    setLoading(true)
    setTick(t => t + 1)
  }, [])

  useEffect(() => {
    let active = true
    let timer

    async function poll() {
      try {
        const data = await apiFetch('/v1/snapshot')
        if (!active) return
        setSnapshot(data)
        setLoading(false)
        setError(null)
      } catch (err) {
        if (!active) return
        setError(err)
        setLoading(false)
      }
      if (active) timer = setTimeout(poll, intervalMs)
    }

    poll()
    return () => { active = false; clearTimeout(timer) }
  }, [intervalMs, tick])

  return { snapshot, loading, error, refresh }
}

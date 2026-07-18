import { vi, test, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMetrics } from '../hooks/useMetrics.js'

vi.mock('../lib/client.js', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '../lib/client.js'

const METRICS = {
  queuedJobs: 1, runningJobs: 2, completedJobs: 10, failedJobs: 3, cancelledJobs: 1,
  averageRuntimeMs: 5000, maximumRuntimeMs: 30000, averageQueueWaitMs: 100,
  progressRate: 0.95, streamingEvents: 500, outputChunks: 200, eventCount: 1500,
  workspaceSizeBytes: null, artifactCount: null,
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })

const flush = () => act(async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
})

test('starts in loading state', async () => {
  apiFetch.mockReturnValue(new Promise(() => {}))
  const { result } = renderHook(() => useMetrics())
  expect(result.current.loading).toBe(true)
  expect(result.current.metrics).toBe(null)
})

test('resolves metrics on success', async () => {
  apiFetch.mockResolvedValue(METRICS)
  const { result } = renderHook(() => useMetrics())
  await flush()
  expect(result.current.loading).toBe(false)
  expect(result.current.metrics).toEqual(METRICS)
  expect(result.current.error).toBe(null)
})

test('polls again after interval', async () => {
  apiFetch.mockResolvedValue(METRICS)
  renderHook(() => useMetrics(1000))
  await flush()
  expect(apiFetch).toHaveBeenCalledTimes(1)
  await act(async () => { vi.advanceTimersByTime(1000) })
  await flush()
  expect(apiFetch).toHaveBeenCalledTimes(2)
})

test('sets error on failure', async () => {
  apiFetch.mockRejectedValue(new Error('net'))
  const { result } = renderHook(() => useMetrics())
  await flush()
  expect(result.current.error).toBeTruthy()
  expect(result.current.loading).toBe(false)
})

test('refresh triggers re-fetch', async () => {
  apiFetch.mockResolvedValue(METRICS)
  const { result } = renderHook(() => useMetrics())
  await flush()
  expect(apiFetch).toHaveBeenCalledTimes(1)
  act(() => result.current.refresh())
  await flush()
  expect(apiFetch).toHaveBeenCalledTimes(2)
})

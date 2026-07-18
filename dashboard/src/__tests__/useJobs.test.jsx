import { vi, test, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useJobs } from '../hooks/useJobs'

vi.mock('../lib/client.js', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '../lib/client.js'

const JOB = { id: 'j1', status: 'running', model: 'sonnet', queuedAt: '2024-01-01T10:00:00Z', runtimeMs: 100, phase: 'executing', progressMessage: 'Running', startedAt: null, finishedAt: null, exitCode: null, costUsd: null, error: null }
const RESPONSE = { jobs: [JOB], count: 1, limit: 20 }

const flush = () => act(async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

test('starts with loading=true and empty jobs', () => {
  apiFetch.mockResolvedValue(RESPONSE)
  const { result } = renderHook(() => useJobs())
  expect(result.current.loading).toBe(true)
  expect(result.current.jobs).toEqual([])
})

test('returns jobs and count after first poll', async () => {
  apiFetch.mockResolvedValue(RESPONSE)
  const { result } = renderHook(() => useJobs())
  await flush()
  expect(result.current.jobs).toEqual([JOB])
  expect(result.current.count).toBe(1)
  expect(result.current.loading).toBe(false)
  expect(result.current.error).toBeNull()
})

test('continues polling on interval', async () => {
  apiFetch.mockResolvedValue(RESPONSE)
  renderHook(() => useJobs())
  await flush()
  const calls = apiFetch.mock.calls.length
  act(() => { vi.advanceTimersByTime(5000) })
  await flush()
  expect(apiFetch.mock.calls.length).toBeGreaterThan(calls)
})

test('sets error on fetch failure', async () => {
  apiFetch.mockRejectedValue(new Error('net'))
  const { result } = renderHook(() => useJobs())
  await flush()
  expect(result.current.error).toBeInstanceOf(Error)
  expect(result.current.loading).toBe(false)
})

test('keeps last jobs when subsequent poll fails', async () => {
  apiFetch.mockResolvedValueOnce(RESPONSE).mockRejectedValue(new Error('net'))
  const { result } = renderHook(() => useJobs())
  await flush()
  act(() => { vi.advanceTimersByTime(5000) })
  await flush()
  expect(result.current.jobs).toEqual([JOB])
  expect(result.current.error).toBeInstanceOf(Error)
})

test('refresh triggers immediate re-poll', async () => {
  apiFetch.mockResolvedValue(RESPONSE)
  const { result } = renderHook(() => useJobs())
  await flush()
  const calls = apiFetch.mock.calls.length
  act(() => { result.current.refresh() })
  await flush()
  expect(apiFetch.mock.calls.length).toBeGreaterThan(calls)
})

test('passes status filter in query string', async () => {
  apiFetch.mockResolvedValue({ jobs: [], count: 0, limit: 20 })
  renderHook(() => useJobs({ status: 'running' }))
  await flush()
  expect(apiFetch.mock.calls[0][0]).toContain('status=running')
})

test('passes limit in query string', async () => {
  apiFetch.mockResolvedValue({ jobs: [], count: 0, limit: 50 })
  renderHook(() => useJobs({ limit: 50 }))
  await flush()
  expect(apiFetch.mock.calls[0][0]).toContain('limit=50')
})

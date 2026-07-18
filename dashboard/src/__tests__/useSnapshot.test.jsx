import { vi, test, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSnapshot } from '../hooks/useSnapshot'

vi.mock('../lib/client.js', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '../lib/client.js'

const SNAP = { takenAt: '2024-01-01T00:00:00Z', metrics: { queuedJobs: 1, runningJobs: 0, completedJobs: 3, failedJobs: 0, cancelledJobs: 0, averageRuntimeMs: null, maximumRuntimeMs: null, averageQueueWaitMs: null, progressRate: 0, streamingEvents: 0, outputChunks: 0, eventCount: 5, workspaceSizeBytes: null, artifactCount: null }, activeJobs: [] }

const flush = () => act(async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

test('starts with loading=true and no snapshot', () => {
  apiFetch.mockResolvedValue(SNAP)
  const { result } = renderHook(() => useSnapshot())
  expect(result.current.loading).toBe(true)
  expect(result.current.snapshot).toBeNull()
})

test('returns snapshot after first poll resolves', async () => {
  apiFetch.mockResolvedValue(SNAP)
  const { result } = renderHook(() => useSnapshot())
  await flush()
  expect(result.current.snapshot).toEqual(SNAP)
  expect(result.current.loading).toBe(false)
  expect(result.current.error).toBeNull()
})

test('continues polling on interval', async () => {
  apiFetch.mockResolvedValue(SNAP)
  renderHook(() => useSnapshot(5000))
  await flush()
  const calls = apiFetch.mock.calls.length
  act(() => { vi.advanceTimersByTime(5000) })
  await flush()
  expect(apiFetch.mock.calls.length).toBeGreaterThan(calls)
})

test('sets error on fetch failure', async () => {
  apiFetch.mockRejectedValue(new Error('network'))
  const { result } = renderHook(() => useSnapshot())
  await flush()
  expect(result.current.error).toBeInstanceOf(Error)
  expect(result.current.loading).toBe(false)
})

test('keeps last snapshot when subsequent poll fails', async () => {
  apiFetch
    .mockResolvedValueOnce(SNAP)
    .mockRejectedValue(new Error('network'))
  const { result } = renderHook(() => useSnapshot(5000))
  await flush()
  expect(result.current.snapshot).toEqual(SNAP)
  act(() => { vi.advanceTimersByTime(5000) })
  await flush()
  expect(result.current.snapshot).toEqual(SNAP)
  expect(result.current.error).toBeInstanceOf(Error)
})

test('refresh triggers immediate re-poll', async () => {
  apiFetch.mockResolvedValue(SNAP)
  const { result } = renderHook(() => useSnapshot(60000))
  await flush()
  const calls = apiFetch.mock.calls.length
  act(() => { result.current.refresh() })
  await flush()
  expect(apiFetch.mock.calls.length).toBeGreaterThan(calls)
})

import { vi, test, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useJobSubscription } from '../hooks/useJobSubscription'

vi.mock('../lib/client.js', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '../lib/client.js'

// Flush all pending microtasks so async hook state settles before asserting.
const flush = () => act(async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

test('starts loading on mount', () => {
  apiFetch.mockResolvedValue({ id: 'j1', status: 'queued' })
  const { result } = renderHook(() => useJobSubscription('j1'))
  expect(result.current.loading).toBe(true)
})

test('returns job after first poll resolves', async () => {
  apiFetch.mockResolvedValue({ id: 'j1', status: 'running' })
  const { result } = renderHook(() => useJobSubscription('j1'))
  await flush()
  expect(result.current.job).toEqual({ id: 'j1', status: 'running' })
  expect(result.current.loading).toBe(false)
})

test('stops polling when status is completed', async () => {
  apiFetch.mockResolvedValue({ id: 'j1', status: 'completed' })
  renderHook(() => useJobSubscription('j1'))
  await flush()
  const calls = apiFetch.mock.calls.length
  act(() => { vi.advanceTimersByTime(10000) })
  await flush()
  expect(apiFetch.mock.calls.length).toBe(calls)
})

test('stops polling when status is failed', async () => {
  apiFetch.mockResolvedValue({ id: 'j1', status: 'failed' })
  renderHook(() => useJobSubscription('j1'))
  await flush()
  const calls = apiFetch.mock.calls.length
  act(() => { vi.advanceTimersByTime(10000) })
  await flush()
  expect(apiFetch.mock.calls.length).toBe(calls)
})

test('continues polling on non-terminal status', async () => {
  apiFetch.mockResolvedValue({ id: 'j1', status: 'running' })
  renderHook(() => useJobSubscription('j1'))
  await flush()
  const callsAfterFirst = apiFetch.mock.calls.length
  act(() => { vi.advanceTimersByTime(2000) })
  await flush()
  expect(apiFetch.mock.calls.length).toBeGreaterThan(callsAfterFirst)
})

test('sets error on apiFetch rejection', async () => {
  apiFetch.mockRejectedValue(new Error('network'))
  const { result } = renderHook(() => useJobSubscription('j1'))
  await flush()
  expect(result.current.error).toBeInstanceOf(Error)
  expect(result.current.loading).toBe(false)
})

test('retries polling after transient fetch error', async () => {
  apiFetch
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValue({ id: 'j1', status: 'running' })
  const { result } = renderHook(() => useJobSubscription('j1'))
  await flush()
  expect(result.current.error).toBeInstanceOf(Error)
  await act(async () => { vi.advanceTimersByTime(2000) })
  await flush()
  expect(result.current.job).toEqual({ id: 'j1', status: 'running' })
  expect(result.current.error).toBe(null)
})

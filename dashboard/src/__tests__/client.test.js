import { vi, test, expect, beforeEach, afterEach } from 'vitest'
import { apiFetch, UnauthorizedError } from '../lib/client'
import { setToken, getToken } from '../lib/auth'

beforeEach(() => localStorage.clear())
afterEach(() => vi.resetAllMocks())

test('injects Bearer token when present', async () => {
  setToken('tok')
  const mockFetch = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({}) })
  vi.stubGlobal('fetch', mockFetch)
  await apiFetch('/v1/status')
  expect(mockFetch.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer tok' })
})

test('omits Authorization header when no token', async () => {
  const mockFetch = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({}) })
  vi.stubGlobal('fetch', mockFetch)
  await apiFetch('/v1/status')
  const headers = mockFetch.mock.calls[0][1]?.headers ?? {}
  expect(headers.Authorization).toBeUndefined()
})

test('on 401: clears token, dispatches delegate:unauthorized, throws UnauthorizedError', async () => {
  setToken('expired')
  const mockFetch = vi.fn().mockResolvedValue({ status: 401, ok: false, json: async () => ({}) })
  vi.stubGlobal('fetch', mockFetch)
  const handler = vi.fn()
  window.addEventListener('delegate:unauthorized', handler)
  await expect(apiFetch('/v1/status')).rejects.toBeInstanceOf(UnauthorizedError)
  expect(getToken()).toBeNull()
  expect(handler).toHaveBeenCalledOnce()
  window.removeEventListener('delegate:unauthorized', handler)
})

test('returns parsed JSON body on success', async () => {
  const mockFetch = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ id: 'j1' }) })
  vi.stubGlobal('fetch', mockFetch)
  const result = await apiFetch('/v1/jobs/j1')
  expect(result).toEqual({ id: 'j1' })
})

test('constructs URL from getBaseUrl + path', async () => {
  window.__DELEGATE_REST__ = 'http://10.0.0.1:9000'
  const mockFetch = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({}) })
  vi.stubGlobal('fetch', mockFetch)
  await apiFetch('/v1/status')
  expect(mockFetch.mock.calls[0][0]).toBe('http://10.0.0.1:9000/v1/status')
  delete window.__DELEGATE_REST__
})

import { getBaseUrl } from './baseUrl.js'
import { getToken, clearToken } from './auth.js'

export class UnauthorizedError extends Error {}

export async function apiFetch(path, opts = {}) {
  const token = getToken()
  const headers = { ...opts.headers }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${getBaseUrl()}${path}`, { ...opts, headers })
  if (res.status === 401) {
    clearToken()
    window.dispatchEvent(new CustomEvent('delegate:unauthorized'))
    throw new UnauthorizedError('Unauthorized')
  }
  return res.json()
}

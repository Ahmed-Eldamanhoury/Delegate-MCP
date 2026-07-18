import '@testing-library/jest-dom'
import { vi } from 'vitest'

// Node.js v22+ defines globalThis.localStorage as undefined/non-functional without
// --localstorage-file. Stub it with a Map-backed implementation so bare `localStorage`
// refs in production code and tests work identically to a real browser context.
// Each test file gets its own Map (setup runs once per worker); beforeEach .clear() resets it.
const _store = new Map()
vi.stubGlobal('localStorage', {
  getItem: (k) => _store.has(k) ? _store.get(k) : null,
  setItem: (k, v) => _store.set(k, String(v)),
  removeItem: (k) => _store.delete(k),
  clear: () => _store.clear(),
  get length() { return _store.size },
  key: (i) => [..._store.keys()][i] ?? null,
})

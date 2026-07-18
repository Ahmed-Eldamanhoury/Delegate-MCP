import { test, expect, beforeEach } from 'vitest'
import { getToken, setToken, clearToken } from '../lib/auth'

beforeEach(() => localStorage.clear())

test('getToken returns null when nothing stored', () => {
  expect(getToken()).toBeNull()
})

test('setToken stores and getToken retrieves', () => {
  setToken('abc123')
  expect(getToken()).toBe('abc123')
})

test('clearToken removes token', () => {
  setToken('abc123')
  clearToken()
  expect(getToken()).toBeNull()
})

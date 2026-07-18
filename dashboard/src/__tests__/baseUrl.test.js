import { test, expect, beforeEach } from 'vitest'
import { getBaseUrl } from '../lib/baseUrl'

beforeEach(() => {
  delete window.__DELEGATE_REST__
})

test('returns __DELEGATE_REST__ when set', () => {
  window.__DELEGATE_REST__ = 'http://10.0.0.1:9000'
  expect(getBaseUrl()).toBe('http://10.0.0.1:9000')
})

test('falls back to http://127.0.0.1:8787 when __DELEGATE_REST__ is absent', () => {
  expect(getBaseUrl()).toBe('http://127.0.0.1:8787')
})

import { vi, test, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import App from '../App'
import { setToken } from '../lib/auth'

beforeEach(() => localStorage.clear())

test('shows Login when no token is stored', () => {
  render(<App />)
  expect(screen.getByPlaceholderText(/token/i)).toBeInTheDocument()
})

test('shows Overview when token is present', () => {
  setToken('tok')
  render(<App />)
  expect(screen.getByRole('status')).toBeInTheDocument()
  expect(screen.queryByPlaceholderText(/token/i)).not.toBeInTheDocument()
})

test('returns to Login when delegate:unauthorized event fires', async () => {
  setToken('tok')
  render(<App />)
  expect(screen.getByRole('status')).toBeInTheDocument()
  await act(async () => {
    window.dispatchEvent(new CustomEvent('delegate:unauthorized'))
  })
  expect(screen.getByPlaceholderText(/token/i)).toBeInTheDocument()
})

test('entering token on Login screen shows Overview', () => {
  render(<App />)
  fireEvent.change(screen.getByPlaceholderText(/token/i), { target: { value: 'new-tok' } })
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
  expect(screen.getByRole('status')).toBeInTheDocument()
})

test('shows NavBar navigation when token is present', () => {
  setToken('tok')
  render(<App />)
  expect(screen.getByRole('navigation', { name: /main navigation/i })).toBeInTheDocument()
})

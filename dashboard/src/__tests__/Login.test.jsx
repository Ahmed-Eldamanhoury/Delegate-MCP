import { vi, test, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import Login from '../screens/Login'
import { getToken } from '../lib/auth'

beforeEach(() => localStorage.clear())

test('renders password input and sign-in button', () => {
  render(<Login onLogin={() => {}} />)
  expect(screen.getByPlaceholderText(/token/i)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument()
})

test('submit stores token in localStorage and calls onLogin', () => {
  const onLogin = vi.fn()
  render(<Login onLogin={onLogin} />)
  fireEvent.change(screen.getByPlaceholderText(/token/i), { target: { value: 'my-tok' } })
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
  expect(getToken()).toBe('my-tok')
  expect(onLogin).toHaveBeenCalledOnce()
})

test('does not call onLogin when token value is empty', () => {
  const onLogin = vi.fn()
  render(<Login onLogin={onLogin} />)
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
  expect(onLogin).not.toHaveBeenCalled()
})

test('trims whitespace before storing token', () => {
  const onLogin = vi.fn()
  render(<Login onLogin={onLogin} />)
  fireEvent.change(screen.getByPlaceholderText(/token/i), { target: { value: '  tok  ' } })
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
  expect(getToken()).toBe('tok')
})

test('token input has accessible label', () => {
  render(<Login onLogin={() => {}} />)
  expect(screen.getByLabelText(/bearer token/i)).toBeInTheDocument()
})

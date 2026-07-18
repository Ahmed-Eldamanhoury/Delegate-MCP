import { vi, test, expect, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import NavBar from '../components/NavBar'

vi.mock('../lib/auth.js', () => ({ clearToken: vi.fn() }))
import { clearToken } from '../lib/auth.js'

afterEach(() => vi.clearAllMocks())

const renderNav = () => render(<NavBar />, { wrapper: MemoryRouter })

test('renders as a main navigation landmark', () => {
  renderNav()
  expect(screen.getByRole('navigation', { name: /main navigation/i })).toBeInTheDocument()
})

test('shows links to all protected screens', () => {
  renderNav()
  expect(screen.getByRole('link', { name: /overview/i })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: /jobs/i })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: /submit/i })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: /metrics/i })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: /models/i })).toBeInTheDocument()
})

test('shows sign out button', () => {
  renderNav()
  expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument()
})

test('sign out clears token and dispatches unauthorized event', () => {
  const spy = vi.spyOn(window, 'dispatchEvent')
  renderNav()
  fireEvent.click(screen.getByRole('button', { name: /sign out/i }))
  expect(clearToken).toHaveBeenCalled()
  expect(spy).toHaveBeenCalledWith(expect.objectContaining({ type: 'delegate:unauthorized' }))
})

import { vi, test, expect, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import Jobs from '../screens/Jobs'

vi.mock('../hooks/useJobs.js', () => ({ useJobs: vi.fn() }))
vi.mock('react-router-dom', () => ({ useNavigate: vi.fn() }))
import { useJobs } from '../hooks/useJobs.js'
import { useNavigate } from 'react-router-dom'

const JOBS = [
  { id: 'job-aaa', status: 'running', model: 'sonnet', queuedAt: '2024-01-01T10:00:00Z', runtimeMs: 3000, phase: 'executing', progressMessage: 'Running', startedAt: null, finishedAt: null, exitCode: null, costUsd: null, error: null },
  { id: 'job-bbb', status: 'completed', model: 'sonnet', queuedAt: '2024-01-01T09:00:00Z', runtimeMs: 5000, phase: 'completed', progressMessage: 'Done', startedAt: null, finishedAt: null, exitCode: 0, costUsd: 0.01, error: null },
]

afterEach(() => vi.clearAllMocks())

test('shows loading state when no jobs and loading', () => {
  useNavigate.mockReturnValue(vi.fn())
  useJobs.mockReturnValue({ jobs: [], count: 0, loading: true, error: null, refresh: vi.fn() })
  render(<Jobs />)
  expect(screen.getByRole('status')).toBeInTheDocument()
})

test('shows error state with retry when no jobs and error', () => {
  const refresh = vi.fn()
  useNavigate.mockReturnValue(vi.fn())
  useJobs.mockReturnValue({ jobs: [], count: 0, loading: false, error: new Error('net'), refresh })
  render(<Jobs />)
  expect(screen.getByRole('alert')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /retry/i }))
  expect(refresh).toHaveBeenCalled()
})

test('shows job rows with textContent only (RC6)', () => {
  useNavigate.mockReturnValue(vi.fn())
  useJobs.mockReturnValue({ jobs: JOBS, count: 2, loading: false, error: null, refresh: vi.fn() })
  const { container } = render(<Jobs />)
  expect(screen.getByText('job-aaa')).toBeInTheDocument()
  expect(screen.getByText('job-bbb')).toBeInTheDocument()
  expect(container.querySelector('[data-status="running"]')).toBeInTheDocument()
})

test('shows empty state when no jobs and not loading', () => {
  useNavigate.mockReturnValue(vi.fn())
  useJobs.mockReturnValue({ jobs: [], count: 0, loading: false, error: null, refresh: vi.fn() })
  render(<Jobs />)
  expect(screen.getByText(/no jobs found/i)).toBeInTheDocument()
})

test('status filter change updates hook args', () => {
  useNavigate.mockReturnValue(vi.fn())
  useJobs.mockReturnValue({ jobs: [], count: 0, loading: false, error: null, refresh: vi.fn() })
  render(<Jobs />)
  expect(useJobs.mock.calls[0][0]).toMatchObject({ status: undefined })
  fireEvent.change(screen.getByLabelText(/status/i), { target: { value: 'running' } })
  const lastCall = useJobs.mock.calls[useJobs.mock.calls.length - 1]
  expect(lastCall[0]).toMatchObject({ status: 'running' })
})

test('search filters job IDs client-side', () => {
  useNavigate.mockReturnValue(vi.fn())
  useJobs.mockReturnValue({ jobs: JOBS, count: 2, loading: false, error: null, refresh: vi.fn() })
  render(<Jobs />)
  fireEvent.change(screen.getByLabelText(/search/i), { target: { value: 'aaa' } })
  expect(screen.getByText('job-aaa')).toBeInTheDocument()
  expect(screen.queryByText('job-bbb')).not.toBeInTheDocument()
})

test('clicking job ID navigates to /jobs/:id', () => {
  const navigate = vi.fn()
  useNavigate.mockReturnValue(navigate)
  useJobs.mockReturnValue({ jobs: JOBS, count: 2, loading: false, error: null, refresh: vi.fn() })
  render(<Jobs />)
  fireEvent.click(screen.getByText('job-aaa'))
  expect(navigate).toHaveBeenCalledWith('/jobs/job-aaa')
})

test('shows inline error when error but jobs available', () => {
  const refresh = vi.fn()
  useNavigate.mockReturnValue(vi.fn())
  useJobs.mockReturnValue({ jobs: JOBS, count: 2, loading: false, error: new Error('stale'), refresh })
  render(<Jobs />)
  expect(screen.getByRole('alert')).toBeInTheDocument()
  expect(screen.getByText('job-aaa')).toBeInTheDocument()
})

test('shows load more button when count exceeds limit', () => {
  useNavigate.mockReturnValue(vi.fn())
  useJobs.mockReturnValue({ jobs: JOBS, count: 30, loading: false, error: null, refresh: vi.fn() })
  render(<Jobs />)
  expect(screen.getByRole('button', { name: /load more/i })).toBeInTheDocument()
})

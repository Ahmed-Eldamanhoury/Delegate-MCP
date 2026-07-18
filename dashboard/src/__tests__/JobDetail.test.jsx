import { vi, test, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import JobDetail from '../screens/JobDetail'

vi.mock('../hooks/useJobSubscription.js', () => ({ useJobSubscription: vi.fn() }))
vi.mock('../lib/client.js', () => ({ apiFetch: vi.fn() }))
vi.mock('react-router-dom', () => ({ useParams: vi.fn(), useNavigate: vi.fn() }))
import { useJobSubscription } from '../hooks/useJobSubscription.js'
import { apiFetch } from '../lib/client.js'
import { useParams, useNavigate } from 'react-router-dom'

const JOB = {
  id: 'test-job-123',
  status: 'running',
  phase: 'executing',
  progressMessage: 'Executing claude CLI',
  metadata: { model: 'sonnet' },
  queuedAt: '2024-01-01T10:00:00Z',
  startedAt: '2024-01-01T10:01:00Z',
  finishedAt: null,
  runtimeMs: 5000,
  exitCode: null,
  error: null,
  result: null,
}

beforeEach(() => {
  useParams.mockReturnValue({ id: 'test-job-123' })
  useNavigate.mockReturnValue(vi.fn())
})
afterEach(() => vi.clearAllMocks())

test('shows loading state when no job yet', () => {
  useJobSubscription.mockReturnValue({ job: null, loading: true, error: null })
  render(<JobDetail />)
  expect(screen.getByRole('status')).toBeInTheDocument()
})

test('shows error state with back button when no job and error', () => {
  const navigate = vi.fn()
  useNavigate.mockReturnValue(navigate)
  useJobSubscription.mockReturnValue({ job: null, loading: false, error: new Error('not found') })
  render(<JobDetail />)
  expect(screen.getByRole('alert')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /back to jobs/i }))
  expect(navigate).toHaveBeenCalledWith('/jobs')
})

test('shows job fields as textContent (RC6)', () => {
  useJobSubscription.mockReturnValue({ job: JOB, loading: false, error: null })
  render(<JobDetail />)
  expect(screen.getByTestId('job-status')).toHaveTextContent('running')
  expect(screen.getByTestId('job-id')).toHaveTextContent('test-job-123')
})

test('shows cancel button for non-terminal job', () => {
  useJobSubscription.mockReturnValue({ job: JOB, loading: false, error: null })
  render(<JobDetail />)
  expect(screen.getByRole('button', { name: /cancel job/i })).toBeInTheDocument()
})

test('cancel button calls DELETE /v1/jobs/:id', async () => {
  apiFetch.mockResolvedValue({ job_id: 'test-job-123', status: 'cancelled' })
  useJobSubscription.mockReturnValue({ job: JOB, loading: false, error: null })
  render(<JobDetail />)
  fireEvent.click(screen.getByRole('button', { name: /cancel job/i }))
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/v1/jobs/test-job-123', { method: 'DELETE' }))
})

test('does not show cancel button for terminal job', () => {
  const done = { ...JOB, status: 'completed', phase: 'completed', finishedAt: '2024-01-01T10:02:00Z' }
  useJobSubscription.mockReturnValue({ job: done, loading: false, error: null })
  render(<JobDetail />)
  expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument()
})

test('back button navigates to /jobs', () => {
  const navigate = vi.fn()
  useNavigate.mockReturnValue(navigate)
  useJobSubscription.mockReturnValue({ job: JOB, loading: false, error: null })
  render(<JobDetail />)
  fireEvent.click(screen.getByRole('button', { name: /back to jobs/i }))
  expect(navigate).toHaveBeenCalledWith('/jobs')
})

test('shows Load Replay button', () => {
  useJobSubscription.mockReturnValue({ job: JOB, loading: false, error: null })
  render(<JobDetail />)
  expect(screen.getByRole('button', { name: /load replay/i })).toBeInTheDocument()
})

test('Load Replay calls GET /v1/jobs/:id/replay', async () => {
  apiFetch.mockResolvedValue({ source: 'unavailable', timeline: [] })
  useJobSubscription.mockReturnValue({ job: JOB, loading: false, error: null })
  render(<JobDetail />)
  fireEvent.click(screen.getByRole('button', { name: /load replay/i }))
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/v1/jobs/test-job-123/replay'))
})

test('shows timeline entries after replay loads', async () => {
  apiFetch.mockResolvedValue({
    source: 'durable',
    timeline: [
      { eventId: 'e1', timestamp: '2024-01-01T10:00:00Z', type: 'JobQueued', payload: {} },
      { eventId: 'e2', timestamp: '2024-01-01T10:01:00Z', type: 'JobStateChanged', payload: { to: 'running' } },
    ],
  })
  useJobSubscription.mockReturnValue({ job: JOB, loading: false, error: null })
  render(<JobDetail />)
  fireEvent.click(screen.getByRole('button', { name: /load replay/i }))
  await waitFor(() => expect(screen.getByText('JobQueued')).toBeInTheDocument())
  expect(screen.getByText('JobStateChanged')).toBeInTheDocument()
})

test('shows unavailable message when source is unavailable', async () => {
  apiFetch.mockResolvedValue({ source: 'unavailable', timeline: [] })
  useJobSubscription.mockReturnValue({ job: JOB, loading: false, error: null })
  render(<JobDetail />)
  fireEvent.click(screen.getByRole('button', { name: /load replay/i }))
  await waitFor(() => expect(screen.getByText(/no replay data/i)).toBeInTheDocument())
})

test('shows poll error banner with stale data', () => {
  useJobSubscription.mockReturnValue({ job: JOB, loading: false, error: new Error('network') })
  render(<JobDetail />)
  expect(screen.getByRole('alert')).toBeInTheDocument()
})

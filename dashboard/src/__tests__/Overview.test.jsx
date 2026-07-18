import { vi, test, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import Overview from '../screens/Overview'

vi.mock('../hooks/useSnapshot.js', () => ({ useSnapshot: vi.fn() }))
vi.mock('../lib/client.js', () => ({ apiFetch: vi.fn() }))
import { useSnapshot } from '../hooks/useSnapshot.js'
import { apiFetch } from '../lib/client.js'

const MODELS = {
  models: [{ model: 'sonnet', fallback: null }],
  efforts: ['low', 'medium', 'high'],
  defaults: { model: 'sonnet', effort: 'low', maxBudgetUsd: 1 },
}

const SNAPSHOT = {
  takenAt: '2024-01-01T12:00:00.000Z',
  metrics: {
    queuedJobs: 2, runningJobs: 1, completedJobs: 5, failedJobs: 1, cancelledJobs: 0,
    averageRuntimeMs: 3000, averageQueueWaitMs: 500, maximumRuntimeMs: 8000,
    eventCount: 100, progressRate: 2.5, streamingEvents: 50, outputChunks: 30,
    workspaceSizeBytes: null, artifactCount: null,
  },
  activeJobs: [
    { jobId: 'abc-123', status: 'running', queuedAt: '2024-01-01T11:55:00.000Z', startedAt: '2024-01-01T11:56:00.000Z' },
  ],
}

beforeEach(() => {
  apiFetch.mockResolvedValue(MODELS)
})
afterEach(() => vi.clearAllMocks())

test('shows loading indicator when no snapshot and loading', () => {
  useSnapshot.mockReturnValue({ snapshot: null, loading: true, error: null, refresh: vi.fn() })
  render(<Overview />)
  expect(screen.getByRole('status')).toBeInTheDocument()
})

test('shows error state with retry button when no snapshot and error', () => {
  const refresh = vi.fn()
  useSnapshot.mockReturnValue({ snapshot: null, loading: false, error: new Error('net'), refresh })
  render(<Overview />)
  expect(screen.getByRole('alert')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /retry/i }))
  expect(refresh).toHaveBeenCalledOnce()
})

test('shows KPI values from snapshot metrics', () => {
  useSnapshot.mockReturnValue({ snapshot: SNAPSHOT, loading: false, error: null, refresh: vi.fn() })
  render(<Overview />)
  expect(screen.getByTestId('kpi-queued')).toHaveTextContent('2')
  expect(screen.getByTestId('kpi-running')).toHaveTextContent('1')
  expect(screen.getByTestId('kpi-completed')).toHaveTextContent('5')
  expect(screen.getByTestId('kpi-failed')).toHaveTextContent('1')
  expect(screen.getByTestId('kpi-cancelled')).toHaveTextContent('0')
})

test('shows active job rows using textContent only (RC6)', () => {
  useSnapshot.mockReturnValue({ snapshot: SNAPSHOT, loading: false, error: null, refresh: vi.fn() })
  render(<Overview />)
  expect(screen.getByText('abc-123')).toBeInTheDocument()
  expect(screen.getByText('running')).toBeInTheDocument()
})

test('shows empty message when no active jobs', () => {
  const snap = { ...SNAPSHOT, activeJobs: [] }
  useSnapshot.mockReturnValue({ snapshot: snap, loading: false, error: null, refresh: vi.fn() })
  render(<Overview />)
  expect(screen.getByText(/no active jobs/i)).toBeInTheDocument()
})

test('shows empty-state notice when all job counts are zero', () => {
  const emptyMetrics = { ...SNAPSHOT.metrics, queuedJobs: 0, runningJobs: 0, completedJobs: 0, failedJobs: 0, cancelledJobs: 0 }
  const snap = { ...SNAPSHOT, metrics: emptyMetrics, activeJobs: [] }
  useSnapshot.mockReturnValue({ snapshot: snap, loading: false, error: null, refresh: vi.fn() })
  render(<Overview />)
  expect(screen.getByText(/no jobs recorded/i)).toBeInTheDocument()
})

test('shows inline error alert with retry while displaying stale data', () => {
  const refresh = vi.fn()
  useSnapshot.mockReturnValue({ snapshot: SNAPSHOT, loading: false, error: new Error('stale'), refresh })
  render(<Overview />)
  expect(screen.getByRole('alert')).toBeInTheDocument()
  expect(screen.getByTestId('kpi-completed')).toHaveTextContent('5')
  fireEvent.click(screen.getByRole('button', { name: /retry/i }))
  expect(refresh).toHaveBeenCalled()
})

test('shows model defaults after models fetch resolves', async () => {
  useSnapshot.mockReturnValue({ snapshot: SNAPSHOT, loading: false, error: null, refresh: vi.fn() })
  render(<Overview />)
  await waitFor(() => expect(screen.getByTestId('models-default-model')).toHaveTextContent('sonnet'))
})

test('event count visible in health section', () => {
  useSnapshot.mockReturnValue({ snapshot: SNAPSHOT, loading: false, error: null, refresh: vi.fn() })
  render(<Overview />)
  expect(screen.getByTestId('health-event-count')).toHaveTextContent('100')
})

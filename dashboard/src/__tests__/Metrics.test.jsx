import { vi, test, expect, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import Metrics from '../screens/Metrics'

vi.mock('../hooks/useMetrics.js', () => ({ useMetrics: vi.fn() }))
import { useMetrics } from '../hooks/useMetrics.js'

const METRICS = {
  queuedJobs: 1, runningJobs: 2, completedJobs: 10, failedJobs: 3, cancelledJobs: 1,
  averageRuntimeMs: 5000, maximumRuntimeMs: 30000, averageQueueWaitMs: 100,
  progressRate: 0.95, streamingEvents: 500, outputChunks: 200, eventCount: 1500,
  workspaceSizeBytes: null, artifactCount: null,
}

afterEach(() => vi.clearAllMocks())

test('shows loading state', () => {
  useMetrics.mockReturnValue({ metrics: null, loading: true, error: null, refresh: vi.fn() })
  render(<Metrics />)
  expect(screen.getByRole('status')).toBeInTheDocument()
})

test('shows error state with retry button', () => {
  const refresh = vi.fn()
  useMetrics.mockReturnValue({ metrics: null, loading: false, error: new Error('net'), refresh })
  render(<Metrics />)
  expect(screen.getByRole('alert')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /retry/i }))
  expect(refresh).toHaveBeenCalled()
})

test('shows job count KPIs', () => {
  useMetrics.mockReturnValue({ metrics: METRICS, loading: false, error: null, refresh: vi.fn() })
  render(<Metrics />)
  expect(screen.getByTestId('metric-completed')).toHaveTextContent('10')
  expect(screen.getByTestId('metric-failed')).toHaveTextContent('3')
  expect(screen.getByTestId('metric-running')).toHaveTextContent('2')
})

test('shows runtime stats', () => {
  useMetrics.mockReturnValue({ metrics: METRICS, loading: false, error: null, refresh: vi.fn() })
  render(<Metrics />)
  expect(screen.getByTestId('metric-avg-runtime')).toBeInTheDocument()
  expect(screen.getByTestId('metric-max-runtime')).toBeInTheDocument()
})

test('shows empty state when no activity', () => {
  const zero = { ...METRICS, queuedJobs: 0, runningJobs: 0, completedJobs: 0, failedJobs: 0, cancelledJobs: 0, eventCount: 0 }
  useMetrics.mockReturnValue({ metrics: zero, loading: false, error: null, refresh: vi.fn() })
  render(<Metrics />)
  expect(screen.getByText(/no metrics/i)).toBeInTheDocument()
})

test('shows event count', () => {
  useMetrics.mockReturnValue({ metrics: METRICS, loading: false, error: null, refresh: vi.fn() })
  render(<Metrics />)
  expect(screen.getByTestId('metric-events')).toHaveTextContent('1500')
})

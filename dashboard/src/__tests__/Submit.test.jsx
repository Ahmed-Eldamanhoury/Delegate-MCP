import { vi, test, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import Submit from '../screens/Submit'

vi.mock('../lib/client.js', () => ({ apiFetch: vi.fn() }))
vi.mock('react-router-dom', () => ({ useNavigate: vi.fn() }))
import { apiFetch } from '../lib/client.js'
import { useNavigate } from 'react-router-dom'

afterEach(() => vi.clearAllMocks())

test('renders prompt textarea', () => {
  useNavigate.mockReturnValue(vi.fn())
  render(<Submit />)
  expect(screen.getByLabelText(/prompt/i)).toBeInTheDocument()
})

test('renders model selector with options', () => {
  useNavigate.mockReturnValue(vi.fn())
  render(<Submit />)
  expect(screen.getByLabelText(/model/i)).toBeInTheDocument()
  expect(screen.getByRole('option', { name: 'sonnet' })).toBeInTheDocument()
})

test('renders effort selector with options', () => {
  useNavigate.mockReturnValue(vi.fn())
  render(<Submit />)
  expect(screen.getByLabelText(/effort/i)).toBeInTheDocument()
  expect(screen.getByRole('option', { name: 'low' })).toBeInTheDocument()
})

test('renders budget input', () => {
  useNavigate.mockReturnValue(vi.fn())
  render(<Submit />)
  expect(screen.getByLabelText(/budget/i)).toBeInTheDocument()
})

test('validates empty prompt on submit — no API call', () => {
  useNavigate.mockReturnValue(vi.fn())
  render(<Submit />)
  fireEvent.click(screen.getByRole('button', { name: /submit job/i }))
  expect(screen.getByRole('alert')).toBeInTheDocument()
  expect(apiFetch).not.toHaveBeenCalled()
})

test('submits form and calls POST /v1/jobs with prompt', async () => {
  useNavigate.mockReturnValue(vi.fn())
  apiFetch.mockResolvedValue({ job_id: 'job-abc', status: 'queued' })
  render(<Submit />)
  fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: 'Do a task' } })
  fireEvent.click(screen.getByRole('button', { name: /submit job/i }))
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/v1/jobs', expect.objectContaining({
    method: 'POST',
    body: expect.stringContaining('"Do a task"'),
  })))
})

test('navigates to job detail on success', async () => {
  const navigate = vi.fn()
  useNavigate.mockReturnValue(navigate)
  apiFetch.mockResolvedValue({ job_id: 'job-abc', status: 'queued' })
  render(<Submit />)
  fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: 'Do a task' } })
  fireEvent.click(screen.getByRole('button', { name: /submit job/i }))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/jobs/job-abc'))
})

test('shows error alert on API failure', async () => {
  useNavigate.mockReturnValue(vi.fn())
  apiFetch.mockRejectedValue(new Error('Network error'))
  render(<Submit />)
  fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: 'Do a task' } })
  fireEvent.click(screen.getByRole('button', { name: /submit job/i }))
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
})

test('retry button re-submits and succeeds', async () => {
  const navigate = vi.fn()
  useNavigate.mockReturnValue(navigate)
  apiFetch
    .mockRejectedValueOnce(new Error('Network error'))
    .mockResolvedValue({ job_id: 'job-abc', status: 'queued' })
  render(<Submit />)
  fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: 'Do a task' } })
  fireEvent.click(screen.getByRole('button', { name: /submit job/i }))
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: /retry/i }))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/jobs/job-abc'))
})

test('disables submit button while submitting', async () => {
  const navigate = vi.fn()
  useNavigate.mockReturnValue(navigate)
  let resolve
  apiFetch.mockReturnValue(new Promise(r => { resolve = r }))
  render(<Submit />)
  fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: 'Do a task' } })
  fireEvent.click(screen.getByRole('button', { name: /submit job/i }))
  await waitFor(() => expect(screen.getByRole('button', { name: /submit job/i })).toBeDisabled())
  resolve({ job_id: 'job-abc', status: 'queued' })
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/jobs/job-abc'))
})

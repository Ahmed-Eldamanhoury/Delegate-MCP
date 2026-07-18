import { vi, test, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import Models from '../screens/Models'

vi.mock('../lib/client.js', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '../lib/client.js'

const MODELS_DATA = {
  models: [
    { model: 'haiku', fallback: null },
    { model: 'sonnet', fallback: null },
    { model: 'opus', fallback: 'sonnet' },
    { model: 'fable', fallback: null },
  ],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaults: { model: 'sonnet', effort: 'low', maxBudgetUsd: 5 },
}

afterEach(() => vi.clearAllMocks())

test('shows loading state initially', () => {
  apiFetch.mockReturnValue(new Promise(() => {}))
  render(<Models />)
  expect(screen.getByRole('status')).toBeInTheDocument()
})

test('shows error state with retry button', async () => {
  apiFetch.mockRejectedValue(new Error('net'))
  render(<Models />)
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: /retry/i }))
  expect(apiFetch).toHaveBeenCalledTimes(2)
})

test('shows model list after loading', async () => {
  apiFetch.mockResolvedValue(MODELS_DATA)
  render(<Models />)
  await waitFor(() => expect(screen.getByTestId('model-haiku')).toBeInTheDocument())
  expect(screen.getByTestId('model-sonnet')).toBeInTheDocument()
  expect(screen.getByTestId('model-opus')).toBeInTheDocument()
})

test('shows default model and effort', async () => {
  apiFetch.mockResolvedValue(MODELS_DATA)
  render(<Models />)
  await waitFor(() => expect(screen.getByTestId('default-model')).toHaveTextContent('sonnet'))
  expect(screen.getByTestId('default-effort')).toHaveTextContent('low')
})

test('shows effort presets from API', async () => {
  apiFetch.mockResolvedValue(MODELS_DATA)
  render(<Models />)
  await waitFor(() => expect(screen.getByText('xhigh')).toBeInTheDocument())
})

test('filters models by search input', async () => {
  apiFetch.mockResolvedValue(MODELS_DATA)
  render(<Models />)
  await waitFor(() => screen.getByTestId('model-haiku'))
  fireEvent.change(screen.getByLabelText(/search/i), { target: { value: 'opus' } })
  expect(screen.queryByTestId('model-haiku')).not.toBeInTheDocument()
  expect(screen.getByTestId('model-opus')).toBeInTheDocument()
})

test('shows fallback model for opus', async () => {
  apiFetch.mockResolvedValue(MODELS_DATA)
  render(<Models />)
  await waitFor(() => screen.getByTestId('model-opus'))
  expect(screen.getByTestId('model-opus')).toHaveTextContent('sonnet')
})

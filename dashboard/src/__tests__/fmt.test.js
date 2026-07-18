import { test, expect } from 'vitest'
import { fmtMs } from '../lib/fmt.js'

test('returns — for null', () => { expect(fmtMs(null)).toBe('—') })
test('returns — for undefined', () => { expect(fmtMs(undefined)).toBe('—') })
test('formats ms under 1000 as ms', () => { expect(fmtMs(500)).toBe('500ms') })
test('formats exactly 1000ms as 1.0s', () => { expect(fmtMs(1000)).toBe('1.0s') })
test('formats over 1000ms as seconds', () => { expect(fmtMs(2500)).toBe('2.5s') })

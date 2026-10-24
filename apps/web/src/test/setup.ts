import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: vi.fn(),
})

if (!document.elementFromPoint) document.elementFromPoint = () => document.body
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect()

import { describe, expect, it } from 'vitest'
import { formatCountdown, remainingSeconds } from '../payment-test'

describe('payment test page helpers', () => {
  it('formats a five minute countdown', () => {
    expect(formatCountdown(300)).toBe('05:00')
    expect(formatCountdown(9)).toBe('00:09')
  })

  it('does not return negative remaining time', () => {
    expect(remainingSeconds(new Date(Date.now() - 1_000).toISOString())).toBe(0)
  })
})

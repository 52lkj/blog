import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { formatCountdown, PaymentTestPage, remainingSeconds } from '../payment-test'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('payment test page helpers', () => {
  it('formats a five minute countdown', () => {
    expect(formatCountdown(300)).toBe('05:00')
    expect(formatCountdown(9)).toBe('00:09')
  })

  it('does not return negative remaining time', () => {
    expect(remainingSeconds(new Date(Date.now() - 1_000).toISOString())).toBe(0)
  })

  it('sends a valid JSON body when creating an order', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        product: { id: 'alimpay-test-001', name: 'AliMPay 支付测试商品', price: '0.01', currency: 'CNY' },
        orderNo: 'SGTESTORDER',
        tradeNo: 'PLATFORMORDER',
        requestedAmount: '0.01',
        payableAmount: '0.02',
        qrPayload: 'https://qr.alipay.com/test',
        collectionMode: 'business_qr',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        status: 'pending',
        pollIntervalSeconds: 5,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    globalThis.fetch = fetchMock

    render(<PaymentTestPage />)
    expect(await screen.findByText('AliMPay 支付测试商品')).toBeInTheDocument()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][1]?.body).toBe('{}')
  })
})

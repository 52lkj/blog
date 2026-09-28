import { useEffect, useRef, useState } from 'react'
import { Helmet } from 'react-helmet'
import { QRCodeSVG } from 'qrcode.react'
import { endpoint } from '../config'
import './payment-test.css'

type PaymentStatus = 'loading' | 'pending' | 'paid' | 'expired' | 'error'

interface PaymentOrder {
  product: { id: string; name: string; price: string; currency: string }
  orderNo: string
  tradeNo: string
  requestedAmount: string
  payableAmount: string
  qrPayload: string
  collectionMode: 'business_qr' | 'transfer'
  expiresAt: string
  status: 'pending' | 'expired' | 'paid' | 'late_paid'
  pollIntervalSeconds: number
}

interface ApiResult<T> {
  success: boolean
  data?: T
  error?: { message?: string }
}

export async function requestPayment<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${endpoint}/api/payment${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const result = await response.json() as ApiResult<T>
  if (!response.ok || !result.success || !result.data) {
    throw new Error(result.error?.message || '支付服务暂时不可用')
  }
  return result.data
}

function remainingSeconds(expiresAt: string): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000))
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0')
  const rest = (seconds % 60).toString().padStart(2, '0')
  return `${minutes}:${rest}`
}

export function PaymentTestPage() {
  const started = useRef(false)
  const [order, setOrder] = useState<PaymentOrder | null>(null)
  const [status, setStatus] = useState<PaymentStatus>('loading')
  const [remaining, setRemaining] = useState(300)
  const [error, setError] = useState('')

  const createOrder = async () => {
    setStatus('loading')
    setError('')
    setOrder(null)
    try {
      const created = await requestPayment<PaymentOrder>('/test/create', {})
      setOrder(created)
      setRemaining(remainingSeconds(created.expiresAt))
      setStatus(created.status === 'paid' || created.status === 'late_paid' ? 'paid' : created.status)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '支付服务暂时不可用')
      setStatus('error')
    }
  }

  useEffect(() => {
    if (started.current) return
    started.current = true
    void createOrder()
  }, [])

  useEffect(() => {
    if (!order || status !== 'pending') return
    const update = () => {
      const seconds = remainingSeconds(order.expiresAt)
      setRemaining(seconds)
      if (seconds === 0) setStatus('expired')
    }
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [order, status])

  useEffect(() => {
    if (!order || status !== 'pending') return
    const query = async () => {
      try {
        const result = await requestPayment<{ status: 'pending' | 'paid' }>('/test/query', {
          orderNo: order.orderNo,
          tradeNo: order.tradeNo,
        })
        if (result.status === 'paid') setStatus('paid')
      } catch {
        // A transient query failure should not invalidate an active QR code.
      }
    }
    const timer = window.setInterval(() => void query(), order.pollIntervalSeconds * 1000)
    return () => window.clearInterval(timer)
  }, [order, status])

  return (
    <main className="payment-page">
      <Helmet>
        <title>支付宝测试支付</title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <header className="payment-header">
        <div className="payment-brand" aria-label="支付宝支付">
          <span className="payment-brand-mark">支</span>
          <span>支付宝</span>
        </div>
        <span className="payment-header-label">安全支付</span>
      </header>

      <section className="payment-shell" aria-live="polite">
        {status === 'loading' && (
          <div className="payment-state">
            <span className="payment-spinner" aria-hidden="true" />
            <h1>正在创建真实订单</h1>
            <p>请稍候</p>
          </div>
        )}

        {status === 'error' && (
          <div className="payment-state payment-error">
            <span className="ri-error-warning-line payment-state-icon" aria-hidden="true" />
            <h1>订单创建失败</h1>
            <p>{error}</p>
            <button type="button" className="payment-button" onClick={() => void createOrder()}>
              <span className="ri-refresh-line" aria-hidden="true" />重新创建
            </button>
          </div>
        )}

        {order && status !== 'loading' && status !== 'error' && (
          <>
            <div className="payment-order-heading">
              <p className="payment-product">{order.product.name}</p>
              <h1><span>¥</span>{order.payableAmount}</h1>
              {order.payableAmount !== order.requestedAmount && (
                <p className="payment-adjustment">请按页面金额准确支付，原测试价 ¥{order.requestedAmount}</p>
              )}
            </div>

            {status === 'pending' && (
              <>
                <div className="payment-qr-frame">
                  <QRCodeSVG
                    value={order.qrPayload}
                    size={236}
                    level="H"
                    marginSize={1}
                    bgColor="#ffffff"
                    fgColor="#111111"
                    title="支付宝支付二维码"
                  />
                </div>
                <p className="payment-instruction">
                  <span className="ri-scan-2-line" aria-hidden="true" />
                  请使用支付宝扫一扫
                </p>
                {order.collectionMode === 'business_qr' && (
                  <p className="payment-business-note">扫码后手动输入 <strong>¥{order.payableAmount}</strong>，金额必须完全一致</p>
                )}
                <div className="payment-countdown">
                  支付码将在 <strong>{formatCountdown(remaining)}</strong> 后失效
                </div>
              </>
            )}

            {status === 'paid' && (
              <div className="payment-state payment-success">
                <span className="ri-checkbox-circle-line payment-state-icon" aria-hidden="true" />
                <h2>支付成功</h2>
                <p>订单已确认到账</p>
              </div>
            )}

            {status === 'expired' && (
              <div className="payment-state payment-error">
                <span className="ri-time-line payment-state-icon" aria-hidden="true" />
                <h2>支付码已失效</h2>
                <p>请重新创建订单，不要继续支付旧订单。</p>
                <button type="button" className="payment-button" onClick={() => void createOrder()}>
                  <span className="ri-refresh-line" aria-hidden="true" />重新创建
                </button>
              </div>
            )}

            <div className="payment-meta">
              <span>订单号</span>
              <code>{order.orderNo}</code>
            </div>
          </>
        )}
      </section>

      <footer className="payment-footer">
        <span className="ri-shield-check-line" aria-hidden="true" />支付信息由 AliMPay 安全处理
      </footer>
    </main>
  )
}

export { formatCountdown, remainingSeconds }

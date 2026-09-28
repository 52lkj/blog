import { Router } from '../core/router';
import type { Context } from '../core/types';
import { BadRequestError, ServiceUnavailableError } from '../errors';
import {
    signAliMPayParameters,
    verifyAliMPaySignature,
    type AliMPayParameters,
} from '../utils/alimpay';

export const TEST_PRODUCT = Object.freeze({
    id: 'alimpay-test-001',
    name: 'AliMPay 支付测试商品',
    price: '0.01',
    currency: 'CNY',
});

const DEFAULT_BASE_URL = 'https://pay.qlily13.cn';
const DEFAULT_PID = '2142742862';
const DEFAULT_BUSINESS_QR_PAYLOAD = 'https://qr.alipay.com/2m613387crwspa4bkf0yu26';
const TEST_ORDER_PREFIX = 'SGTEST';

type PaymentEnv = Env & {
    ALIMPAY_BASE_URL?: string;
    ALIMPAY_PID?: string;
    ALIMPAY_MERCHANT_PRIVATE_KEY?: string;
    ALIMPAY_PLATFORM_PUBLIC_KEY?: string;
    ALIMPAY_BUSINESS_QR_PAYLOAD?: string;
};

interface AliMPayCreateResponse extends Record<string, unknown> {
    code: number;
    msg: string;
    trade_no?: string;
    pay_type?: string;
    pay_info?: string;
    timestamp?: string;
    sign?: string;
    sign_type?: string;
}

interface AliMPayQueryResponse extends Record<string, unknown> {
    code: number;
    msg: string;
    trade_no?: string;
    out_trade_no?: string;
    name?: string;
    money?: string;
    status?: number;
    timestamp?: string;
    sign?: string;
    sign_type?: string;
}

interface CheckoutResponse {
    trade_no: string;
    out_trade_no: string;
    name: string;
    requested_money: string;
    payable_money: string;
    collection_mode: 'business_qr' | 'transfer';
    status: 'pending' | 'expired' | 'paid' | 'late_paid';
    expires_at: string;
    payment_poll_interval_seconds: number;
    payment_uri: string;
}

function paymentEnv(ctx: Context): PaymentEnv {
    return ctx.env as PaymentEnv;
}

function requireValue(value: string | undefined, name: string): string {
    if (!value?.trim()) {
        throw new ServiceUnavailableError(`AliMPay is not configured: ${name} is missing`);
    }
    return value.trim();
}

function createOrderNumber(): string {
    const time = Date.now().toString(36).toUpperCase();
    const random = crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase();
    return `${TEST_ORDER_PREFIX}${time}${random}`;
}

function clientIp(ctx: Context): string {
    return ctx.headers['cf-connecting-ip']
        || ctx.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || '127.0.0.1';
}

function callbackUrl(ctx: Context, path: 'notify' | 'return'): string {
    return new URL(`/api/payment/${path}`, ctx.url.origin).toString();
}

function queryToParameters(query: Record<string, unknown>): AliMPayParameters {
    return query as AliMPayParameters;
}

function scalarParameters(value: Record<string, unknown>): AliMPayParameters {
    const parameters: AliMPayParameters = {};
    for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item == null) {
            parameters[key] = item;
        }
    }
    return parameters;
}

function toForm(parameters: AliMPayParameters, sign: string): URLSearchParams {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(parameters)) {
        if (value !== undefined && value !== null && value !== '' && !Array.isArray(value) && !(value instanceof Blob)) {
            form.set(key, String(value));
        }
    }
    form.set('sign', sign);
    form.set('sign_type', 'RSA');
    return form;
}

async function postSigned<T extends Record<string, unknown>>(
    path: string,
    parameters: AliMPayParameters,
    env: PaymentEnv,
): Promise<T> {
    const privateKey = requireValue(env.ALIMPAY_MERCHANT_PRIVATE_KEY, 'ALIMPAY_MERCHANT_PRIVATE_KEY');
    const publicKey = requireValue(env.ALIMPAY_PLATFORM_PUBLIC_KEY, 'ALIMPAY_PLATFORM_PUBLIC_KEY');
    const baseUrl = env.ALIMPAY_BASE_URL?.trim() || DEFAULT_BASE_URL;
    const sign = await signAliMPayParameters(parameters, privateKey);

    let response: Response;
    try {
        response = await fetch(new URL(path, baseUrl), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                Accept: 'application/json',
            },
            body: toForm(parameters, sign),
            signal: AbortSignal.timeout(10_000),
        });
    } catch {
        throw new ServiceUnavailableError('AliMPay request failed');
    }

    let result: T;
    try {
        result = await response.json() as T;
    } catch {
        throw new ServiceUnavailableError('AliMPay returned an invalid response');
    }

    const resultSign = typeof result.sign === 'string' ? result.sign : '';
    if (!resultSign || result.sign_type !== 'RSA'
        || !(await verifyAliMPaySignature(scalarParameters(result), resultSign, publicKey))) {
        throw new ServiceUnavailableError('AliMPay response signature is invalid');
    }
    if (!response.ok || Number(result.code) !== 0) {
        throw new ServiceUnavailableError(typeof result.msg === 'string' ? result.msg : 'AliMPay request failed');
    }
    return result;
}

function checkoutToken(paymentUrl: string, baseUrl: string): string {
    const url = new URL(paymentUrl);
    const expected = new URL(baseUrl);
    if (url.origin !== expected.origin) throw new ServiceUnavailableError('AliMPay returned an invalid checkout URL');
    const match = url.pathname.match(/^\/checkout\/([^/]+)$/);
    if (!match) throw new ServiceUnavailableError('AliMPay returned an invalid checkout URL');
    return decodeURIComponent(match[1]);
}

async function getCheckout(paymentUrl: string, baseUrl: string): Promise<CheckoutResponse> {
    const token = checkoutToken(paymentUrl, baseUrl);
    let response: Response;
    try {
        response = await fetch(new URL(`/public-api/checkout/${encodeURIComponent(token)}`, baseUrl), {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(10_000),
        });
    } catch {
        throw new ServiceUnavailableError('AliMPay checkout request failed');
    }
    if (!response.ok) throw new ServiceUnavailableError('AliMPay checkout request failed');
    try {
        return await response.json() as CheckoutResponse;
    } catch {
        throw new ServiceUnavailableError('AliMPay returned invalid checkout data');
    }
}

function validateCheckout(checkout: CheckoutResponse, orderNo: string, tradeNo: string): void {
    const payable = Number(checkout.payable_money);
    if (checkout.out_trade_no !== orderNo
        || checkout.trade_no !== tradeNo
        || checkout.name !== TEST_PRODUCT.name
        || checkout.requested_money !== TEST_PRODUCT.price
        || !Number.isFinite(payable)
        || payable < Number(TEST_PRODUCT.price)
        || !checkout.expires_at) {
        throw new ServiceUnavailableError('AliMPay checkout data does not match the test order');
    }
}

async function verifyPaymentCallback(ctx: Context): Promise<void> {
    const env = paymentEnv(ctx);
    const publicKey = requireValue(env.ALIMPAY_PLATFORM_PUBLIC_KEY, 'ALIMPAY_PLATFORM_PUBLIC_KEY');
    const signature = typeof ctx.query.sign === 'string' ? ctx.query.sign : '';
    if (!signature || !(await verifyAliMPaySignature(queryToParameters(ctx.query), signature, publicKey))) {
        throw new BadRequestError('Invalid AliMPay signature');
    }

    const expectedPid = env.ALIMPAY_PID?.trim() || DEFAULT_PID;
    if (ctx.query.pid !== expectedPid
        || ctx.query.trade_status !== 'TRADE_SUCCESS'
        || ctx.query.money !== TEST_PRODUCT.price
        || ctx.query.name !== TEST_PRODUCT.name
        || typeof ctx.query.out_trade_no !== 'string'
        || !ctx.query.out_trade_no.startsWith(TEST_ORDER_PREFIX)) {
        throw new BadRequestError('AliMPay callback does not match the test order');
    }
}

export function PaymentService(router: Router): void {
    router.group('/payment', (group) => {
        group.post('/test/create', async (ctx: Context) => {
            const env = paymentEnv(ctx);
            const pid = env.ALIMPAY_PID?.trim() || DEFAULT_PID;
            const baseUrl = env.ALIMPAY_BASE_URL?.trim() || DEFAULT_BASE_URL;
            const orderNo = createOrderNumber();
            const parameters: AliMPayParameters = {
                pid,
                method: 'web',
                type: 'alipay',
                out_trade_no: orderNo,
                notify_url: callbackUrl(ctx, 'notify'),
                return_url: callbackUrl(ctx, 'return'),
                name: TEST_PRODUCT.name,
                money: TEST_PRODUCT.price,
                clientip: clientIp(ctx),
                timestamp: Math.floor(Date.now() / 1000),
            };
            const created = await postSigned<AliMPayCreateResponse>('/api/pay/create', parameters, env);
            if (typeof created.trade_no !== 'string'
                || typeof created.pay_type !== 'string'
                || typeof created.pay_info !== 'string') {
                throw new ServiceUnavailableError('AliMPay returned incomplete order data');
            }

            let payableAmount: string = TEST_PRODUCT.price;
            let expiresAt = new Date(Date.now() + 300_000).toISOString();
            let status = 'pending';
            let pollIntervalSeconds = 5;
            let qrPayload = created.pay_info;
            let collectionMode: 'business_qr' | 'transfer' = 'transfer';

            if (created.pay_type === 'jump') {
                const checkout = await getCheckout(created.pay_info, baseUrl);
                validateCheckout(checkout, orderNo, created.trade_no);
                payableAmount = checkout.payable_money;
                expiresAt = checkout.expires_at;
                status = checkout.status;
                pollIntervalSeconds = Math.min(60, Math.max(1, checkout.payment_poll_interval_seconds || 5));
                collectionMode = checkout.collection_mode;
                qrPayload = checkout.collection_mode === 'business_qr'
                    ? env.ALIMPAY_BUSINESS_QR_PAYLOAD?.trim() || DEFAULT_BUSINESS_QR_PAYLOAD
                    : checkout.payment_uri;
            }
            if (!qrPayload) throw new ServiceUnavailableError('AliMPay did not return a payment QR code');

            return {
                success: true,
                data: {
                    product: TEST_PRODUCT,
                    orderNo,
                    tradeNo: created.trade_no,
                    requestedAmount: TEST_PRODUCT.price,
                    payableAmount,
                    qrPayload,
                    collectionMode,
                    expiresAt,
                    status,
                    pollIntervalSeconds,
                },
            };
        });

        group.post('/test/query', async (ctx: Context) => {
            const orderNo = typeof ctx.body?.orderNo === 'string' ? ctx.body.orderNo : '';
            const tradeNo = typeof ctx.body?.tradeNo === 'string' ? ctx.body.tradeNo : '';
            if (!orderNo.startsWith(TEST_ORDER_PREFIX) || !tradeNo) {
                throw new BadRequestError('Invalid test order');
            }
            const env = paymentEnv(ctx);
            const parameters: AliMPayParameters = {
                pid: env.ALIMPAY_PID?.trim() || DEFAULT_PID,
                out_trade_no: orderNo,
                trade_no: tradeNo,
                timestamp: Math.floor(Date.now() / 1000),
            };
            const result = await postSigned<AliMPayQueryResponse>('/api/pay/query', parameters, env);
            if (result.out_trade_no !== orderNo
                || result.trade_no !== tradeNo
                || result.name !== TEST_PRODUCT.name
                || result.money !== TEST_PRODUCT.price) {
                throw new ServiceUnavailableError('AliMPay query data does not match the test order');
            }
            return {
                success: true,
                data: {
                    orderNo,
                    tradeNo,
                    status: Number(result.status) === 1 ? 'paid' : 'pending',
                },
            };
        });

        group.get('/notify', async (ctx: Context) => {
            await verifyPaymentCallback(ctx);
            return new Response('success', {
                status: 200,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            });
        });

        group.get('/return', async (ctx: Context) => {
            await verifyPaymentCallback(ctx);
            return {
                success: true,
                data: {
                    orderNo: ctx.query.out_trade_no,
                    product: TEST_PRODUCT,
                    tradeStatus: ctx.query.trade_status,
                },
            };
        });
    });
}

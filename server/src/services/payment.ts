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
const TEST_ORDER_PREFIX = 'SGTEST';

type PaymentEnv = Env & {
    ALIMPAY_BASE_URL?: string;
    ALIMPAY_PID?: string;
    ALIMPAY_MERCHANT_PRIVATE_KEY?: string;
    ALIMPAY_PLATFORM_PUBLIC_KEY?: string;
};

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
            const privateKey = requireValue(env.ALIMPAY_MERCHANT_PRIVATE_KEY, 'ALIMPAY_MERCHANT_PRIVATE_KEY');
            const pid = env.ALIMPAY_PID?.trim() || DEFAULT_PID;
            const baseUrl = env.ALIMPAY_BASE_URL?.trim() || DEFAULT_BASE_URL;
            const timestamp = Math.floor(Date.now() / 1000);
            const expiresAt = timestamp + 300;
            const orderNo = createOrderNumber();

            // Product name and amount are intentionally server-owned constants.
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
                timestamp,
            };
            const sign = await signAliMPayParameters(parameters, privateKey);
            const checkoutUrl = new URL('/api/pay/submit', baseUrl);
            const encoded = new URLSearchParams();
            for (const [key, value] of Object.entries(parameters)) {
                encoded.set(key, String(value));
            }
            encoded.set('sign', sign);
            encoded.set('sign_type', 'RSA');
            checkoutUrl.search = encoded.toString();

            return {
                success: true,
                data: {
                    product: TEST_PRODUCT,
                    orderNo,
                    paymentUrl: checkoutUrl.toString(),
                    expiresAt,
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

import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { createRouter } from '../../core/router';
import { PaymentService, TEST_PRODUCT } from '../payment';
import {
    canonicalizeAliMPayParameters,
    signAliMPayParameters,
    verifyAliMPaySignature,
    type AliMPayParameters,
} from '../../utils/alimpay';
import { createMockEnv } from '../../../tests/fixtures';

const originalFetch = globalThis.fetch;

function bytesToPem(bytes: ArrayBuffer, label: 'PRIVATE KEY' | 'PUBLIC KEY' | 'RSA PRIVATE KEY'): string {
    const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
    const lines = base64.match(/.{1,64}/g)?.join('\n') || '';
    return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

let merchantPrivateKey: string;
let merchantPkcs1PrivateKey: string;
let merchantPublicKey: string;
let platformPrivateKey: string;
let platformPublicKey: string;

beforeAll(async () => {
    const merchant = await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
    );
    const platform = await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
    );
    merchantPrivateKey = bytesToPem(await crypto.subtle.exportKey('pkcs8', merchant.privateKey), 'PRIVATE KEY');
    const merchantJwk = await crypto.subtle.exportKey('jwk', merchant.privateKey);
    merchantPkcs1PrivateKey = bytesToPem(jwkToPkcs1(merchantJwk), 'RSA PRIVATE KEY');
    merchantPublicKey = bytesToPem(await crypto.subtle.exportKey('spki', merchant.publicKey), 'PUBLIC KEY');
    platformPrivateKey = bytesToPem(await crypto.subtle.exportKey('pkcs8', platform.privateKey), 'PRIVATE KEY');
    platformPublicKey = bytesToPem(await crypto.subtle.exportKey('spki', platform.publicKey), 'PUBLIC KEY');
});

function base64UrlToBytes(value: string): Uint8Array {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function encodeLength(length: number): number[] {
    if (length < 0x80) return [length];
    const bytes: number[] = [];
    for (let remaining = length; remaining > 0; remaining >>>= 8) bytes.unshift(remaining & 0xff);
    return [0x80 | bytes.length, ...bytes];
}

function encodeInteger(value: Uint8Array): number[] {
    const needsLeadingZero = value[0] >= 0x80;
    const bytes = needsLeadingZero ? [0, ...value] : [...value];
    return [0x02, ...encodeLength(bytes.length), ...bytes];
}

function jwkToPkcs1(jwk: JsonWebKey): ArrayBuffer {
    const integers = [jwk.n, jwk.e, jwk.d, jwk.p, jwk.q, jwk.dp, jwk.dq, jwk.qi]
        .map((value) => encodeInteger(base64UrlToBytes(value!)));
    const value = [0x02, 0x01, 0x00, ...integers.flat()];
    return new Uint8Array([0x30, ...encodeLength(value.length), ...value]).buffer as ArrayBuffer;
}

function createPaymentApp(overrides: Partial<Env> = {}) {
    const env = createMockEnv({
        ALIMPAY_MERCHANT_PRIVATE_KEY: merchantPrivateKey,
        ALIMPAY_PLATFORM_PUBLIC_KEY: platformPublicKey,
        ...overrides,
    });
    const app = createRouter();
    PaymentService(app);
    return { app, env };
}

describe('AliMPay signing', () => {
    it('sorts scalar parameters and excludes signature, empty, array, and file values', () => {
        const parameters: AliMPayParameters = {
            z: 'last',
            sign: 'ignored',
            empty: '',
            list: ['ignored'],
            file: new Blob(['ignored']),
            a: 'first',
            count: 2,
        };
        expect(canonicalizeAliMPayParameters(parameters)).toBe('a=first&count=2&z=last');
    });

    it('signs with the merchant key and detects tampering', async () => {
        const parameters = { pid: '2142742862', money: '0.01', name: TEST_PRODUCT.name };
        const signature = await signAliMPayParameters(parameters, merchantPrivateKey);
        expect(await verifyAliMPaySignature(parameters, signature, merchantPublicKey)).toBe(true);
        expect(await verifyAliMPaySignature({ ...parameters, money: '9.99' }, signature, merchantPublicKey)).toBe(false);
    });

    it('accepts PKCS#1 merchant private keys', async () => {
        const parameters = { pid: '2142742862', money: '0.01', name: TEST_PRODUCT.name };
        const signature = await signAliMPayParameters(parameters, merchantPkcs1PrivateKey);
        expect(await verifyAliMPaySignature(parameters, signature, merchantPublicKey)).toBe(true);
    });
});

describe('AliMPay test product API', () => {
    afterEach(() => {
        globalThis.fetch = originalFetch;
        mock.restore();
    });

    async function signedPlatformResponse(payload: AliMPayParameters): Promise<Record<string, unknown>> {
        const sign = await signAliMPayParameters(payload, platformPrivateKey);
        return { ...payload, sign, sign_type: 'RSA' };
    }

    function mockCreateRequests(options: { payableAmount?: string; invalidSignature?: boolean } = {}) {
        const calls: URLSearchParams[] = [];
        globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            if (url.pathname === '/api/pay/create') {
                const form = new URLSearchParams(String(init?.body));
                calls.push(form);
                const payload: AliMPayParameters = {
                    code: 0,
                    msg: 'success',
                    trade_no: `PLATFORM${calls.length}`,
                    pay_type: 'jump',
                    pay_info: `https://pay.qlily13.cn/checkout/token-${calls.length}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                };
                const result = await signedPlatformResponse(payload);
                if (options.invalidSignature) result.sign = 'invalid';
                return Response.json(result);
            }
            if (url.pathname.startsWith('/public-api/checkout/')) {
                const index = url.pathname.endsWith('token-2') ? 2 : 1;
                const form = calls[index - 1];
                return Response.json({
                    trade_no: `PLATFORM${index}`,
                    out_trade_no: form.get('out_trade_no'),
                    name: TEST_PRODUCT.name,
                    requested_money: TEST_PRODUCT.price,
                    payable_money: options.payableAmount || '0.02',
                    collection_mode: 'business_qr',
                    status: 'pending',
                    expires_at: new Date(Date.now() + 300_000).toISOString(),
                    payment_poll_interval_seconds: 5,
                    payment_uri: '',
                });
            }
            return new Response('not found', { status: 404 });
        }) as typeof fetch;
        return calls;
    }

    it('creates unique real orders with the fixed product and actual payable amount', async () => {
        const calls = mockCreateRequests({ payableAmount: '0.37' });
        const { app, env } = createPaymentApp();
        const firstResponse = await app.handle(new Request('https://api.sgzyp.com/payment/test/create', { method: 'POST' }), env);
        const secondResponse = await app.handle(new Request('https://api.sgzyp.com/payment/test/create', { method: 'POST' }), env);
        expect(firstResponse.status).toBe(200);
        expect(secondResponse.status).toBe(200);

        const first = await firstResponse.json() as any;
        const second = await secondResponse.json() as any;
        expect(first.data.product).toEqual(TEST_PRODUCT);
        expect(first.data.orderNo).not.toBe(second.data.orderNo);
        expect(first.data.tradeNo).toBe('PLATFORM1');
        expect(first.data.payableAmount).toBe('0.37');
        expect(first.data.requestedAmount).toBe('0.01');
        expect(first.data.qrPayload).toBe('https://qr.alipay.com/2m613387crwspa4bkf0yu26');
        expect(first.data.collectionMode).toBe('business_qr');

        const signedParameters = Object.fromEntries(calls[0].entries());
        expect(signedParameters.money).toBe('0.01');
        expect(signedParameters.name).toBe(TEST_PRODUCT.name);
        expect(signedParameters.notify_url).toBe('https://api.sgzyp.com/api/payment/notify');
        expect(signedParameters.sign_type).toBe('RSA');
        const signature = signedParameters.sign;
        expect(await verifyAliMPaySignature(signedParameters, signature, merchantPublicKey)).toBe(true);
    });

    it('ignores client-supplied product names and amounts', async () => {
        const calls = mockCreateRequests();
        const { app, env } = createPaymentApp();
        const response = await app.handle(new Request('https://api.sgzyp.com/payment/test/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Expensive item', money: '999.00' }),
        }), env);
        const result = await response.json() as any;
        expect(result.data.product).toEqual(TEST_PRODUCT);
        expect(calls[0].get('name')).toBe(TEST_PRODUCT.name);
        expect(calls[0].get('money')).toBe(TEST_PRODUCT.price);
    });

    it('fails safely when the merchant private key is missing', async () => {
        const { app, env } = createPaymentApp({ ALIMPAY_MERCHANT_PRIVATE_KEY: '' });
        const response = await app.handle(new Request('https://api.sgzyp.com/payment/test/create', { method: 'POST' }), env);
        expect(response.status).toBe(503);
    });

    it('rejects an invalid platform response signature', async () => {
        mockCreateRequests({ invalidSignature: true });
        const { app, env } = createPaymentApp();
        const response = await app.handle(new Request('https://api.sgzyp.com/payment/test/create', { method: 'POST' }), env);
        expect(response.status).toBe(503);
    });

    it('queries and verifies a paid test order', async () => {
        globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
            const form = new URLSearchParams(String(init?.body));
            const payload: AliMPayParameters = {
                code: 0,
                msg: 'success',
                trade_no: form.get('trade_no'),
                out_trade_no: form.get('out_trade_no'),
                name: TEST_PRODUCT.name,
                money: TEST_PRODUCT.price,
                status: 1,
                timestamp: String(Math.floor(Date.now() / 1000)),
            };
            return Response.json(await signedPlatformResponse(payload));
        }) as typeof fetch;
        const { app, env } = createPaymentApp();
        const response = await app.handle(new Request('https://api.sgzyp.com/payment/test/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderNo: 'SGTESTORDER003', tradeNo: 'PLATFORM003' }),
        }), env);
        expect(response.status).toBe(200);
        expect((await response.json() as any).data.status).toBe('paid');
    });

    it('accepts a valid successful platform notification', async () => {
        const { app, env } = createPaymentApp();
        const parameters: AliMPayParameters = {
            pid: '2142742862',
            out_trade_no: 'SGTESTORDER001',
            trade_no: 'PLATFORM001',
            trade_status: 'TRADE_SUCCESS',
            name: TEST_PRODUCT.name,
            money: TEST_PRODUCT.price,
        };
        const sign = await signAliMPayParameters(parameters, platformPrivateKey);
        const query = new URLSearchParams({
            ...(parameters as Record<string, string>),
            sign,
            sign_type: 'RSA',
        });
        const response = await app.handle(new Request(`https://api.sgzyp.com/payment/notify?${query}`), env);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('success');
    });

    it('rejects tampered or mismatched notifications', async () => {
        const { app, env } = createPaymentApp();
        const parameters: AliMPayParameters = {
            pid: '2142742862',
            out_trade_no: 'SGTESTORDER002',
            trade_status: 'TRADE_SUCCESS',
            name: TEST_PRODUCT.name,
            money: TEST_PRODUCT.price,
        };
        const sign = await signAliMPayParameters(parameters, platformPrivateKey);
        const query = new URLSearchParams({
            ...(parameters as Record<string, string>),
            money: '1.00',
            sign,
            sign_type: 'RSA',
        });
        const response = await app.handle(new Request(`https://api.sgzyp.com/payment/notify?${query}`), env);
        expect(response.status).toBe(400);
        expect(await response.text()).not.toBe('success');
    });
});

import { beforeAll, describe, expect, it } from 'bun:test';
import { createRouter } from '../../core/router';
import { PaymentService, TEST_PRODUCT } from '../payment';
import {
    canonicalizeAliMPayParameters,
    signAliMPayParameters,
    verifyAliMPaySignature,
    type AliMPayParameters,
} from '../../utils/alimpay';
import { createMockEnv } from '../../../tests/fixtures';

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
    it('creates unique signed checkout URLs with the fixed product and price', async () => {
        const { app, env } = createPaymentApp();
        const firstResponse = await app.handle(new Request('https://api.sgzyp.com/payment/test/create', { method: 'POST' }), env);
        const secondResponse = await app.handle(new Request('https://api.sgzyp.com/payment/test/create', { method: 'POST' }), env);
        expect(firstResponse.status).toBe(200);
        expect(secondResponse.status).toBe(200);

        const first = await firstResponse.json() as any;
        const second = await secondResponse.json() as any;
        expect(first.data.product).toEqual(TEST_PRODUCT);
        expect(first.data.orderNo).not.toBe(second.data.orderNo);

        const paymentUrl = new URL(first.data.paymentUrl);
        expect(paymentUrl.origin).toBe('https://pay.qlily13.cn');
        expect(paymentUrl.pathname).toBe('/api/pay/submit');
        expect(paymentUrl.searchParams.get('money')).toBe('0.01');
        expect(paymentUrl.searchParams.get('name')).toBe(TEST_PRODUCT.name);
        expect(paymentUrl.searchParams.get('notify_url')).toBe('https://api.sgzyp.com/api/payment/notify');
        expect(paymentUrl.searchParams.get('sign_type')).toBe('RSA');

        const signedParameters = Object.fromEntries(paymentUrl.searchParams.entries());
        const signature = signedParameters.sign;
        expect(await verifyAliMPaySignature(signedParameters, signature, merchantPublicKey)).toBe(true);
    });

    it('ignores client-supplied product names and amounts', async () => {
        const { app, env } = createPaymentApp();
        const response = await app.handle(new Request('https://api.sgzyp.com/payment/test/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Expensive item', money: '999.00' }),
        }), env);
        const result = await response.json() as any;
        const paymentUrl = new URL(result.data.paymentUrl);
        expect(paymentUrl.searchParams.get('name')).toBe(TEST_PRODUCT.name);
        expect(paymentUrl.searchParams.get('money')).toBe(TEST_PRODUCT.price);
    });

    it('fails safely when the merchant private key is missing', async () => {
        const { app, env } = createPaymentApp({ ALIMPAY_MERCHANT_PRIVATE_KEY: '' });
        const response = await app.handle(new Request('https://api.sgzyp.com/payment/test/create', { method: 'POST' }), env);
        expect(response.status).toBe(503);
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

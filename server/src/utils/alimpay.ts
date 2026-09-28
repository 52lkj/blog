export type AliMPayParameter = string | number | boolean | null | undefined | Blob | AliMPayParameter[];

export type AliMPayParameters = Record<string, AliMPayParameter>;

function isSignableValue(value: AliMPayParameter): value is string | number | boolean {
    return value !== null
        && value !== undefined
        && value !== ''
        && !Array.isArray(value)
        && !(value instanceof Blob);
}

export function canonicalizeAliMPayParameters(parameters: AliMPayParameters): string {
    return Object.keys(parameters)
        .filter((key) => key !== 'sign' && key !== 'sign_type')
        .filter((key) => isSignableValue(parameters[key]))
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        .map((key) => `${key}=${String(parameters[key])}`)
        .join('&');
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
}

function pemToBytes(pem: string, label: 'PRIVATE KEY' | 'PUBLIC KEY' | 'RSA PRIVATE KEY'): ArrayBuffer {
    const normalized = pem.replace(/\\n/g, '\n').trim().replace(/^['"]|['"]$/g, '');
    const base64 = normalized
        .replace(`-----BEGIN ${label}-----`, '')
        .replace(`-----END ${label}-----`, '')
        .replace(/\s/g, '');

    if (!base64) {
        throw new Error(`Invalid ${label.toLowerCase()} PEM`);
    }

    return base64ToArrayBuffer(base64);
}

function derLength(length: number): Uint8Array {
    if (length < 0x80) return new Uint8Array([length]);
    const bytes: number[] = [];
    for (let remaining = length; remaining > 0; remaining >>>= 8) {
        bytes.unshift(remaining & 0xff);
    }
    return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function derElement(tag: number, value: Uint8Array): Uint8Array {
    const length = derLength(value.length);
    const element = new Uint8Array(1 + length.length + value.length);
    element[0] = tag;
    element.set(length, 1);
    element.set(value, 1 + length.length);
    return element;
}

function wrapPkcs1PrivateKey(pkcs1: ArrayBuffer): ArrayBuffer {
    // PKCS#8 PrivateKeyInfo for rsaEncryption (OID 1.2.840.113549.1.1.1).
    const version = new Uint8Array([0x02, 0x01, 0x00]);
    const algorithm = new Uint8Array([
        0x30, 0x0d,
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
        0x05, 0x00,
    ]);
    const privateKey = derElement(0x04, new Uint8Array(pkcs1));
    const value = new Uint8Array(version.length + algorithm.length + privateKey.length);
    value.set(version, 0);
    value.set(algorithm, version.length);
    value.set(privateKey, version.length + algorithm.length);
    return derElement(0x30, value).buffer as ArrayBuffer;
}

async function importPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
    const isPkcs1Pem = privateKeyPem.replace(/\\n/g, '\n').includes('BEGIN RSA PRIVATE KEY');
    const bytes = pemToBytes(privateKeyPem, isPkcs1Pem ? 'RSA PRIVATE KEY' : 'PRIVATE KEY');
    const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

    if (isPkcs1Pem) {
        return crypto.subtle.importKey('pkcs8', wrapPkcs1PrivateKey(bytes), algorithm, false, ['sign']);
    }

    try {
        return await crypto.subtle.importKey('pkcs8', bytes, algorithm, false, ['sign']);
    } catch {
        // Headerless merchant keys can be either PKCS#8 or PKCS#1.
        return crypto.subtle.importKey('pkcs8', wrapPkcs1PrivateKey(bytes), algorithm, false, ['sign']);
    }
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

export async function signAliMPayParameters(
    parameters: AliMPayParameters,
    privateKeyPem: string,
): Promise<string> {
    const key = await importPrivateKey(privateKeyPem);
    const payload = new TextEncoder().encode(canonicalizeAliMPayParameters(parameters));
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, payload);
    return bytesToBase64(new Uint8Array(signature));
}

export async function verifyAliMPaySignature(
    parameters: AliMPayParameters,
    signature: string,
    publicKeyPem: string,
): Promise<boolean> {
    try {
        const key = await crypto.subtle.importKey(
            'spki',
            pemToBytes(publicKeyPem, 'PUBLIC KEY'),
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify'],
        );
        const payload = new TextEncoder().encode(canonicalizeAliMPayParameters(parameters));
        const signatureBytes = base64ToArrayBuffer(signature);
        return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signatureBytes, payload);
    } catch {
        return false;
    }
}

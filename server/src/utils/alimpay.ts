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

function pemToBytes(pem: string, label: 'PRIVATE KEY' | 'PUBLIC KEY'): ArrayBuffer {
    const normalized = pem.replace(/\\n/g, '\n').trim();
    const base64 = normalized
        .replace(`-----BEGIN ${label}-----`, '')
        .replace(`-----END ${label}-----`, '')
        .replace(/\s/g, '');

    if (!base64) {
        throw new Error(`Invalid ${label.toLowerCase()} PEM`);
    }

    return base64ToArrayBuffer(base64);
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
    const key = await crypto.subtle.importKey(
        'pkcs8',
        pemToBytes(privateKeyPem, 'PRIVATE KEY'),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign'],
    );
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

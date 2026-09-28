import { describe, expect, it } from 'bun:test';
import { getServicePath } from '../_worker';

describe('Worker service routing', () => {
    it('removes the API prefix', () => {
        expect(getServicePath('/api/user/github')).toBe('/user/github');
    });

    it('accepts the legacy GitHub OAuth callback path', () => {
        expect(getServicePath('/user/github/callback')).toBe('/user/github/callback');
    });

    it('does not expose other service routes without the API prefix', () => {
        expect(getServicePath('/user/profile')).toBeNull();
        expect(getServicePath('/feed')).toBeNull();
    });
});

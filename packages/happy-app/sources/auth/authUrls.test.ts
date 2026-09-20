import { describe, expect, it } from 'vitest';
import { extractHappyAuthPublicKey, getHappyAuthUrlKind } from './authUrls';

describe('Happy auth URLs', () => {
    it('recognizes terminal and account QR URLs', () => {
        expect(getHappyAuthUrlKind('happy://terminal?terminal-key')).toBe('terminal');
        expect(getHappyAuthUrlKind('happy:///account?account-key')).toBe('account');
        expect(getHappyAuthUrlKind('https://example.com')).toBeNull();
    });

    it('extracts public key payloads from supported QR URLs', () => {
        expect(extractHappyAuthPublicKey('happy://terminal?terminal-key', 'terminal')).toBe('terminal-key');
        expect(extractHappyAuthPublicKey('happy:///account?account-key', 'account')).toBe('account-key');
    });
});

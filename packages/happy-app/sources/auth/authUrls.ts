export const TERMINAL_AUTH_URL_PREFIX = 'happy://terminal?';
export const ACCOUNT_AUTH_URL_PREFIX = 'happy:///account?';

export type HappyAuthUrlKind = 'terminal' | 'account';

export function getHappyAuthUrlKind(url: string): HappyAuthUrlKind | null {
    const trimmed = url.trim();
    if (trimmed.startsWith(TERMINAL_AUTH_URL_PREFIX)) {
        return 'terminal';
    }
    if (trimmed.startsWith(ACCOUNT_AUTH_URL_PREFIX)) {
        return 'account';
    }
    return null;
}

export function extractHappyAuthPublicKey(url: string, kind: HappyAuthUrlKind): string {
    const trimmed = url.trim();
    const prefix = kind === 'terminal' ? TERMINAL_AUTH_URL_PREFIX : ACCOUNT_AUTH_URL_PREFIX;
    return trimmed.slice(prefix.length);
}

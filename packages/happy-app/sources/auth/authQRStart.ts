import { getRandomBytes } from 'expo-crypto';
import sodium from '@/encryption/libsodium.lib';
import axios from 'axios';
import { encodeBase64 } from '../encryption/base64';
import { getServerUrl } from '@/sync/serverConfig';
import { getHappyClientId } from '@/sync/apiSocket';

export interface QRAuthKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}

export function generateAuthKeyPair(): QRAuthKeyPair {
    const secret = getRandomBytes(32);
    const keypair = sodium.crypto_box_seed_keypair(secret);
    return {
        publicKey: keypair.publicKey,
        secretKey: keypair.privateKey,
    };
}

export async function authQRStart(keypair: QRAuthKeyPair): Promise<boolean> {
    try {
        const serverUrl = getServerUrl();
        if (process.env.EXPO_PUBLIC_DEBUG) {
            console.log(`[AUTH DEBUG] Sending auth request to: ${serverUrl}/v1/auth/request`);
            console.log(`[AUTH DEBUG] Public key: ${encodeBase64(keypair.publicKey).substring(0, 20)}...`);
        }

        await axios.post(`${serverUrl}/v1/auth/request`, {
            publicKey: encodeBase64(keypair.publicKey),
            // Desktop restore stores the account master secret in the same
            // AuthCredentials shape as mobile. Register as legacy terminal auth
            // so existing phone apps that already scan CLI QR codes return the
            // 32-byte secret, not a V2 data-key bundle meant for CLI daemons.
            supportsV2: false,
        }, {
            headers: {
                'X-Happy-Client': getHappyClientId(),
            }
        });

        if (process.env.EXPO_PUBLIC_DEBUG) {
            console.log('[AUTH DEBUG] Auth request sent successfully');
        }
        return true;
    } catch (error) {
        if (process.env.EXPO_PUBLIC_DEBUG) {
            console.log('[AUTH DEBUG] Failed to send auth request:', error);
        }
        console.log('Failed to create authentication request, please try again later.');
        return false;
    }
}

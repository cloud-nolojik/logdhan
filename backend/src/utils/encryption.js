import crypto from 'crypto';

// Generate a consistent encryption key
const ENCRYPTION_KEY = process.env.UPSTOX_ENCRYPTION_KEY ? 
    crypto.createHash('sha256').update(process.env.UPSTOX_ENCRYPTION_KEY).digest() : 
    crypto.randomBytes(32);

/**
 * Encrypt text using AES-256-CBC
 */
export function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt text encrypted with AES-256-CBC
 */
export function decrypt(text) {
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = textParts.join(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}
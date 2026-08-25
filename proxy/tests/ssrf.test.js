import { jest } from '@jest/globals';

const { isPrivateAddress, resolveSafeImageUrl } = await import('../ssrf.ts');

describe('isPrivateAddress', () => {
    it('rejects unparseable inputs as private', () => {
        expect(isPrivateAddress('not-an-ip')).toBe(true);
        expect(isPrivateAddress('')).toBe(true);
        expect(isPrivateAddress('256.0.0.1')).toBe(true);
    });

    it('detects private IPv4 ranges', () => {
        expect(isPrivateAddress('10.0.0.1')).toBe(true);
        expect(isPrivateAddress('10.255.255.255')).toBe(true);
        expect(isPrivateAddress('172.16.0.1')).toBe(true);
        expect(isPrivateAddress('172.31.255.255')).toBe(true);
        expect(isPrivateAddress('172.15.255.255')).toBe(false);
        expect(isPrivateAddress('172.32.0.1')).toBe(false);
        expect(isPrivateAddress('192.168.1.1')).toBe(true);
        expect(isPrivateAddress('100.64.0.1')).toBe(true);
        expect(isPrivateAddress('100.127.255.255')).toBe(true);
        expect(isPrivateAddress('100.128.0.1')).toBe(false);
        expect(isPrivateAddress('127.0.0.1')).toBe(true);
        expect(isPrivateAddress('169.254.1.2')).toBe(true);
        expect(isPrivateAddress('0.0.0.1')).toBe(true);
        expect(isPrivateAddress('224.0.0.1')).toBe(true);
        expect(isPrivateAddress('240.0.0.1')).toBe(true);
        expect(isPrivateAddress('192.0.2.1')).toBe(true);
        expect(isPrivateAddress('198.51.100.1')).toBe(true);
        expect(isPrivateAddress('203.0.113.1')).toBe(true);
    });

    it('allows public IPv4', () => {
        expect(isPrivateAddress('8.8.8.8')).toBe(false);
        expect(isPrivateAddress('1.1.1.1')).toBe(false);
        expect(isPrivateAddress('9.9.9.9')).toBe(false);
        expect(isPrivateAddress('151.101.1.1')).toBe(false);
    });

    it('detects private IPv6', () => {
        expect(isPrivateAddress('::1')).toBe(true);
        expect(isPrivateAddress('::')).toBe(true);
        expect(isPrivateAddress('fe80::1')).toBe(true);
        expect(isPrivateAddress('fc00::1')).toBe(true);
        expect(isPrivateAddress('fd00::1')).toBe(true);
        expect(isPrivateAddress('2001:db8::1')).toBe(true);
        expect(isPrivateAddress('ff02::1')).toBe(true);
        expect(isPrivateAddress('64:ff9b::8.8.8.8')).toBe(true);
    });

    it('handles IPv4-mapped IPv6', () => {
        expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
        expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
        expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
        expect(isPrivateAddress('[::ffff:8.8.8.8]')).toBe(false);
    });

    it('allows public IPv6', () => {
        expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false);
        expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
        expect(isPrivateAddress('2a00:1450:4001:800::200e')).toBe(false);
    });

    it('handles bracketed IPv6 literals', () => {
        expect(isPrivateAddress('[::1]')).toBe(true);
        expect(isPrivateAddress('[2001:4860:4860::8888]')).toBe(false);
    });
});

describe('resolveSafeImageUrl', () => {
    it('allows public http/https URLs', () => {
        expect(resolveSafeImageUrl('https://example.com/image.png')).toEqual({
            hostname: 'example.com',
            protocol: 'https:'
        });
        expect(resolveSafeImageUrl('http://example.com/a.jpg')).toEqual({
            hostname: 'example.com',
            protocol: 'http:'
        });
        expect(resolveSafeImageUrl('https://8.8.8.8/image.png')).toEqual({
            hostname: '8.8.8.8',
            protocol: 'https:'
        });
        expect(resolveSafeImageUrl('https://[2001:4860:4860::8888]/image.png')).toBeTruthy();
    });

    it('rejects private and loopback hosts', () => {
        expect(resolveSafeImageUrl('http://localhost/image.png')).toBeNull();
        expect(resolveSafeImageUrl('http://127.0.0.1/image.png')).toBeNull();
        expect(resolveSafeImageUrl('http://10.0.0.1/image.png')).toBeNull();
        expect(resolveSafeImageUrl('http://192.168.1.1/image.png')).toBeNull();
        expect(resolveSafeImageUrl('http://169.254.169.254/latest/meta-data/')).toBeNull();
        expect(resolveSafeImageUrl('http://[::1]/image.png')).toBeNull();
        expect(resolveSafeImageUrl('http://[fe80::1]/image.png')).toBeNull();
        expect(resolveSafeImageUrl('http://[::ffff:127.0.0.1]/image.png')).toBeNull();
    });

    it('rejects non-http protocols and invalid URLs', () => {
        expect(resolveSafeImageUrl('ftp://example.com/image.png')).toBeNull();
        expect(resolveSafeImageUrl('file:///etc/passwd')).toBeNull();
        expect(resolveSafeImageUrl('data:image/png;base64,abc')).toBeNull();
        expect(resolveSafeImageUrl('not a url')).toBeNull();
        expect(resolveSafeImageUrl('')).toBeNull();
    });

    it('rejects unparseable IPs as unsafe', () => {
        expect(resolveSafeImageUrl('http://999.999.999.999/image.png')).toBeNull();
    });
});

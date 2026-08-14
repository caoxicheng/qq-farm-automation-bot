/**
 * QR Login Utilities
 */

class CookieUtils {
    static parse(cookieStr: string): Record<string, string> {
        if (!cookieStr) return {};
        return cookieStr.split(';').reduce<Record<string, string>>((acc, curr) => {
            const [key, value] = curr.split('=');
            if (key) acc[key.trim()] = value ? value.trim() : '';
            return acc;
        }, {});
    }

    static getValue(cookies: string | readonly string[] | null | undefined, key: string): string | null {
        if (!cookies) return null;
        if (Array.isArray(cookies)) cookies = cookies.join('; ');
        const match = String(cookies).match(new RegExp(`(^|;\\s*)${key}=([^;]*)`));
        return match ? match[2] : null;
    }

    static getUin(cookies: string | readonly string[] | null | undefined): string | null {
        const uin = this.getValue(cookies, 'wxuin') || this.getValue(cookies, 'uin') || this.getValue(cookies, 'ptui_loginuin');
        if (!uin) return null;
        return uin.replace(/^o0*/, '');
    }
}

class HashUtils {
    static hash(str: string): number {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash += (hash << 5) + str.charCodeAt(i);
        }
        return 2147483647 & hash;
    }

    static getGTk(pskey: string): number {
        let gtk = 5381;
        for (let i = 0; i < pskey.length; i++) {
            gtk += (gtk << 5) + pskey.charCodeAt(i);
        }
        return gtk & 0x7FFFFFFF;
    }
}

export { CookieUtils, HashUtils };

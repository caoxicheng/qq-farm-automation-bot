import { Buffer } from 'node:buffer';
/**
 * QR Code Login Module - 从 QRLib 集成
 */
import axios from 'axios';
import { CookieUtils, HashUtils } from '../utils/qrutils';
import { asRecord, errorMessage } from './service-boundaries';

const QRCode = require('qrcode') as {
    toDataURL: (
        text: string,
        options: { width: number; margin: number; errorCorrectionLevel: string },
    ) => Promise<string>;
};

interface QrLoginPreset {
    name: string;
    description: string;
    aid: string;
    daid: string;
    redirectUri: string;
    referrer: string;
}

type MiniProgramStatus =
    | { status: 'Wait' | 'Used' }
    | { status: 'Error'; msg?: string }
    | { status: 'OK'; ticket: unknown; uin: unknown; nickname: string };

const ChromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

class QRLoginSession {
    static Presets: Record<string, QrLoginPreset> = {
        vip: {
            name: 'QQ会员 (VIP)',
            description: 'QQ会员官网',
            aid: '8000201',
            daid: '18',
            redirectUri: 'https://vip.qq.com/loginsuccess.html',
            referrer: 'https://xui.ptlogin2.qq.com/cgi-bin/xlogin?appid=8000201&style=20&s_url=https%3A%2F%2Fvip.qq.com%2Floginsuccess.html&maskOpacity=60&daid=18&target=self',
        },
        qzone: {
            name: 'QQ空间 (QZone)',
            description: 'QQ空间网页版',
            aid: '549000912',
            daid: '5',
            redirectUri: 'https://qzs.qzone.qq.com/qzone/v5/loginsucc.html?para=izone',
            referrer: 'https://qzone.qq.com/',
        },
    };

    static async requestQRCode(presetKey = 'vip'): Promise<{
        qrsig: string | null;
        qrcode: string;
        url: string;
    }> {
        const config = this.Presets[presetKey] || this.Presets.vip;

        const params = new URLSearchParams({
            appid: config.aid,
            e: '2',
            l: 'M',
            s: '3',
            d: '72',
            v: '4',
            t: String(Math.random()),
            daid: config.daid,
        });

        params.set('u1', config.redirectUri);

        const url = `https://ssl.ptlogin2.qq.com/ptqrshow?${params.toString()}`;

        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                headers: {
                    'Referer': config.referrer || `https://xui.ptlogin2.qq.com/`,
                    'User-Agent': ChromeUA,
                }
            });

            const setCookie = response.headers['set-cookie'];
            const qrsig = CookieUtils.getValue(setCookie, 'qrsig');
            const qrcodeBase64 = Buffer.from(response.data).toString('base64');

            return { qrsig, qrcode: `data:image/png;base64,${qrcodeBase64}`, url };
        } catch (error) {
            console.error('Request QRCode Error:', errorMessage(error));
            throw error;
        }
    }

    static async checkStatus(qrsig: string, presetKey = 'vip'): Promise<{
        ret?: string;
        msg?: string;
        nickname?: string;
        jumpUrl?: string;
        cookie?: string[];
    }> {
        const config = this.Presets[presetKey] || this.Presets.vip;
        const ptqrtoken = HashUtils.hash(qrsig);

        const params = new URLSearchParams({
            ptqrtoken: String(ptqrtoken),
            from_ui: '1',
            aid: config.aid,
            daid: config.daid,
            action: `0-0-${Date.now()}`,
            pt_uistyle: '40',
            js_ver: '21020514',
            js_type: '1'
        });

        params.set('u1', config.redirectUri);

        const api = `https://ssl.ptlogin2.qq.com/ptqrlogin?${params.toString()}`;

        try {
            const response = await axios.get(api, {
                headers: {
                    'Cookie': `qrsig=${qrsig}`,
                    'Referer': config.referrer || 'https://xui.ptlogin2.qq.com/',
                    'User-Agent': ChromeUA,
                },
            });

            const text = String(response.data || '');
            const matcher = /ptuiCB\((.+)\)/;
            const match = text.match(matcher);

            if (!match) {
                throw new Error('Invalid response format');
            }

            const args: string[] = [];
            const argMatcher = /'([^']*)'/g;
            for (let argMatch = argMatcher.exec(match[1]); argMatch !== null; argMatch = argMatcher.exec(match[1])) {
                args.push(argMatch[1]);
            }

            const [ret, , jumpUrl, , msg, nickname] = args;

            return {
                ret,
                msg,
                nickname,
                jumpUrl,
                cookie: response.headers['set-cookie']
            };
        } catch (error) {
            console.error('Check Status Error:', errorMessage(error));
            throw error;
        }
    }
}

class MiniProgramLoginSession {
    static QUA = 'V1_HT5_QDT_0.70.2209190_x64_0_DEV_D';

    static Presets = {
        farm: {
            name: 'QQ经典农场 (Farm)',
            description: 'QQ经典农场小程序',
            appid: '1112386029'
        }
    };

    static getHeaders(): Record<string, string> {
        return {
            'qua': MiniProgramLoginSession.QUA,
            'host': 'q.qq.com',
            'accept': 'application/json',
            'content-type': 'application/json',
            'user-agent': ChromeUA
        };
    }

    static async requestLoginCode(): Promise<{ code: string; url: string; image: string }> {
        try {
            const response = await axios.get('https://q.qq.com/ide/devtoolAuth/GetLoginCode', {
                headers: this.getHeaders()
            });

            const payload = asRecord(response.data);
            const code = payload.code;
            const data = asRecord(payload.data);

            if (Number(code) !== 0) {
                throw new Error('获取登录码失败');
            }

            const loginCode = String(data.code || '');
            const loginUrl = `https://h5.qzone.qq.com/qqq/code/${loginCode}?_proxy=1&from=ide`;
            const image = await QRCode.toDataURL(loginUrl, {
                width: 300,
                margin: 1,
                errorCorrectionLevel: 'M',
            });

            return {
                code: loginCode,
                url: loginUrl,
                image,
            };
        } catch (error) {
            console.error('MP Request Login Code Error:', errorMessage(error));
            throw error;
        }
    }

    static async queryStatus(code: unknown): Promise<MiniProgramStatus> {
        try {
            const response = await axios.get(`https://q.qq.com/ide/devtoolAuth/syncScanSateGetTicket?code=${code}`, {
                headers: this.getHeaders()
            });

            if (response.status !== 200) {
                return { status: 'Error' };
            }

            const payload = asRecord(response.data);
            const resCode = payload.code;
            const data = asRecord(payload.data);

            if (Number(resCode) === 0) {
                if (Number(data.ok) !== 1) return { status: 'Wait' };
                // 这里的 data.nick 字段可能存在，需要确认返回结构
                return { status: 'OK', ticket: data.ticket, uin: data.uin, nickname: String(data.nick || '') };
            }

            if (Number(resCode) === -10003) return { status: 'Used' };

            return { status: 'Error', msg: `Code: ${resCode}` };
        } catch (error) {
            console.error('MP Query Status Error:', errorMessage(error));
            throw error;
        }
    }

    static async getAuthCode(ticket: unknown, appid: unknown = '1112386029'): Promise<string> {
        try {
            const response = await axios.post('https://q.qq.com/ide/login', {
                appid,
                ticket
            }, {
                headers: this.getHeaders()
            });

            if (response.status !== 200) return '';

            const code = asRecord(response.data).code;
            return typeof code === 'string' ? code : '';
        } catch (error) {
            console.error('MP Get Auth Code Error:', errorMessage(error));
            return '';
        }
    }
}

export { MiniProgramLoginSession, QRLoginSession };

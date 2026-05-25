const https = require('https');
const http = require('http');

// Media base64 cache — populated by webhook handler when WPPConnect sends image/video messages
const mediaBase64Cache = new Map();

class WPPClient {
    constructor(baseUrl, sessionName, token) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.sessionName = sessionName;
        this.token = token;
    }

    _request(method, path, body) {
        return new Promise((resolve, reject) => {
            const url = new URL(this.baseUrl + path);
            const bodyStr = body ? JSON.stringify(body) : undefined;
            const headers = {
                'Authorization': 'Bearer ' + this.token,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            };
            if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
            const opts = {
                hostname: url.hostname,
                port: url.port || undefined,
                path: url.pathname + url.search,
                method,
                headers,
                timeout: 60000,
            };
            const mod = url.protocol === 'https:' ? https : http;
            const req = mod.request(opts, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 400) {
                        const errMsg = (data && typeof data === 'string') ? data : ('HTTP ' + res.statusCode);
                        return reject(new Error(String(errMsg).substring(0, 300)));
                    }
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed?.status === 'error' || parsed?.error) {
                            return reject(new Error(String(parsed.error || parsed.status).substring(0, 300)));
                        }
                        resolve(parsed);
                    }
                    catch { resolve(data); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
            req.end(bodyStr);
        });
    }

    _formatPhone(jid) {
        return jid ? jid.replace(/[^0-9]/g, '') : '';
    }

    async sendText(to, text, options = {}) {
        const phone = this._formatPhone(to);
        if (options.mentions?.length) {
            return this._request('POST', `/api/${this.sessionName}/send-mentioned`, {
                phone,
                message: text,
                mentioned: options.mentions,
            });
        }
        if (options.linkPreview) {
            return this._request('POST', `/api/${this.sessionName}/send-link-preview`, {
                phone,
                url: options.linkPreview,
                title: options.linkPreviewTitle || '',
                description: options.linkPreviewDescription || '',
            });
        }
        return this._request('POST', `/api/${this.sessionName}/send-message`, { phone, message: text });
    }

    async sendMedia(to, mediaUrl, caption, options = {}) {
        const phone = this._formatPhone(to);
        const isGroup = to.endsWith('@g.us');
        const buffer = await this._downloadBuffer(mediaUrl);
        const base64 = buffer.toString('base64');
        const ext = this._extFromUrl(mediaUrl) || 'png';
        return this._request('POST', `/api/${this.sessionName}/send-file-base64`, {
            phone,
            filename: `media.${ext}`,
            base64,
            isGroup,
            caption: caption || '',
        });
    }

    async setGroupAdminsOnly(groupId, value) {
        return this._request('POST', `/api/${this.sessionName}/messages-admins-only`, {
            groupId,
            value,
        });
    }

    async sendDelete(remoteJid, id, participant, fromMe = false) {
        const phone = this._formatPhone(remoteJid);
        const body = { phone, messageId: id };
        if (participant) body.of = participant;
        return this._request('POST', `/api/${this.sessionName}/delete-message`, body);
    }

    async sendPresence(jid, presence) {
        const phone = this._formatPhone(jid);
        return this._request('POST', `/api/${this.sessionName}/typing`, {
            phone,
            value: presence === 'typing' || presence === 'available' || presence === 'composing',
        });
    }

    async fetchGroups(getParticipants = false) {
        const result = await this._request('POST', `/api/${this.sessionName}/list-chats`, {
            onlyGroups: true,
            count: 100,
        });
        const rawGroups = Array.isArray(result) ? result : (result?.chats || result?.data || []);
        const groups = [];
        for (const g of rawGroups) {
            const group = {
                jid: g.id || g.jid || '',
                id: g.id || g.jid || '',
                subject: g.name || g.subject || 'Unknown Group',
                name: g.name || g.subject || 'Unknown Group',
                participants: [],
                owner: '',
                size: g.size || 0,
            };
            if (getParticipants) {
                try {
                    const members = await this._request('GET', `/api/${this.sessionName}/group-members/${encodeURIComponent(group.id)}`);
                    const membersList = Array.isArray(members) ? members : (members?.participants || []);
                    group.participants = membersList.map(p => ({
                        id: p.id || p.jid || '',
                        phoneNumber: this._formatPhone(p.id || p.jid || ''),
                        name: p.name || '',
                    }));
                } catch (e) {
                    // Silently fail — participants not critical
                }
                await new Promise(r => setTimeout(r, 500));
            }
            groups.push(group);
        }
        return { groups };
    }

    async fetchGroupInviteCode(groupJid) {
        const encoded = encodeURIComponent(groupJid);
        return this._request('GET', `/api/${this.sessionName}/group-invite-link/${encoded}`);
    }

    async fetchMessages(remoteJid, limit = 20) {
        const phone = this._formatPhone(remoteJid);
        const isGroup = remoteJid.endsWith('@g.us');
        const result = await this._request('GET', `/api/${this.sessionName}/all-messages-in-chat/${phone}?isGroup=${isGroup}&count=${limit}`);
        const rawMsgs = Array.isArray(result) ? result : (result?.messages || result?.data || []);
        const records = rawMsgs.map(m => ({
            key: {
                remoteJid: m.from || remoteJid,
                fromMe: !!m.fromMe,
                id: m.id || '',
                participant: isGroup ? (m.sender?.id || remoteJid) : undefined,
            },
            message: {
                conversation: m.body || m.caption || '',
            },
        }));
        return { messages: { records } };
    }

    async addGroupParticipant(groupJid, participants) {
        const phone = this._formatPhone(groupJid);
        const jids = Array.isArray(participants) ? participants : [participants];
        const results = [];
        for (const jid of jids) {
            const p = this._formatPhone(jid);
            const r = await this._request('POST', `/api/${this.sessionName}/add-participant-group`, {
                groupId: phone,
                phone: p,
            });
            results.push(r);
            await new Promise(r => setTimeout(r, 1000));
        }
        return results;
    }

    async fetchProfilePicture(number) {
        const phone = this._formatPhone(number);
        return this._request('GET', `/api/${this.sessionName}/profile-pic/${phone}`);
    }

    async fetchInstanceStatus() {
        const raw = await this._request('GET', `/api/${this.sessionName}/check-connection-session`);
        // Normalize: return { status: "isLogged" | "notLogged" | ... }
        if (raw?.state) return { status: raw.state };
        if (raw?.status && raw.status !== 'Success') return { status: raw.status };
        if (raw?.result?.status) return { status: raw.result.status };
        if (raw?.instance?.state) return { status: raw.instance.state };
        return raw;
    }

    async getMediaBase64(messageKeyId) {
        const cached = mediaBase64Cache.get(messageKeyId);
        if (cached) return { base64: cached };
        throw new Error('Media not found in cache');
    }

    async getQrCode() {
        return this._request('GET', `/api/${this.sessionName}/qrcode-session`);
    }

    async startSession(webhookUrl) {
        const body = { waitQrCode: true };
        if (webhookUrl) body.webhook = webhookUrl;
        return this._request('POST', `/api/${this.sessionName}/start-session`, body);
    }

    _downloadBuffer(url) {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const mod = parsed.protocol === 'https:' ? https : http;
            mod.get(url, { timeout: 30000 }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('Download timeout')); });
        });
    }

    _extFromUrl(url) {
        const match = url.match(/\.(\w+)(\?|$)/);
        if (match) {
            const ext = match[1].toLowerCase();
            if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'pdf', 'doc', 'docx'].includes(ext)) return ext;
        }
        return null;
    }
}

module.exports = { WPPClient, mediaBase64Cache };

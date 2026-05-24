const https = require('https');
const http = require('http');

class EvolutionClient {
    constructor(baseUrl, instanceName, apiKey) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.instanceName = instanceName;
        this.apiKey = apiKey;
    }

    _request(method, path, body) {
        return new Promise((resolve, reject) => {
            const url = new URL(this.baseUrl + path);
            const bodyStr = body ? JSON.stringify(body) : undefined;
            const headers = {
                'apikey': this.apiKey,
                'Content-Type': 'application/json',
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

    async sendText(to, text, options = {}) {
        const body = {
            number: to.endsWith('@g.us') ? to : to.replace(/[^0-9]/g, ''),
            text,
            delay: options.delay || 0,
        };
        if (options.mentions?.length) body.mentioned = options.mentions;
        if (options.linkPreview) body.linkPreview = options.linkPreview;
        return this._request('POST', `/message/sendText/${this.instanceName}`, body);
    }

    async sendMedia(to, mediaUrl, caption, options = {}) {
        return this._request('POST', `/message/sendMedia/${this.instanceName}`, {
            number: to.endsWith('@g.us') ? to : to.replace(/[^0-9]/g, ''),
            media: mediaUrl,
            caption: caption || '',
            options: { delay: options.delay || 0 },
        });
    }

    async sendDelete(remoteJid, id, participant, fromMe = false) {
        return this._request('DELETE', `/chat/deleteMessageForEveryone/${this.instanceName}`, {
            id,
            remoteJid,
            fromMe,
            participant,
        });
    }

    async sendPresence(jid, presence) {
        return this._request('POST', `/chat/sendPresence/${this.instanceName}`, {
            jid,
            presence,
        });
    }

    async fetchGroups(getParticipants = false) {
        return this._request('GET', `/group/fetchAllGroups/${this.instanceName}?getParticipants=${getParticipants}`);
    }

    async fetchGroupInviteCode(groupJid) {
        return this._request('GET', `/group/inviteCode/${this.instanceName}?groupJid=${encodeURIComponent(groupJid)}`);
    }

    async fetchMessages(remoteJid, limit = 20) {
        return this._request('POST', `/chat/findMessages/${this.instanceName}`, {
            where: { key: { remoteJid } },
            limit,
        });
    }

    async addGroupParticipant(groupJid, participants) {
        return this._request('POST', `/group/updateParticipant/${this.instanceName}`, {
            groupJid,
            action: 'add',
            participants: Array.isArray(participants) ? participants : [participants],
        });
    }

    async fetchProfilePicture(number) {
        return this._request('GET', `/chat/fetchProfilePictureUrl/${this.instanceName}?number=${encodeURIComponent(number)}`);
    }

    async fetchInstanceStatus() {
        return this._request('GET', `/instance/connectionState/${this.instanceName}`);
    }
}

module.exports = { EvolutionClient };

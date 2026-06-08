const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const P = require('pino');
const fs = require('fs');
const path = require('path');
const QR = require('qrcode');
const qrTerm = require('qrcode-terminal');

class BaileysClient {
    constructor(options = {}) {
        this.authFolder = options.authFolder || './auth_info';
        this.sessionName = options.sessionName || 'tn-connect';
        this.sock = null;
        this.connected = false;

        this.onMessage = null;
        this.onParticipantsChanged = null;
        this.onJoinRequest = null;
        this.onConnectionUpdate = null;
        this.onQR = null;
        this.onCredsUpdate = null;

        this.messageCache = new Map();
        this.readyResolve = null;
        this.qrCode = null;
        this.phoneNumber = null;
        this.linkPreviewCache = new Map();
    }

    async init() {
        const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            logger: P({ level: 'silent' }),
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            generateHighQualityLinkPreview: false,
            maxMsgRetryCount: 3,
        });

        sock.ev.on('creds.update', (creds) => {
            saveCreds();
            if (this.onCredsUpdate) this.onCredsUpdate(sock.authState.creds);
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                this.qrCode = qr;
                QR.toFile(path.join(__dirname, 'public', 'qrcode.png'), qr, { width: 400 }, (err) => {
                    if (err) console.error(' [QR] Failed to write PNG:', err.message);
                });
                qrTerm.generate(qr, { small: true });
                if (this.onQR) this.onQR(qr);
            }

            if (connection === 'open') {
                this.connected = true;
                const rawId = sock.authState.creds?.me?.id || '';
this.phoneNumber = rawId.split(':')[0].replace(/[^0-9]/g, '') || null;
                if (this.onConnectionUpdate) this.onConnectionUpdate({ connected: true });
                if (this.readyResolve) this.readyResolve();
            }

            if (connection === 'close') {
                this.connected = false;
                const err = lastDisconnect?.error;
                const code = err?.output?.statusCode;
                const isConflict = err?.message?.includes('conflict') || err?.toString?.()?.includes('conflict');
                const hasCreds = fs.existsSync(path.join(this.authFolder, 'creds.json'));
                const shouldReconnect = (code !== DisconnectReason.loggedOut && code !== 401) || isConflict || !hasCreds;
                if (this.onConnectionUpdate) {
                    this.onConnectionUpdate({ connected: false, error: lastDisconnect?.error, shouldReconnect });
                }
                if (shouldReconnect) {
                    const delay = code === 429 ? 60000 : 5000;
                    setTimeout(() => this.init(), delay);
                }
            }
        });

        sock.ev.on('messages.upsert', ({ messages }) => {
            for (const msg of messages) {
                const jid = msg.key?.remoteJid;
                if (jid) {
                    if (!this.messageCache.has(jid)) this.messageCache.set(jid, []);
                    const cache = this.messageCache.get(jid);
                    cache.unshift(msg);
                    if (cache.length > 50) cache.pop();
                }
                if (this.onMessage) this.onMessage(msg);
            }
        });

        sock.ev.on('group-participants.update', (update) => {
            if (this.onParticipantsChanged) this.onParticipantsChanged(update);
        });

        sock.ev.on('group.join-request', (update) => {
            if (this.onJoinRequest) this.onJoinRequest(update);
        });

        this.sock = sock;

        this.readyPromise = new Promise((resolve) => {
            this.readyResolve = resolve;
        });
    }

    async waitForConnection(timeoutMs = 180000) {
        if (this.connected) return;
        const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Connection timeout after ' + timeoutMs + 'ms')), timeoutMs)
        );
        await Promise.race([this.readyPromise, timeout]);
    }

    async sendText(to, text, options = {}) {
        const msg = { text };
        if (options.mentions?.length) {
            msg.mentions = options.mentions;
        }

        // Try to generate visual link preview if appropriate
        if (!options.skipPreview) {
            try {
                const previewData = await this._getLinkPreviewData(text);
                if (previewData) {
                    msg.contextInfo = {
                        ...(msg.contextInfo || {}),
                        externalAdReply: previewData
                    };
                }
            } catch (e) {
                console.warn(' [Preview] Link preview building failed:', e.message);
            }
        }

        const msgOptions = {};
        if (options.quoted) {
            msgOptions.quoted = options.quoted;
        }

        return this.sock.sendMessage(to, msg, msgOptions);
    }

    async sendMedia(to, mediaUrl, caption, options = {}) {
        const buffer = await this._downloadBuffer(mediaUrl);
        const ext = this._extFromUrl(mediaUrl) || 'png';

        const typeMap = {
            jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image',
            mp4: 'video', mkv: 'video',
            pdf: 'document', doc: 'document', docx: 'document',
        };
        const mimeMap = {
            jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
            gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4',
            pdf: 'application/pdf',
        };

        const type = typeMap[ext] || 'document';
        const msg = {
            [type]: buffer,
            caption: caption || '',
            mimetype: mimeMap[ext] || 'application/octet-stream',
        };
        if (type === 'document') msg.fileName = `file.${ext}`;

        return this.sock.sendMessage(to, msg);
    }

    async setGroupAdminsOnly(groupId, value) {
        return this.sock.groupSettingUpdate(groupId, value ? 'announcement' : 'not_announcement');
    }

    async sendDelete(remoteJid, id, participant, fromMe = false) {
        return this.sock.sendMessage(remoteJid, {
            delete: { remoteJid, id, fromMe, participant: participant || undefined },
        });
    }

    async sendPresence(jid, presence) {
        const states = { typing: 'composing', composing: 'composing', available: 'available', recording: 'recording' };
        return this.sock.sendPresenceUpdate(states[presence] || 'composing', jid);
    }

    async fetchGroups(getParticipants = false) {
        const groups = await this.sock.groupFetchAllParticipating();
        const result = Object.values(groups).map(g => ({
            jid: g.id,
            id: g.id,
            subject: g.subject || 'Unknown Group',
            name: g.subject || 'Unknown Group',
            participants: (g.participants || []).map(p => ({
                id: p.id,
                phoneNumber: (p.phoneNumber || p.id || '').split(':')[0].replace(/[^0-9]/g, '') || '',
                name: p.name || '',
                admin: p.admin || null,
            })),
            owner: g.owner || '',
            size: g.size || g.participants?.length || 0,
        }));
        return { groups: result };
    }

    async leaveGroup(groupId) {
        return this.sock.groupLeave(groupId);
    }

    async fetchGroupInviteCode(groupJid) {
        const code = await this.sock.groupInviteCode(groupJid);
        return { code };
    }

    async fetchMessages(remoteJid, limit = 20) {
        const cached = this.messageCache.get(remoteJid) || [];
        const records = cached.slice(0, limit).map(m => ({
            key: m.key,
            message: m.message,
            messageTimestamp: m.messageTimestamp,
        }));
        return { messages: { records } };
    }

    async addGroupParticipant(groupJid, participants) {
        const raw = Array.isArray(participants) ? participants : [participants];
        const jids = raw.map(j => j.includes('@') ? j : j + '@s.whatsapp.net');
        return this.sock.groupParticipantsUpdate(groupJid, jids, 'add');
    }

    async promoteGroupParticipant(groupJid, participants) {
        const raw = Array.isArray(participants) ? participants : [participants];
        const jids = raw.map(j => j.includes('@') ? j : j + '@s.whatsapp.net');
        return this.sock.groupParticipantsUpdate(groupJid, jids, 'promote');
    }

    async demoteGroupParticipant(groupJid, participants) {
        const raw = Array.isArray(participants) ? participants : [participants];
        const jids = raw.map(j => j.includes('@') ? j : j + '@s.whatsapp.net');
        return this.sock.groupParticipantsUpdate(groupJid, jids, 'demote');
    }

    async removeGroupParticipant(groupJid, participants) {
        const raw = Array.isArray(participants) ? participants : [participants];
        const jids = raw.map(j => j.includes('@') ? j : j + '@s.whatsapp.net');
        return this.sock.groupParticipantsUpdate(groupJid, jids, 'remove');
    }

    async approveGroupJoinRequest(groupJid, participant) {
        const jid = participant.includes('@') ? participant : participant + '@s.whatsapp.net';
        return this.sock.groupRequestParticipantsUpdate(groupJid, [jid], 'approve');
    }

    async rejectGroupJoinRequest(groupJid, participant) {
        const jid = participant.includes('@') ? participant : participant + '@s.whatsapp.net';
        return this.sock.groupRequestParticipantsUpdate(groupJid, [jid], 'reject');
    }

    async fetchGroupJoinRequests(groupJid) {
        return this.sock.groupRequestParticipantsList(groupJid);
    }

    async fetchGroupMetadata(groupJid) {
        try {
            const meta = await this.sock.groupMetadata(groupJid);
            return meta;
        } catch (e) {
            return null;
        }
    }

    async fetchProfilePicture(number) {
        const id = number.endsWith('@s.whatsapp.net') ? number : number + '@s.whatsapp.net';
        try {
            const url = await this.sock.profilePictureUrl(id, 'image');
            return { url };
        } catch {
            return { url: null };
        }
    }

    async fetchInstanceStatus() {
        return { status: this.connected ? 'isLogged' : 'notLogged', connected: this.connected };
    }

    async downloadMediaByMessageKey(messageKey) {
        const buffer = await downloadMediaMessage({ key: messageKey, message: {} }, 'buffer', {}, { sock: this.sock });
        return { base64: buffer.toString('base64') };
    }

    async getMediaBase64(msg) {
        const fullMsg = msg.message ? msg : { key: msg, message: {} };
        const buffer = await downloadMediaMessage(fullMsg, 'buffer', {}, { sock: this.sock });
        return { base64: buffer.toString('base64') };
    }

    getQrCode() {
        return this.qrCode;
    }

    async requestPairingCode(phoneNumber) {
        if (!this.sock) throw new Error('Socket not initialized');
        await this.waitForSocketReady();
        return this.sock.requestPairingCode(phoneNumber);
    }

    async waitForSocketReady() {
        if (this.connected) return;
        const maxRetries = 30;
        for (let i = 0; i < maxRetries; i++) {
            if (this.connected) return;
            try {
                const state = this.sock?.ws?.readyState;
                if (state === 1) return; // WebSocket OPEN
            } catch {}
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    _downloadBuffer(url) {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const mod = parsed.protocol === 'https:' ? require('https') : require('http');
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

    async _getLinkPreviewData(text, forceSkip = false) {
        if (forceSkip || !text) return null;

        // Detect first http/https URL in the text
        const urlRegex = /https?:\/\/[^\s]+/i;
        const match = text.match(urlRegex);
        if (!match) return null;

        const url = match[0];
        
        // Return cached if present (including null if failed previously)
        if (this.linkPreviewCache.has(url)) {
            return this.linkPreviewCache.get(url);
        }

        let meta = null;

        // 1. Try Microlink API (excellent for complex SPAs/TikTok/YouTube redirects)
        try {
            const microlinkUrl = `https://api.microlink.io/?url=${encodeURIComponent(url)}`;
            const res = await this._fetchJson(microlinkUrl, 15000);
            if (res && res.status === 'success' && res.data) {
                meta = {
                    title: res.data.title || '',
                    description: res.data.description || '',
                    image: res.data.image?.url || null,
                    siteName: res.data.publisher || ''
                };
            }
        } catch (e) {
            console.warn(` [Preview] Microlink API query failed for ${url}:`, e.message);
        }

        // 2. Fallback to direct HTML crawling for standard websites
        if (!meta) {
            try {
                const html = await this._fetchHtml(url, 10000);
                if (html) {
                    meta = this._extractOgMetadata(html, url);
                }
            } catch (e) {
                console.warn(` [Preview] Fallback direct scrape failed for ${url}:`, e.message);
            }
        }

        // 3. Process image thumbnail if found
        if (meta && (meta.title || meta.image)) {
            let thumbnailBuffer = null;
            if (meta.image) {
                try {
                    thumbnailBuffer = await this._downloadBufferWithTimeout(meta.image, 10000);
                } catch (e) {
                    console.warn(` [Preview] Failed to download thumbnail for ${url}:`, e.message);
                }
            }

            const previewData = {
                title: meta.title || 'Link Preview',
                body: meta.description || meta.siteName || '',
                mediaType: 1, // 1 = Image/Link
                previewType: 0,
                sourceUrl: url
            };

            if (thumbnailBuffer) {
                previewData.thumbnail = thumbnailBuffer;
            }

            this.linkPreviewCache.set(url, previewData);
            return previewData;
        }

        // Cache failure so we don't spam broken links
        this.linkPreviewCache.set(url, null);
        return null;
    }

    _fetchJson(url, timeoutMs = 4000) {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const mod = parsed.protocol === 'https:' ? require('https') : require('http');
            const req = mod.get(url, { 
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                timeout: timeoutMs 
            }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Timeout'));
            });
        });
    }

    _fetchHtml(url, timeoutMs = 4000, maxRedirects = 3) {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const mod = parsed.protocol === 'https:' ? require('https') : require('http');
            const headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5'
            };
            const req = mod.get(url, { headers, timeout: timeoutMs }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    if (maxRedirects <= 0) {
                        return reject(new Error('Too many redirects'));
                    }
                    const redirectUrl = new URL(res.headers.location, url).toString();
                    return this._fetchHtml(redirectUrl, timeoutMs, maxRedirects - 1).then(resolve).catch(reject);
                }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    resolve(Buffer.concat(chunks).toString('utf8'));
                });
            });
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Timeout'));
            });
        });
    }

    _extractOgMetadata(html, url) {
        const titleRegex = /<meta\s+property=["']og:title["']\s+content=["'](.*?)["']/i;
        const descRegex = /<meta\s+property=["']og:description["']\s+content=["'](.*?)["']/i;
        const imgRegex = /<meta\s+property=["']og:image["']\s+content=["'](.*?)["']/i;
        const siteRegex = /<meta\s+property=["']og:site_name["']\s+content=["'](.*?)["']/i;

        const fallbackTitleRegex = /<title>(.*?)<\/title>/i;
        const fallbackDescRegex = /<meta\s+name=["']description["']\s+content=["'](.*?)["']/i;

        let title = (html.match(titleRegex) || [])[1];
        if (!title) title = (html.match(fallbackTitleRegex) || [])[1];

        let desc = (html.match(descRegex) || [])[1];
        if (!desc) desc = (html.match(fallbackDescRegex) || [])[1];

        let image = (html.match(imgRegex) || [])[1];
        
        let siteName = (html.match(siteRegex) || [])[1];
        if (!siteName) {
            try {
                siteName = new URL(url).hostname;
            } catch {
                siteName = '';
            }
        }

        const decodeEntities = (str) => {
            if (!str) return '';
            return str
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&#x2F;/g, '/');
        };

        return {
            title: decodeEntities(title),
            description: decodeEntities(desc),
            image: image ? new URL(image, url).toString() : null,
            siteName: siteName
        };
    }

    _downloadBufferWithTimeout(url, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const mod = parsed.protocol === 'https:' ? require('https') : require('http');
            const options = {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': 'https://www.tiktok.com/'
                },
                timeout: timeoutMs
            };
            const req = mod.get(url, options, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const redirectUrl = new URL(res.headers.location, url).toString();
                    return this._downloadBufferWithTimeout(redirectUrl, timeoutMs).then(resolve).catch(reject);
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`Failed to download image: Status ${res.statusCode}`));
                }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            });
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Timeout'));
            });
        });
    }
}

module.exports = { BaileysClient };

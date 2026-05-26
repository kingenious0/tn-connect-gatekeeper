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
        return this.sock.sendMessage(to, msg);
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
                phoneNumber: p.id.replace(/[^0-9]/g, ''),
                name: p.name || '',
                admin: p.admin || null,
            })),
            owner: g.owner || '',
            size: g.size || g.participants?.length || 0,
        }));
        return { groups: result };
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

    async approveGroupJoinRequest(groupJid, participant) {
        const jid = participant.includes('@') ? participant : participant + '@s.whatsapp.net';
        return this.sock.groupRequestParticipantsUpdate(groupJid, [jid], 'approve');
    }

    async fetchGroupJoinRequests(groupJid) {
        return this.sock.groupRequestParticipantsList(groupJid);
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
}

module.exports = { BaileysClient };

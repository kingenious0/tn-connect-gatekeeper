// Version 1.3 Pro - Single-Worker Cloud Engine with Anti-Ban & Gemini Multimodal
require('dotenv').config();
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    delay,
    downloadMediaMessage,
    getContentType,
    jidNormalizedUser
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const P = require('pino');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http'); // Import http module
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { generateChatScreenshot } = require('./chatScreenshot');

// ==========================================
// 📡 SERVER CONFIGURATION & MIDDLEWARE
// ==========================================
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 10000;
const SESSION_META_FILE = './sessions_meta.json';
const REGISTRY_FILE = './registry.json';
const APPLICANTS_FILE = './business_hub_applicants.json';
const GROUP_FLOWS_FILE = './group_flows.json';

// Global variables for active socket sessions and status
let sock = null;
let activeSessionPhone = null;
let isReconnecting = false;
let intentionalLogout = false;
const reconnectTimers = {};
const activeSessions = {};
const activeQRs = {};
const pendingApprovals = new Map(); // screenshot aggregation cache
const pendingVerifications = new Map(); // Gemini screenshot verification tracker per user { tiktok, social, channel }
const businessHubConversations = new Map(); // Gemini AI conversation history per user (phone -> history[])
const humanTakeoverUsers = new Set(); // users flagged for manual admin takeover

const uploadDebounces = {}; // debounces for Supabase credentials upload

// Admin Alerts Group — auto-detected by name on boot
let adminAlertsGroupJid = null;

// Departure Nudge Master Switch — set to true to enable safe departure DMs
const ENABLE_DEPARTURE_NUDGE = false;
const departureNudgedUsers = new Set(); // one-strike tracker: never message twice

// ==========================================
// 🗄️ SUPABASE DATABASE INITIALIZATION
// ==========================================
const supabaseUrl = process.env.SUPABASE_URL || process.env['Project URL'];
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env['anon public key'];
let supabase = null;
try {
    supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey, {
        realtime: { transport: ws }
    }) : null;
} catch (e) {
    console.error("❌ [Supabase] Client initialization failed (check URL/Key format):", e.message);
    supabase = null;
}

if (supabase) {
    console.log("💾 [Database] Supabase credentials detected! Cloud Backup Engine is ACTIVE.");
} else {
    console.log("⚠️ [Database] Supabase variables missing. Running in OFFLINE / Local File Mode.");
}

// ==========================================
// 📋 OFFICIAL MESSAGES & GROUPS REFERENCE
// ==========================================
const GATEKEEPER_MESSAGE = `*{hello|hi|hey}, we just got your request to join our group*\r\n🚨ACTION REQUIRED🚨\r\n\r\nTo be approved into the niche group first join one of the general market groups (tap links in channel to see all the links).\r\n\r\nTikTok: Follow *TN FILMS GH*\r\n\r\n\r\nWe\'ll view your chat before approving. {If we get to your chat and you\'ve not done these we will cancel your request.|Please complete these steps to avoid your request being cancelled.} Follow these steps \r\n\r\nFacebook/Instagram: Follow *TN UNIVERSITIES CONNECT*\r\n\r\nWhatsApp Channel: Join our official update channel: https://whatsapp.com/channel/0029VbCNby81CYoPIpEQMD1D\r\n⚠️ Delay = Cancellation. We are clearing the pending list.\r\n\r\nOnce you\'ve followed all, send a DONE({with a screenshot|along with screenshots}). \r\n\r\nWe are viewing chats before approving. If we get to your chat twice and you\'ve not done so we will cancel your request\r\n\r\nSEND ME SCREENSHOTS WHEN DONE`;

// Business Hub intro DM — dynamic variations to avoid WhatsApp spam detection
const BUSINESS_HUB_INTRO_MESSAGE = () => {
    const greetings = ['Hello', 'Hi there', 'Hey', 'Good day', 'Greetings'];
    const intros = [
        `I\'m the virtual intake coordinator assisting the TN Connect team`,
        `I\'m a coordinator helping the TN Connect team process new applications`,
        `I assist the TN Connect team with intake coordination`,
        `I work with the TN Connect team to welcome and screen new members`,
    ];
    const checks = [
        'Has any of our team reached out to you already? If yes, just let me know their name.',
        'Has an admin already contacted you about this? If so, kindly share their name.',
        'Have you been contacted by one of our admins yet? If yes, reply with their name.',
    ];
    const prompts = [
        `If not, could you share a bit about yourself and your business? We\'d love to know what you do and where you\'re based in Winneba.`,
        `If no one has reached out yet, tell us a little about yourself — your business name, what you do, and your location in Winneba.`,
        `If not, kindly introduce yourself — what\'s your business about and where are you located in Winneba?`,
    ];
    const g = greetings[Math.floor(Math.random() * greetings.length)];
    const i = intros[Math.floor(Math.random() * intros.length)];
    const c = checks[Math.floor(Math.random() * checks.length)];
    const p = prompts[Math.floor(Math.random() * prompts.length)];
    return `${g}, thanks for requesting to join TN Winneba Business Hub 💼. ${i}.\n\n${c}\n\n${p}`;
};

// Gemini AI system prompt — acts as a professional business intake coordinator
const BUSINESS_HUB_SYSTEM_PROMPT = `You are a sharp, professional business intake coordinator for TN Winneba Business Hub — an exclusive networking community for serious business owners in Winneba, Ghana. You represent the TN Uni Connect admin team.\r\n\r\nYour job is to screen and onboard business applicants through a natural, concise conversation. Collect the following in this EXACT order, one or two at a time:\r\n1. Full name\r\n2. Are they a resident of Winneba? (ask this SECOND — before any business questions)\r\n3. Business name and type\r\n4. Exact location in Winneba\r\n5. Products or services offered\r\n6. Open to partnerships and vacancy sharing? (yes/no)\r\n7. How TN members and Ghanaians benefit from their business\r\n\r\nResidency Rule (CRITICAL — check at step 2, immediately after getting their name):\r\n- If they say YES to being a Winneba resident → continue with the remaining business questions (3-7)\r\n- If they say NO to being a Winneba resident → ask ONE follow-up: "If we organise a physical meet-up in Winneba, would you be able to attend?"\r\n  - If YES to attending → continue with the remaining business questions (3-7), treat as approved\r\n  - If NO to attending → close gracefully immediately. Thank them warmly, tell them the hub is currently focused on people who can be physically present in Winneba, let them know TN Connect has other exciting opportunities suited to them and an admin will reach out soon. Then end with the [RESIDENT_DECLINED] marker on a new line. No JSON needed for this path. Do NOT ask any more business questions.\r\n\r\nStyle Rules:\r\n- Be concise. One clear question per message, maximum two sentences. No paragraphs.\r\n- Sound like a sharp, experienced business networker — warm but efficient\r\n- Never sound like a bot or a form. Speak like a real person\r\n- Do not use excessive emojis — one per message maximum\r\n- Never reveal you are an AI\r\n- If someone gives a vague or off-topic reply, redirect sharply but politely.`;

// Gemini client + model initialization
const geminiClient = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const geminiModel = geminiClient ? geminiClient.getGenerativeModel({
    model: 'gemini-2.5-flash-lite',
    systemInstruction: BUSINESS_HUB_SYSTEM_PROMPT
}) : null;

if (geminiModel) {
    console.log('🤖 [Gemini] AI intake engine is ACTIVE for Business Hub groups.');
} else {
    console.log('⚠️ [Gemini] GEMINI_API_KEY missing. Business Hub AI intake will be DISABLED.');
}

const OFFICIAL_NICHE_GROUPS = [
    "1️⃣ Corporate Events & Protocol Personnel",
    "2️⃣ Marketing, Publicity & Brand Awareness Personnel",
    "3️⃣ Healthcare, Wellness & Safety Personnel",
    "4️⃣ Technical, Engineering & IT Support",
    "5️⃣ Media Production & Post-Production Personnel",
    "6️⃣ Professional Grooming & Aesthetics Personnel",
    "7️⃣ Enterprise, Leadership & Business Strategy Personnel",
    "8️⃣ Voice & Audio Branding Personnel",
    "9️⃣ Field Sales & Market Activations Personnel",
    "🔟 Performance & Commercial Talent Personnel"
];

// ==========================================
// 💾 DATABASE UTILITIES & DIRECTORY SERIALIZER
// ==========================================

const serializeDirectory = (dirPath) => {
    const filesData = {};
    if (!fs.existsSync(dirPath)) return filesData;
    
    try {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stat = fs.statSync(filePath);
            if (stat.isFile()) {
                const content = fs.readFileSync(filePath);
                filesData[file] = content.toString('base64');
            }
        }
    } catch (e) {
        console.error('❌ Failed to serialize folder ' + dirPath + ':', e);
    }
    return filesData;
};

const deserializeDirectory = (dirPath, filesData) => {
    try {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        for (const [file, base64Content] of Object.entries(filesData)) {
            const filePath = path.join(dirPath, file);
            fs.writeFileSync(filePath, Buffer.from(base64Content, 'base64'));
        }
    } catch (e) {
        console.error('❌ Failed to deserialize folder ' + dirPath + ':', e);
    }
};

const loadSessionMeta = () => {
    if (!fs.existsSync(SESSION_META_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(SESSION_META_FILE, 'utf-8'));
    } catch (e) {
        return {};
    }
};

const saveSessionMeta = (meta) => {
    try {
        fs.writeFileSync(SESSION_META_FILE, JSON.stringify(meta, null, 2));
    } catch (e) {
        console.error("❌ Failed to write sessions_meta.json:", e);
    }
};

const loadRegistry = () => {
    if (!fs.existsSync(REGISTRY_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    } catch (e) {
        return {};
    }
};

const saveRegistry = (data) => {
    try {
        fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error("❌ Failed to write registry.json:", e);
    }
};

const saveRegistryItem = async (key, item) => {
    const registry = loadRegistry();
    registry[key] = item;
    saveRegistry(registry);

    if (supabase) {
        try {
            const { error } = await supabase
                .from('gatekeeper_registry')
                .upsert({
                    key,
                    admin_name: item.admin,
                    phone: item.phone,
                    group_jid: item.groupJid,
                    status: item.status,
                    timestamp: item.timestamp
                });
            if (error) console.error("❌ [Supabase] Registry save failure:", error.message);
        } catch (err) {
            console.error("❌ [Supabase] Registry sync crash:", err);
        }
    }
};

const triggerSessionBackup = (phone, adminName, selectedGroups, discoveredGroups) => {
    if (!supabase) return;

    if (uploadDebounces[phone]) {
        clearTimeout(uploadDebounces[phone]);
    }

    uploadDebounces[phone] = setTimeout(async () => {
        try {
            const dirPath = 'auth_session_' + phone;
            const files = serializeDirectory(dirPath);

            console.log('💾 [Supabase] Pushing backup for Admin node +' + phone + '...');
            const { error } = await supabase
                .from('gatekeeper_sessions')
                .upsert({
                    phone,
                    admin_name: adminName,
                    selected_groups: selectedGroups,
                    discovered_groups: discoveredGroups,
                    files,
                    updated_at: new Date().toISOString()
                });

            if (error) console.error('❌ [Supabase] Backup error for +' + phone + ':', error.message);
            else console.log('✅ [Supabase] Session data backed up successfully for +' + phone + '!');
        } catch (err) {
            console.error('❌ [Supabase] System error backing up session for +' + phone + ':', err);
        }
    }, 5000);
};

const isBusinessHubGroup = (groupName) => {
    const name = (groupName || '').toLowerCase();
    return name.includes('business hub') || name.includes('winneba business');
};

const isGroupJidBusinessHub = (groupJid, adminPhone) => {
    if (!groupJid) return false;
    const cleanPhone = (adminPhone || '').replace(/[^0-9]/g, '');
    if (!cleanPhone) return false;
    
    const meta = loadSessionMeta();
    const adminMeta = meta[cleanPhone];
    if (adminMeta && adminMeta.discoveredGroups) {
        const group = adminMeta.discoveredGroups.find(g => g.jid === groupJid);
        if (group && isBusinessHubGroup(group.subject)) {
            return true;
        }
    }
    return false;
};

// ==========================================
// 🔍 PENDING REQUEST RESOLVER
// ==========================================
const findPendingRequest = (senderJid) => {
    const registry = loadRegistry();
    const cleanSender = senderJid.replace('@s.whatsapp.net', '').replace('@lid', '');
    
    for (const key of Object.keys(registry)) {
        const entry = registry[key];
        const closedStatuses = ['approved', 'verification_complete', 'interview_complete', 'non_resident_declined'];
        if (key.includes(cleanSender) && !closedStatuses.includes(entry.status)) {
            const isBizHub = entry.groupType === 'business_hub' || isGroupJidBusinessHub(entry.groupJid, entry.phone);
            if (!isBizHub) {
                return { key, ...entry };
            }
        }
    }
    return null;
};

const findBusinessHubRequest = (senderJid) => {
    const registry = loadRegistry();
    const cleanSender = senderJid.replace('@s.whatsapp.net', '').replace('@lid', '');
    for (const key of Object.keys(registry)) {
        const entry = registry[key];
        if (key.includes(cleanSender) && entry.status !== 'interview_complete') {
            const isBizHub = entry.groupType === 'business_hub' || isGroupJidBusinessHub(entry.groupJid, entry.phone);
            if (isBizHub) {
                return { key, ...entry };
            }
        }
    }
    return null;
};

// ==========================================
// 🚪 JOIN REQUEST & GATEKEEPER AUTOMATION
// ==========================================
const groupSubjectCache = new Map();
const joinIntroSentKeys = new Set();

const parseSpintax = (template) => {
    return template.replace(/\{([^{}]+)\}/g, (_, options) => {
        const parts = options.split('|');
        return parts[Math.floor(Math.random() * parts.length)];
    });
};

const buildGatekeeperMessage = () => parseSpintax(GATEKEEPER_MESSAGE);

const participantDigits = (jid) => (jid || '').replace(/@s\.whatsapp\.net/gi, '').replace(/@lid/gi, '').replace(/\D/g, '');

const buildRegistryKey = (groupJid, participantJid) => {
    return groupJid + '_' + participantDigits(participantJid);
};

const dmJidFromParticipant = (participantJid) => {
    const normalized = jidNormalizedUser(participantJid);
    if (normalized.endsWith('@g.us')) return null;
    return normalized.includes('@') ? normalized : normalized + '@s.whatsapp.net';
};

const getBotAdminContext = () => {
    const phone = getSocketPhone() || activeSessionPhone || '';
    const meta = loadSessionMeta()[phone] || {};
    return {
        phone,
        name: meta.adminName || 'TN Connect Assistant'
    };
};

const getGroupSubject = async (socket, groupJid) => {
    if (groupSubjectCache.has(groupJid)) return groupSubjectCache.get(groupJid);

    const botPhone = getSocketPhone();
    const meta = loadSessionMeta()[botPhone] || {};
    const discovered = (meta.discoveredGroups || []).find(g => g.jid === groupJid);
    if (discovered?.subject) {
        groupSubjectCache.set(groupJid, discovered.subject);
        return discovered.subject;
    }

    try {
        const metadata = await socket.groupMetadata(groupJid);
        const subject = metadata.subject || 'Unknown Group';
        groupSubjectCache.set(groupJid, subject);
        return subject;
    } catch (e) {
        console.warn('⚠️ [Groups] Could not fetch metadata for ' + groupJid + ':', e.message);
        return 'Unknown Group';
    }
};

const classifyGroupType = (groupSubject, groupJid, adminPhone) => {
    if (isBusinessHubGroup(groupSubject) || isGroupJidBusinessHub(groupJid, adminPhone)) {
        return 'business_hub';
    }
    return 'niche';
};

const extractIncomingPayload = (msg) => {
    const content = msg.message;
    if (!content) return { text: '', hasImage: false };

    const text =
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.documentMessage?.caption ||
        '';

    const msgType = getContentType(content);
    const hasImage = msgType === 'imageMessage' || (msgType === 'documentMessage' && content.documentMessage?.mimetype?.startsWith('image/'));

    return { text: (text || '').trim(), hasImage, msgType, content };
};

const downloadImageBuffer = async (socket, msg) => {
    try {
        const buffer = await downloadMediaMessage(
            msg,
            'buffer',
            {},
            { logger: P({ level: 'silent' }), reuploadRequest: socket.updateMediaMessage }
        );
        const mime = msg.message?.imageMessage?.mimetype || msg.message?.documentMessage?.mimetype || 'image/jpeg';
        return { buffer, mime };
    } catch (e) {
        console.error('❌ [Media] Failed to download image:', e.message);
        return null;
    }
};

const classifyScreenshotWithGemini = async (buffer, mime) => {
    if (!geminiClient) return [];
    try {
        const model = geminiClient.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
        const result = await model.generateContent([
            {
                text: 'You verify join-request screenshots for TN Connect Ghana. ' +
                    'Reply with ONLY comma-separated tags from this list: TIKTOK, SOCIAL, CHANNEL, UNKNOWN. ' +
                    'TIKTOK = TikTok follow for TN FILMS GH. ' +
                    'SOCIAL = Instagram or Facebook follow for TN UNIVERSITIES CONNECT. ' +
                    'CHANNEL = WhatsApp channel membership. ' +
                    'If unclear, include UNKNOWN.'
            },
            { inlineData: { data: buffer.toString('base64'), mimeType: mime || 'image/jpeg' } }
        ]);
        const raw = (result.response.text() || '').toUpperCase();
        const tags = [];
        if (raw.includes('TIKTOK')) tags.push('tiktok');
        if (raw.includes('SOCIAL')) tags.push('social');
        if (raw.includes('CHANNEL')) tags.push('channel');
        return tags;
    } catch (e) {
        console.error('❌ [Gemini] Screenshot classify failed:', e.message);
        return [];
    }
};

const initVerificationState = (userPhone) => {
    const state = { tiktok: false, social: false, channel: false, screenshots: 0 };
    pendingVerifications.set(userPhone, state);
    return state;
};

const getVerificationState = (userPhone) => {
    if (!pendingVerifications.has(userPhone)) {
        return initVerificationState(userPhone);
    }
    return pendingVerifications.get(userPhone);
};

const processJoinRequest = async (socket, groupJid, participantJid, action, groupSubjectHint) => {
    if (!participantJid || !groupJid) return;
    if (action && action !== 'created') {
        console.log('ℹ️ [Join] Ignoring join action "' + action + '" for ' + participantJid);
        return;
    }

    const dmJid = dmJidFromParticipant(participantJid);
    if (!dmJid) {
        console.warn('⚠️ [Join] Could not resolve DM JID for participant:', participantJid);
        return;
    }

    const registryKey = buildRegistryKey(groupJid, participantJid);
    if (joinIntroSentKeys.has(registryKey)) return;

    const registry = loadRegistry();
    const existing = registry[registryKey];
    if (existing && ['intro_sent', 'pending', 'verification_complete', 'interview_complete'].includes(existing.status)) {
        console.log('ℹ️ [Join] Already processed ' + registryKey + ' (status: ' + existing.status + ')');
        return;
    }

    const admin = getBotAdminContext();
    const groupSubject = groupSubjectHint || await getGroupSubject(socket, groupJid);
    const groupType = classifyGroupType(groupSubject, groupJid, admin.phone);

    const entry = {
        admin: admin.name,
        phone: admin.phone,
        groupJid,
        groupSubject,
        groupType,
        participantJid: dmJid,
        status: 'intro_sent',
        timestamp: new Date().toISOString()
    };

    await saveRegistryItem(registryKey, entry);
    joinIntroSentKeys.add(registryKey);

    console.log('📥 [Join] New ' + groupType + ' request: ' + groupSubject + ' from ' + dmJid);

    try {
        if (groupType === 'business_hub') {
            const intro = BUSINESS_HUB_INTRO_MESSAGE();
            await sendAntiBanMessage(socket, dmJid, { text: intro });
            console.log('💼 [Business Hub] Intro DM sent to ' + dmJid);
        } else {
            const intro = buildGatekeeperMessage();
            await sendAntiBanMessage(socket, dmJid, { text: intro });
            initVerificationState(formatPhoneNumberGH(participantDigits(dmJid)));
            console.log('🛡️ [Gatekeeper] Requirements DM sent to ' + dmJid);
        }
    } catch (e) {
        console.error('❌ [Join] Failed to send intro DM to ' + dmJid + ':', e.message);
        joinIntroSentKeys.delete(registryKey);
    }
};

const scanPendingJoinRequests = async (socket) => {
    const admin = getBotAdminContext();
    const meta = loadSessionMeta()[admin.phone] || {};
    const groups = meta.discoveredGroups || [];
    if (!groups.length) return;

    console.log('🔍 [Join] Scanning ' + groups.length + ' groups for pending join requests...');
    for (const group of groups) {
        try {
            const pending = await socket.groupRequestParticipantsList(group.jid);
            if (!pending?.length) continue;
            for (const item of pending) {
                const participantJid = item.jid || item.participant || item.requestor;
                if (!participantJid) continue;
                await processJoinRequest(socket, group.jid, participantJid, 'created', group.subject);
                await delay(1500);
            }
        } catch (e) {
            console.warn('⚠️ [Join] Could not list pending requests for ' + group.subject + ':', e.message);
        }
    }
};

const handleGatekeeperDM = async (socket, senderJid, msg, pendingRequest) => {
    const userPhone = formatPhoneNumberGH(participantDigits(senderJid));
    if (humanTakeoverUsers.has(userPhone)) return;

    const { text, hasImage } = extractIncomingPayload(msg);
    const verify = getVerificationState(userPhone);
    let verificationUpdated = false;

    if (hasImage) {
        const media = await downloadImageBuffer(socket, msg);
        if (media?.buffer) {
            verify.screenshots += 1;
            const tags = await classifyScreenshotWithGemini(media.buffer, media.mime);
            if (tags.includes('tiktok')) verify.tiktok = true;
            if (tags.includes('social')) verify.social = true;
            if (tags.includes('channel')) verify.channel = true;
            verificationUpdated = true;

            const confirmed = [];
            if (verify.tiktok) confirmed.push('TikTok ✓');
            if (verify.social) confirmed.push('Instagram/Facebook ✓');
            if (verify.channel) confirmed.push('WhatsApp Channel ✓');

            let feedback = '📸 Screenshot received.';
            if (confirmed.length) feedback += ' Verified: ' + confirmed.join(', ') + '.';
            const missing = [];
            if (!verify.tiktok) missing.push('TikTok (TN FILMS GH)');
            if (!verify.social) missing.push('Facebook/Instagram (TN UNIVERSITIES CONNECT)');
            if (!verify.channel) missing.push('WhatsApp Channel');
            if (missing.length) feedback += ' Still needed: ' + missing.join(', ') + '.';
            feedback += ' Reply DONE when finished.';

            await sendAntiBanMessage(socket, senderJid, { text: feedback });
        }
    }

    const saidDone = /\bdone\b/i.test(text);
    if (saidDone || (verificationUpdated && verify.tiktok && verify.social && verify.channel)) {
        const ready = verify.tiktok && verify.social && verify.channel;
        if (ready || (saidDone && verify.screenshots >= 2)) {
            const registry = loadRegistry();
            if (registry[pendingRequest.key]) {
                registry[pendingRequest.key].status = 'verification_complete';
                await saveRegistryItem(pendingRequest.key, registry[pendingRequest.key]);
            }

            await sendAntiBanMessage(socket, senderJid, {
                text: '✅ Thanks! Your proof has been received. An admin will review your request to join *' +
                    (pendingRequest.groupSubject || 'the group') + '* shortly.'
            });

            const alertText = [
                '✅ *[GATEKEEPER VERIFICATION COMPLETE]*',
                '',
                '📞 *Applicant:* ' + userPhone,
                '🌐 *Group:* ' + (pendingRequest.groupSubject || pendingRequest.groupJid),
                '📸 *Proof:* TikTok ' + (verify.tiktok ? '✓' : '✗') + ' | Social ' + (verify.social ? '✓' : '✗') + ' | Channel ' + (verify.channel ? '✓' : '✗'),
                '',
                'Review in WhatsApp and approve or reject the pending member.'
            ].join('\n');
            await sendAdminAlert(socket, alertText);
            pendingVerifications.delete(userPhone);
            return;
        }

        if (saidDone && !ready) {
            await sendAntiBanMessage(socket, senderJid, {
                text: '⚠️ You replied DONE but we still need proof for: ' +
                    [
                        !verify.tiktok ? 'TikTok' : null,
                        !verify.social ? 'Social' : null,
                        !verify.channel ? 'Channel' : null
                    ].filter(Boolean).join(', ') +
                    '. Please send clear screenshots, then reply DONE again.'
            });
            return;
        }
    }

    if (text && !hasImage && !saidDone) {
        await sendAntiBanMessage(socket, senderJid, {
            text: 'Please follow the steps in our earlier message (TikTok, Facebook/Instagram, WhatsApp Channel), send screenshots, then reply *DONE* when finished.'
        });
    }
};

// ==========================================
// 🛒 BUSINESS HUB APPLICANT STORAGE
// ==========================================
const loadApplicants = () => {
    if (!fs.existsSync(APPLICANTS_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(APPLICANTS_FILE, 'utf-8')); }
    catch (e) { return []; }
};

const saveApplicant = async (applicantData) => {
    const applicants = loadApplicants();
    const entry = { ...applicantData, id: Date.now(), createdAt: new Date().toISOString(), status: 'pending_review' };
    applicants.push(entry);
    try {
        fs.writeFileSync(APPLICANTS_FILE, JSON.stringify(applicants, null, 2));
    } catch (e) {
        console.error('❌ Failed to save applicant locally:', e);
    }
    if (supabase) {
        try {
            await supabase.from('business_hub_applicants').insert({
                phone: applicantData.phone || '',
                name: applicantData.name || '',
                business_name: applicantData.businessName || '',
                business_type: applicantData.businessType || '',
                location: applicantData.location || '',
                services: applicantData.services || '',
                partnerships: applicantData.partnerships || '',
                benefit: applicantData.benefit || '',
                status: 'pending_review'
            });
        } catch (e) {
            console.error('❌ [Supabase] Applicant insert failed (table may not exist yet):', e.message);
        }
    }
    return entry;
};

// ==========================================
// 🤖 GEMINI AI BUSINESS HUB CONVERSATION
// ==========================================
const callGeminiWithRetry = async (chat, textInput, retries = 3, initialDelayMs = 2000) => {
    let currentDelay = initialDelayMs;
    for (let i = 0; i < retries; i++) {
        try {
            return await chat.sendMessage(textInput);
        } catch (err) {
            const errStr = String(err.message || err);
            const isTransient = errStr.includes('503') || errStr.includes('429') || errStr.includes('Service Unavailable') || errStr.includes('Resource exhausted') || errStr.includes('overloaded');
            if (isTransient && i < retries - 1) {
                console.warn('⚠️ [Gemini] API returned transient error: "' + errStr + '". Retrying in ' + currentDelay + 'ms (Attempt ' + (i + 1) + '/' + retries + ')...');
                await delay(currentDelay);
                currentDelay *= 2;
                continue;
            }
            throw err;
        }
    }
};

const formatPhoneNumberGH = (jidPhone) => {
    if (!jidPhone) return '';
    const digits = jidPhone.replace(/[^0-9]/g, '');
    
    if (digits.startsWith('233') && digits.length === 12) {
        return '0' + digits.substring(3);
    }
    
    if (digits.startsWith('0')) {
        return digits;
    }
    
    return '+' + digits;
};

const handleBusinessHubConversation = async (sock, senderJid, textInput, bizHubRequest, adminName) => {
    if (!geminiClient) return;
    const rawPhone = senderJid.replace('@s.whatsapp.net', '').replace('@lid', '');
    const userPhone = formatPhoneNumberGH(rawPhone);

    if (humanTakeoverUsers.has(userPhone)) return;

    let history = businessHubConversations.get(userPhone);
    if (!history) {
        if (supabase) {
            try {
                const { data } = await supabase
                    .from('business_hub_conversations')
                    .select('history')
                    .eq('phone', userPhone)
                    .single();
                if (data?.history) {
                    history = JSON.parse(data.history);
                    console.log('📦 [Business Hub] Restored ' + history.length + ' conversation turns from Supabase for +' + userPhone);
                }
            } catch (e) { /* no prior history */ }
        }
        history = history || [];
        businessHubConversations.set(userPhone, history);
    }

    const cleanPhone = sock.user?.id ? sock.user.id.split(':')[0].replace(/[^0-9]/g, '') : '';
    const adminRole = cleanPhone ? ((loadSessionMeta()[cleanPhone] || {}).role || 'Admin') : 'Admin';

    const dynamicInstruction = BUSINESS_HUB_SYSTEM_PROMPT + '\r\n\r\nIMPORTANT CONTEXT FOR YOUR IDENTITY:\r\n- You represent the specific admin named "' + adminName + '" who is the "' + adminRole + '" of TN Uni Connect.\r\n- If the applicant mentions they haven\'t gotten any text from an admin, or asks who you are, explain that you are the virtual intake coordinator assisting ' + adminName + ' (' + adminRole + ') to gather their business details.\r\n- Never use placeholder texts like "[Your Name]". Introduce yourself naturally as a human coordinator or professional assistant representing ' + adminName + ' (e.g., "I\'m the virtual intake coordinator assisting ' + adminName + '..." or "I\'m a coordinator assisting ' + adminName + '..."). Never write grammatically incorrect sentences like "My name is your virtual intake coordinator".';

    try {
        const modelInstance = geminiClient.getGenerativeModel({
            model: 'gemini-2.5-flash-lite',
            systemInstruction: dynamicInstruction
        });
        const chat = modelInstance.startChat({ history });
        const result = await callGeminiWithRetry(chat, textInput);
        const responseText = result.response.text();

        const INTAKE_MARKER = '[INTAKE_COMPLETE]';
        const DECLINED_MARKER = '[RESIDENT_DECLINED]';
        const HUMAN_MARKER = '[TRIGGER_HUMAN]';

        const isComplete = responseText.includes(INTAKE_MARKER);
        const isDeclined = responseText.includes(DECLINED_MARKER);

        let cleanResponse = responseText
            .replace(INTAKE_MARKER, '')
            .replace(DECLINED_MARKER, '')
            .replace(HUMAN_MARKER, '')
            .trim();

        let applicantData = null;
        if (isComplete) {
            const markerIndex = responseText.indexOf(INTAKE_MARKER);
            cleanResponse = responseText.substring(0, markerIndex).trim();
            const jsonStr = responseText.substring(markerIndex + INTAKE_MARKER.length).trim();
            try {
                applicantData = JSON.parse(jsonStr);
                applicantData.phone = userPhone;
            } catch (e) {
                console.error('❌ [Gemini] Failed to parse intake JSON:', e.message);
                applicantData = { phone: userPhone, raw: jsonStr };
            }
        }

        history.push({ role: 'user', parts: [{ text: textInput }] });
        history.push({ role: 'model', parts: [{ text: responseText }] });
        businessHubConversations.set(userPhone, history);

        if (supabase) {
            try {
                await supabase.from('business_hub_conversations').upsert({
                    phone: userPhone,
                    history: JSON.stringify(history),
                    updated_at: new Date().toISOString()
                }, { onConflict: 'phone' });
            } catch (e) {
                console.error('❌ [Business Hub] Failed to persist conversation to Supabase:', e.message);
            }
        }

        if (cleanResponse) {
            const readDelay = Math.floor(Math.random() * 2000) + 1500;
            await delay(readDelay);

            const typingDuration = Math.min(Math.max(Math.floor(cleanResponse.length / 40) * 1000, 3000), 12000);
            await sock.sendPresenceUpdate('composing', senderJid);
            await delay(typingDuration);
            await sock.sendPresenceUpdate('paused', senderJid);

            await sendAntiBanMessage(sock, senderJid, { text: cleanResponse });
        }

        const sendAlertWithScreenshot = async (alertText) => {
            await sendAdminAlert(sock, alertText);
            try {
                const screenshotBuffer = generateChatScreenshot(history, '+' + userPhone, 'Business Hub Intake');
                if (screenshotBuffer && adminAlertsGroupJid) {
                    await sock.sendMessage(adminAlertsGroupJid, {
                        image: screenshotBuffer,
                        caption: '📸 Chat transcript for ' + userPhone
                    });
                    console.log('📸 [Screenshot] Chat image sent to admin alerts group for +' + userPhone);
                }
            } catch (imgErr) {
                console.error('❌ [Screenshot] Failed to send chat image (text alert was sent):', imgErr.message);
            }
        };

        if (isDeclined) {
            console.log('🚫 [Business Hub] Non-resident declined physical attendance for +' + userPhone + '. Closing intake.');
            humanTakeoverUsers.add(userPhone);
            businessHubConversations.delete(userPhone);
            if (supabase) {
                try { await supabase.from('business_hub_conversations').delete().eq('phone', userPhone); } catch(e) {}
            }
            const registry = loadRegistry();
            if (registry[bizHubRequest.key]) {
                registry[bizHubRequest.key].status = 'non_resident_declined';
                await saveRegistryItem(bizHubRequest.key, registry[bizHubRequest.key]);
            }
            await sendAlertWithScreenshot('🚫 *[NON-RESIDENT DECLINED]*\n\n📞 *Number:* ' + userPhone + '\n🏘️ Not based in Winneba and cannot attend physical meetings.\nIntake closed. Manual follow-up optional.');
        }

        if (responseText.includes(HUMAN_MARKER)) {
            console.log('⚠️ [Business Hub] Human handooff triggered for +' + userPhone + '. Alerting admins...');
            humanTakeoverUsers.add(userPhone);
            const alertText = '⚠️ *[HUMAN HANDOFF REQUIRED]* ⚠️\n\n📞 *Number:* ' + userPhone + '\n💬 *Last message:* "' + textInput + '"\n\nThe AI has been paused. Open a DM with ' + userPhone + ' to take over.';
            await sendAlertWithScreenshot(alertText);
        }

        if (isComplete && applicantData) {
            console.log('✅ [Business Hub] Intake complete for +' + userPhone + '. Saving applicant data...');
            await saveApplicant(applicantData);

            const summaryLines = [
                '✅ *[NEW BUSINESS HUB APPLICANT]* ✅',
                '',
                '📞 *Number:* ' + userPhone + '\n👤 *Name:* ' + (applicantData.name || 'N/A') + '\n🏢 *Business:* ' + (applicantData.businessName || 'N/A') + ' (' + (applicantData.businessType || 'N/A') + ')\n📍 *Location:* ' + (applicantData.location || 'N/A') + '\n🛒 *Services:* ' + (applicantData.services || 'N/A') + '\n🤝 *Partnerships:* ' + (applicantData.partnerships || 'N/A') + '\n💡 *Benefit:* ' + (applicantData.benefit || 'N/A') + '\n🏘️ *Winneba Resident:* ' + (applicantData.resident || 'N/A')
            ].join('\n');
            await sendAlertWithScreenshot(summaryLines);

            const registry = loadRegistry();
            if (registry[bizHubRequest.key]) {
                registry[bizHubRequest.key].status = 'interview_complete';
                await saveRegistryItem(bizHubRequest.key, registry[bizHubRequest.key]);
            }

            businessHubConversations.delete(userPhone);
            if (supabase) {
                try { await supabase.from('business_hub_conversations').delete().eq('phone', userPhone); } catch(e) {}
            }
        }
    } catch (err) {
        console.error('❌ [Gemini] API call failed after retries:', err.message || err);
    }
};

// ==========================================
// 📱 WHATSAPP SESSION LIFECYCLE
// ==========================================
const getSocketPhone = () => {
    if (!sock?.user?.id) return null;
    return sock.user.id.split(':')[0].replace(/\D/g, '');
};

const normalizeApplicant = (row) => ({
    id: row.id,
    phone: row.phone || '',
    name: row.name || '',
    businessName: row.businessName || row.business_name || '',
    businessType: row.businessType || row.business_type || '',
    location: row.location || '',
    services: row.services || '',
    partnerships: row.partnerships || '',
    benefit: row.benefit || '',
    status: row.status || 'pending_review',
    createdAt: row.createdAt || row.created_at || null
});

const detectAdminAlertsGroup = async (socket) => {
    try {
        const groups = await socket.groupFetchAllParticipating();
        const keyword = (process.env.ADMIN_ALERTS_GROUP_KEYWORD || 'admin alert').toLowerCase();
        for (const [, meta] of Object.entries(groups)) {
            const subject = (meta.subject || '').toLowerCase();
            if (subject.includes('admin') && (subject.includes('alert') || subject.includes(keyword))) {
                adminAlertsGroupJid = meta.id;
                console.log('📢 [Alerts] Admin alerts group detected: ' + meta.subject);
                return;
            }
        }
    } catch (e) {
        console.warn('⚠️ [Alerts] Could not scan groups for admin alerts:', e.message);
    }
};

const refreshDiscoveredGroups = async (socket, phone) => {
    try {
        const groups = await socket.groupFetchAllParticipating();
        const discoveredGroups = Object.values(groups).map(g => ({
            jid: g.id,
            subject: g.subject || 'Unknown Group'
        }));
        const meta = loadSessionMeta();
        meta[phone] = {
            ...(meta[phone] || {}),
            discoveredGroups,
            updatedAt: new Date().toISOString()
        };
        saveSessionMeta(meta);
        triggerSessionBackup(
            phone,
            meta[phone].adminName || 'TN Connect Assistant',
            meta[phone].selectedGroups || [],
            discoveredGroups
        );
        return discoveredGroups;
    } catch (e) {
        console.warn('⚠️ [Groups] Failed to refresh discovered groups:', e.message);
        return (loadSessionMeta()[phone] || {}).discoveredGroups || [];
    }
};

const hasStoredCreds = (phone) => {
    const credsPath = path.join(__dirname, 'auth_session_' + phone, 'creds.json');
    return fs.existsSync(credsPath);
};

const scheduleWhatsAppReconnect = (phone, options, statusCode) => {
    if (intentionalLogout || isReconnecting) return;
    if (reconnectTimers[phone]) clearTimeout(reconnectTimers[phone]);

    const delayMs = statusCode === DisconnectReason.restartRequired ? 2000 : 4000;
    reconnectTimers[phone] = setTimeout(async () => {
        delete reconnectTimers[phone];
        if (intentionalLogout || isReconnecting) return;

        isReconnecting = true;
        try {
            console.log('🔄 [WhatsApp] Reconnecting +' + phone + ' (after disconnect code ' + statusCode + ')...');
            await startWhatsAppSession(phone, { ...options, wipeLocalAuth: false });
        } catch (e) {
            console.error('❌ [WhatsApp] Reconnect failed:', e.message || e);
        } finally {
            isReconnecting = false;
        }
    }, delayMs);
};

async function teardownSession(phone) {
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    intentionalLogout = true;
    if (reconnectTimers[cleanPhone]) {
        clearTimeout(reconnectTimers[cleanPhone]);
        delete reconnectTimers[cleanPhone];
    }
    if (sock) {
        try {
            sock.ev.removeAllListeners();
            if (typeof sock.logout === 'function') {
                await sock.logout();
            } else {
                sock.ws?.close?.();
            }
        } catch (e) {
            console.warn('⚠️ [Session] Socket close warning:', e.message);
        }
        sock = null;
    }
    activeSessionPhone = null;
    intentionalLogout = false;
    const dirPath = path.join(__dirname, 'auth_session_' + cleanPhone);
    if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
    }
    if (supabase && cleanPhone) {
        try {
            await supabase.from('gatekeeper_sessions').delete().eq('phone', cleanPhone);
        } catch (e) {
            console.warn('⚠️ [Supabase] Session delete warning:', e.message);
        }
    }
}

async function startWhatsAppSession(phone, options = {}) {
    const {
        adminName = 'TN Connect Assistant',
        selectedGroups = [],
        adminRole = 'Admin',
        wipeLocalAuth = false
    } = options;

    const dirPath = path.join(__dirname, 'auth_session_' + phone);
    if (wipeLocalAuth && fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
    }
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }

    const meta = loadSessionMeta();
    meta[phone] = {
        ...(meta[phone] || {}),
        adminName,
        role: adminRole,
        selectedGroups,
        discoveredGroups: meta[phone]?.discoveredGroups || []
    };
    saveSessionMeta(meta);

    if (sock) {
        try {
            sock.ev.removeAllListeners();
            sock.ws?.close?.();
        } catch (e) { /* ignore */ }
        sock = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState(dirPath);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        keepAliveIntervalMs: 30000,
        logger: P({ level: 'silent' })
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        const discovered = (loadSessionMeta()[phone] || {}).discoveredGroups || [];
        triggerSessionBackup(phone, adminName, selectedGroups, discovered);
        if (supabase) {
            try {
                const files = serializeDirectory(dirPath);
                await supabase.from('gatekeeper_sessions').upsert({
                    phone,
                    admin_name: adminName,
                    role: 'core_gatekeeper_bot',
                    selected_groups: selectedGroups,
                    discovered_groups: discovered,
                    files,
                    updated_at: new Date().toISOString()
                });
            } catch (e) {
                console.error('❌ [Supabase] Creds backup failed:', e.message);
            }
        }
    });

    activeSessionPhone = phone;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log('🚀 SUCCESS: TN Connect Assistant is linked (+' + phone + ')');
            await detectAdminAlertsGroup(sock);
            await refreshDiscoveredGroups(sock, phone);
            await scanPendingJoinRequests(sock);
        }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;
            const shouldReconnect = !loggedOut && !intentionalLogout;
            console.log('📴 [WhatsApp] Connection closed. Reconnect=' + shouldReconnect + ' code=' + statusCode);

            try {
                sock?.ev?.removeAllListeners();
            } catch (e) { /* ignore */ }
            sock = null;

            if (loggedOut || intentionalLogout) {
                activeSessionPhone = null;
                return;
            }

            if (shouldReconnect) {
                const meta = loadSessionMeta()[phone] || {};
                scheduleWhatsAppReconnect(phone, {
                    adminName: meta.adminName || adminName,
                    selectedGroups: meta.selectedGroups || selectedGroups,
                    adminRole: meta.adminRole || adminRole
                }, statusCode);
            }
        }
    });

    bindBotMessageHandlers(sock);
    bindGroupJoinHandlers(sock);
    return sock;
}

async function restoreCoreSessionOnBoot() {
    let localDirs = [];
    try {
        localDirs = fs.readdirSync(__dirname, { withFileTypes: true })
            .filter(d => d.isDirectory() && d.name.startsWith('auth_session_'))
            .map(d => d.name.replace('auth_session_', ''));
    } catch (e) {
        console.warn('⚠️ [Boot] Could not scan auth_session folders:', e.message);
    }

    let phone = localDirs[0];
    let adminName = 'TN Connect Assistant';
    let selectedGroups = [];

    if (!phone && supabase) {
        try {
            const { data, error } = await supabase
                .from('gatekeeper_sessions')
                .select('phone, admin_name, selected_groups, files')
                .eq('role', 'core_gatekeeper_bot')
                .maybeSingle();
            if (!error && data?.phone && data.files) {
                phone = String(data.phone).replace(/\D/g, '');
                adminName = data.admin_name || adminName;
                selectedGroups = data.selected_groups || [];
                const dirPath = path.join(__dirname, 'auth_session_' + phone);
                deserializeDirectory(dirPath, data.files);
                console.log('☁️ [Boot] Restored WhatsApp credentials from Supabase for +' + phone);
            }
        } catch (e) {
            console.warn('⚠️ [Boot] Supabase session restore skipped:', e.message);
        }
    }

    if (!phone) return;

    try {
        const meta = loadSessionMeta();
        await startWhatsAppSession(phone, {
            adminName: meta[phone]?.adminName || adminName,
            selectedGroups: meta[phone]?.selectedGroups || selectedGroups,
            adminRole: meta[phone]?.role || 'Admin',
            wipeLocalAuth: false
        });
        console.log('🔄 [Boot] Reconnected WhatsApp session for +' + phone);
    } catch (e) {
        console.error('❌ [Boot] Failed to restore WhatsApp session:', e.message);
        sock = null;
    }
}

const server = http.createServer(app);
const wss = new ws.Server({ server });

wss.on('connection', ws => {
    console.log('Frontend WebSocket connected!');
    ws.on('message', message => {
        try {
            const parsedMessage = JSON.parse(message);
            console.log('Received message from frontend:', parsedMessage);
            ws.send(JSON.stringify({ status: 'received', originalMessage: parsedMessage }));
        } catch (e) {
            console.error('Failed to parse WebSocket message as JSON:', e);
            console.log('Received raw message:', message.toString());
            ws.send(JSON.stringify({ status: 'error', message: 'Invalid JSON format' }));
        }
    });
    ws.send('Hello from WebSocket server!');
});

// ==========================================
// 🌐 EXPRESS REST API ENDPOINTS (FIXED FOR FRONTEND INTERATION)
// ==========================================

app.get('/api/sessions', async (req, res) => {
    try {
        const sessionArray = [];
        const connectedPhone = getSocketPhone();

        if (sock && sock.user && connectedPhone) {
            const meta = loadSessionMeta()[connectedPhone] || {};
            sessionArray.push({
                phone: connectedPhone,
                name: meta.adminName || 'TN Connect Assistant',
                connected: true,
                discoveredGroups: meta.discoveredGroups || []
            });
            return res.json(sessionArray);
        }

        if (supabase) {
            const { data, error } = await supabase
                .from('gatekeeper_sessions')
                .select('phone, admin_name, discovered_groups')
                .eq('role', 'core_gatekeeper_bot')
                .maybeSingle();

            if (!error && data?.phone) {
                const cloudPhone = String(data.phone).replace(/\D/g, '');
                const meta = loadSessionMeta()[cloudPhone] || {};
                sessionArray.push({
                    phone: cloudPhone,
                    name: data.admin_name || meta.adminName || 'TN Connect Assistant',
                    connected: false,
                    discoveredGroups: meta.discoveredGroups || data.discovered_groups || []
                });
                return res.json(sessionArray);
            }
        }

        res.json(sessionArray);
    } catch (err) {
        console.error('❌ Error in GET /api/sessions:', err.message);
        res.status(500).json([]);
    }
});

app.get('/api/business-hub/applicants', async (req, res) => {
    try {
        if (supabase) {
            const { data, error } = await supabase
                .from('business_hub_applicants')
                .select('*')
                .order('created_at', { ascending: false });
            if (!error && data) return res.json(data.map(normalizeApplicant));
        }
        
        const localApplicants = loadApplicants();
        res.json(Array.isArray(localApplicants) ? localApplicants.map(normalizeApplicant) : []);
    } catch (err) {
        console.error("❌ Error in GET /api/business-hub/applicants:", err.message);
        res.status(500).json([]);
    }
});

app.post('/api/auth/request-code', async (req, res) => {
    let phone = req.body.adminPhone || req.body.phone;
    const adminName = (req.body.adminName || 'TN Connect Assistant').trim();
    const selectedGroups = Array.isArray(req.body.selectedGroups) ? req.body.selectedGroups : [];
    const adminRole = req.body.adminRole || 'Admin';

    if (!phone) {
        return res.status(400).json({ error: 'Phone target parameter is required (adminPhone or phone).' });
    }

    phone = String(phone).replace(/\D/g, '');
    console.log('📡 [Pairing Router] Triggering pairing for +' + phone + ' (' + adminName + ')');

    try {
        if (sock && sock.user) {
            const existingPhone = getSocketPhone();
            if (existingPhone === phone) {
                return res.json({ status: 'CONNECTED', pairingCode: null, success: true });
            }
        }

        const wipeLocalAuth = !hasStoredCreds(phone) || req.body.forceNew === true;
        if (wipeLocalAuth) {
            console.log('🧹 [Pairing] Starting fresh auth for +' + phone);
        } else {
            console.log('♻️ [Pairing] Reusing existing creds for +' + phone + ' (no wipe)');
        }

        await startWhatsAppSession(phone, {
            adminName,
            selectedGroups,
            adminRole,
            wipeLocalAuth
        });

        setTimeout(async () => {
            try {
                if (!sock) {
                    return res.status(500).json({ error: 'WhatsApp socket failed to initialize.' });
                }
                if (sock.user) {
                    return res.json({ status: 'CONNECTED', pairingCode: null, success: true });
                }
                const pairingCode = await sock.requestPairingCode(phone);
                console.log('🔑 Generated pairing code: ' + pairingCode);
                res.json({ success: true, pairingCode, code: pairingCode });
            } catch (err) {
                console.error('❌ Pairing code error:', err.message || err);
                res.status(500).json({ error: 'Meta system credentials handshake error.' });
            }
        }, 3000);
    } catch (err) {
        console.error('❌ request-code error:', err.message || err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sessions/:phone/disconnect', async (req, res) => {
    const phone = String(req.params.phone || '').replace(/\D/g, '');
    if (!phone) {
        return res.status(400).json({ success: false, error: 'Invalid phone.' });
    }
    try {
        await teardownSession(phone);
        console.log('🔌 [Session] Disconnected and removed session for +' + phone);
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Disconnect error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

async function sendAntiBanMessage(socketInstance, jid, content) {
    try {
        await socketInstance.sendPresenceUpdate('composing', jid);
        const durationBase = content.text ? content.text.length * 15 : 2000;
        const randomWalkJitter = Math.floor(Math.random() * 1500) - 300;
        await delay(Math.max(2500, durationBase + randomWalkJitter));
        await socketInstance.sendPresenceUpdate('paused', jid);
        return await socketInstance.sendMessage(jid, content);
    } catch (e) {
        return await socketInstance.sendMessage(jid, content);
    }
}

function bindGroupJoinHandlers(socket) {
    socket.ev.on('group.join-request', async (event) => {
        try {
            const subject = await getGroupSubject(socket, event.id);
            await processJoinRequest(socket, event.id, event.participant, event.action, subject);
        } catch (e) {
            console.error('❌ [Join] group.join-request error:', e.message || e);
        }
    });
}

function bindBotMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async (chatUpdate) => {
        if (chatUpdate.type && chatUpdate.type !== 'notify') return;

        for (const msg of chatUpdate.messages || []) {
            if (!msg.message || msg.key.fromMe) continue;

            const jid = msg.key.remoteJid;
            if (!jid || jid.endsWith('@g.us')) continue;

            const bizHubRequest = findBusinessHubRequest(jid);
            if (bizHubRequest) {
                const { text, hasImage } = extractIncomingPayload(msg);
                const textInput = text || (hasImage ? '(Applicant sent an image)' : '');
                if (textInput) {
                    await handleBusinessHubConversation(
                        socket,
                        jid,
                        textInput,
                        bizHubRequest,
                        bizHubRequest.admin || getBotAdminContext().name
                    );
                }
                continue;
            }

            const pendingRequest = findPendingRequest(jid);
            if (pendingRequest) {
                await handleGatekeeperDM(socket, jid, msg, pendingRequest);
            }
        }
    });
}

async function sendAdminAlert(socketInstance, alertText) {
    if (adminAlertsGroupJid) {
        try {
            await socketInstance.sendMessage(adminAlertsGroupJid, { text: alertText });
        } catch (e) {
            console.error("❌ Failed to send message to admin group:", e.message);
        }
    } else {
        console.log("⚠️ No admin alerts group JID detected yet. Printing alert to console:\n" + alertText);
    }
}

// Express 5–safe API 404 (bare `/api/*` crashes path-to-regexp)
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'API Route not found.' });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, async () => {
    console.log('⚡️ [Server] Gatekeeper is live on port ' + PORT);
    await restoreCoreSessionOnBoot();
});
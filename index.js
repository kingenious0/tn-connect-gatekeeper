// Version 1.3 Pro - Single-Worker Cloud Engine with Anti-Ban & Gemini Multimodal
require('dotenv').config();
process.on('uncaughtException', (err) => console.error('💥 [Crash Guard] Uncaught:', err.message));
process.on('unhandledRejection', (err) => console.error('💥 [Crash Guard] Rejection:', err.message));
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
const joinIntroSentKeys = new Set(); // prevents re-sending requirements on rescans / restart
const adminBroadcastStates = new Map(); // admin DM wizard: CHOOSING_GROUPS → CAPTURING_RAW_BODY

const BANNED_KEYWORDS = ['scam', 'crypto investment', 'betting tips', 'giveaway'];

/** Roles in gatekeeper_sessions that unlock the conversational broadcast wizard */
const BROADCAST_ADMIN_ROLES = new Set(['admin', 'admin_node']);

/** Campus admin roster — used for optional env-free seed via POST /api/admins/seed-campus */
const CAMPUS_ADMIN_ROSTER = [
    { phone: '233264579215', admin_name: 'Yhaar Bhaby' },
    { phone: '233207924793', admin_name: 'You mean to tell me' },
    { phone: '233246546818', admin_name: 'TiLIe Nadis' },
    { phone: '233208282949', admin_name: 'Manager For TN' },
    { phone: '233256921483', admin_name: 'Easydata' },
    { phone: '233543091276', admin_name: 'Capo(TN)' },
    { phone: '233552289454', admin_name: 'Priscilla Coffie' },
    { phone: '233593950770', admin_name: 'Elikem(TN)' },
    { phone: '233541948442', admin_name: 'Roland Asareson Men...' },
    { phone: '233559965347', admin_name: 'AKEedwin' },
    { phone: '233599994129', admin_name: 'STEVO' },
    { phone: '233500200750', admin_name: 'Jeff Bezzos' },
    { phone: '233540509751', admin_name: 'Air Star' },
    { phone: '233597626090', admin_name: 'Kingenious' },
    { phone: '233538719819', admin_name: 'Mr.Gyan' },
    { phone: '233595802277', admin_name: 'PROPHETIC BUSINESS' }
];

const uploadDebounces = {}; // debounces for Supabase credentials upload

// Admin Alerts Group — auto-detected by name on boot
let adminAlertsGroupJid = null;

// Cooldown to prevent aggressive reconnection scanning (rate-limit protection)
let lastFullSyncTime = 0;
const FULL_SYNC_COOLDOWN_MS = 120000; // 2 minutes between full sync operations

// Allowed Groups — strict whitelist for auto-approval
const ALLOWED_GROUPS = [
    '120363407690574775@g.us', // TN UNIVERSITIES CONNECT | Niche Networks
    '120363411075020829@g.us', // TN BUSINESS HUB TEST
    '120363427354979370@g.us', // TN Bot Alerts
    '120363408180448581@g.us', // 6️⃣ Professional Grooming & Aesthetics
    '120363410725653254@g.us', // TN WINNEBA BUSINESS HUB
    '120363409409351609@g.us', // 3️⃣ Healthcare, Wellness & Safety
    '120363408812581114@g.us', // 2️⃣ Marketing, Publicity & Brand Awareness
    '120363408494102261@g.us', // 7️⃣ Enterprise, Leadership & Business Strategy
    '120363428438604848@g.us', // 4️⃣ Technical, Engineering & IT Support
];

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
// Official account names/handles for proof verification (names differ per platform)
const PROOF_ACCOUNTS_GUIDE = `
TIKTOK (platform: tiktok):
- Username/handle: @tnfilmsgh (this is the correct TikTok account — NOT a different name)
- Display/profile name often shows: TN UNIVERSITIES CONNECT or TN UNIVERSITIES...
- Logo: Ghana flag colours, graduation cap/book, text TN UNIVERSITIES CONNECT, tagline GUIDE · WORK · INSPIRE
- Valid proof: screenshot of profile or Following/Follow button showing user follows @tnfilmsgh / TN UNIVERSITIES CONNECT

FACEBOOK or INSTAGRAM (platform: social):
- Page/account name: TN Universities Connect or TN UNIVERSITIES CONNECT (same brand, spelling may vary)
- Logo: Ghana flag, graduation cap on book, TN UNIVERSITIES CONNECT
- Category may show Social Club (Facebook)
- Valid proof: screenshot showing Following button/state on TN Universities Connect page (Facebook or Instagram)

WHATSAPP CHANNEL (platform: channel):
- Channel name: TN Universities Connect (header may truncate e.g. TN Universities Con...)
- Branding in posts: TN UNIVERSITIES CONNECT, TN CONNECT GROUP
- Valid proof: screenshot inside WhatsApp Channels UI showing this channel (followed/joined or channel home with 2K+ followers typical)
- Channel link: https://whatsapp.com/channel/0029VbCNby81CYoPIpEQMD1D

IMPORTANT: Account names are NOT identical across platforms. Do NOT reject valid proof because TikTok uses @tnfilmsgh while Facebook uses TN Universities Connect — they are the same organisation.
`;

const GATEKEEPER_MESSAGE = `*{hello|hi|hey}, we just got your request to join our group*\r\n🚨ACTION REQUIRED🚨\r\n\r\nComplete *at least one* of these (more is fine):\r\n\r\n• TikTok: Follow *@tnfilmsgh* (TN Universities Connect)\r\n• Facebook / Instagram: Follow *TN Universities Connect*\r\n• WhatsApp Channel: https://whatsapp.com/channel/0029VbCNby81CYoPIpEQMD1D\r\n\r\nThen send *one clear screenshot* as proof (not view-once). Our system will verify it and approve you into the group.\r\n\r\n{If we review your request and there\'s no valid proof, it will be declined.|Invalid or fake screenshots will be rejected.} ⚠️ Delay = Cancellation.`;

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

/** Statuses where requirements/intro was already sent — do not DM again on rescan */
const INTRO_ALREADY_SENT_STATUSES = [
    'intro_sent',
    'pending',
    'verification_complete',
    'approved',
    'interview_complete',
    'non_resident_declined'
];

let registryHydratedFromCloud = false;

const hydrateJoinIntroCacheFromRegistry = (registry) => {
    for (const [key, entry] of Object.entries(registry)) {
        if (entry && INTRO_ALREADY_SENT_STATUSES.includes(entry.status)) {
            joinIntroSentKeys.add(key);
        }
    }
};

const syncRegistryFromSupabase = async () => {
    const local = loadRegistry();
    if (!supabase) {
        hydrateJoinIntroCacheFromRegistry(local);
        return local;
    }
    try {
        const { data, error } = await supabase.from('gatekeeper_registry').select('*');
        if (error) {
            console.warn('⚠️ [Registry] Supabase load skipped:', error.message);
            hydrateJoinIntroCacheFromRegistry(local);
            return local;
        }
        const merged = { ...local };
        for (const row of data || []) {
            if (!row.key) continue;
            merged[row.key] = {
                ...(merged[row.key] || {}),
                admin: row.admin_name || merged[row.key]?.admin,
                phone: row.phone || merged[row.key]?.phone,
                groupJid: row.group_jid || merged[row.key]?.groupJid,
                groupSubject: row.group_subject || merged[row.key]?.groupSubject,
                groupType: row.group_type || merged[row.key]?.groupType,
                participantJid: row.participant_jid || merged[row.key]?.participantJid,
                rawParticipantJid: row.raw_participant_jid || merged[row.key]?.rawParticipantJid,
                status: row.status || merged[row.key]?.status || 'intro_sent',
                timestamp: row.timestamp || merged[row.key]?.timestamp
            };
        }
        saveRegistry(merged);
        hydrateJoinIntroCacheFromRegistry(merged);
        console.log('☁️ [Registry] Loaded ' + (data?.length || 0) + ' entries from Supabase (' + joinIntroSentKeys.size + ' awaiting evidence or done)');
        return merged;
    } catch (e) {
        console.warn('⚠️ [Registry] Supabase sync failed:', e.message);
        hydrateJoinIntroCacheFromRegistry(local);
        return local;
    }
};

const ensureRegistryLoaded = async () => {
    if (registryHydratedFromCloud) return;
    await syncRegistryFromSupabase();
    registryHydratedFromCloud = true;
};

const findExistingRegistryEntry = (groupJid, participantJid) => {
    const registry = loadRegistry();
    const digits = participantDigits(participantJid);
    const exactKey = buildRegistryKey(groupJid, participantJid);
    if (registry[exactKey]) {
        return { key: exactKey, ...registry[exactKey] };
    }
    for (const [key, entry] of Object.entries(registry)) {
        if (!entry || entry.groupJid !== groupJid) continue;
        if (key.includes(digits)) return { key, ...entry };
        if (participantDigits(entry.participantJid || '') === digits) return { key, ...entry };
        if (participantDigits(entry.rawParticipantJid || '') === digits) return { key, ...entry };
    }
    return null;
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
            const row = {
                key,
                admin_name: item.admin,
                phone: item.phone,
                group_jid: item.groupJid,
                group_subject: item.groupSubject || null,
                group_type: item.groupType || null,
                participant_jid: item.participantJid || null,
                raw_participant_jid: item.rawParticipantJid || null,
                status: item.status,
                timestamp: item.timestamp
            };
            const { error } = await supabase.from('gatekeeper_registry').upsert(row);
            if (error) {
                const { error: err2 } = await supabase.from('gatekeeper_registry').upsert({
                    key,
                    admin_name: item.admin,
                    phone: item.phone,
                    group_jid: item.groupJid,
                    status: item.status,
                    timestamp: item.timestamp
                });
                if (err2) console.error('❌ [Supabase] Registry save failure:', err2.message);
            }
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

const parseGeminiJson = (text) => {
    const match = (text || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        return JSON.parse(match[0]);
    } catch (e) {
        return null;
    }
};

/** Deep fraud check — at least one legitimate proof screenshot required */
const deepVerifyScreenshotEvidence = async (buffer, mime) => {
    if (!geminiClient) {
        return { valid: false, reason: 'Verification service is temporarily unavailable. Try again shortly.', platform: null };
    }
    try {
        const model = geminiClient.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
        const result = await model.generateContent([
            {
                text: 'You are a strict fraud reviewer for TN Connect Ghana WhatsApp group joins.\n' +
                    'Accept ONLY if this image is a real screenshot showing the user completed AT LEAST ONE valid proof below.\n' +
                    PROOF_ACCOUNTS_GUIDE + '\n' +
                    'REJECT if: unrelated photo, meme, random chat, black screen, wrong unrelated account, no follow/join proof visible, ' +
                    'obvious fake/edited image, stock photo, or bypass attempt.\n' +
                    'Do NOT reject solely because the account name differs between platforms (TikTok @tnfilmsgh vs Facebook TN Universities Connect is correct).\n\n' +
                    'Reply with ONLY JSON: {"valid":true|false,"reason":"one short sentence","platform":"tiktok|social|channel|none"}'
            },
            { inlineData: { data: buffer.toString('base64'), mimeType: mime || 'image/jpeg' } }
        ]);
        const parsed = parseGeminiJson(result.response.text());
        if (parsed && typeof parsed.valid === 'boolean') {
            return {
                valid: parsed.valid,
                reason: String(parsed.reason || '').trim() || (parsed.valid ? 'Valid proof detected.' : 'Invalid proof.'),
                platform: parsed.platform || null
            };
        }
        const raw = (result.response.text() || '').toLowerCase();
        const valid = raw.includes('"valid":true') || raw.includes('"valid": true');
        return {
            valid,
            reason: valid ? 'Proof accepted.' : 'Could not verify this image as legitimate proof.',
            platform: null
        };
    } catch (e) {
        console.error('❌ [Gemini] Deep screenshot verify failed:', e.message);
        return { valid: false, reason: 'Verification failed. Please send a clearer screenshot.', platform: null };
    }
};

const initVerificationState = (userPhone) => {
    const state = { attempts: 0, rejected: 0, hasValidProof: false, platform: null };
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

    await ensureRegistryLoaded();

    const dmJid = dmJidFromParticipant(participantJid);
    if (!dmJid) {
        console.warn('⚠️ [Join] Could not resolve DM JID for participant:', participantJid);
        return;
    }

    const registryKey = buildRegistryKey(groupJid, participantJid);
    if (joinIntroSentKeys.has(registryKey)) {
        console.log('⏳ [Join] Skipping ' + dmJid + ' — intro already sent (cache), waiting for evidence');
        return;
    }

    const existing = findExistingRegistryEntry(groupJid, participantJid);
    if (existing && INTRO_ALREADY_SENT_STATUSES.includes(existing.status)) {
        joinIntroSentKeys.add(existing.key || registryKey);
        if (existing.status === 'intro_sent' || existing.status === 'pending') {
            console.log('⏳ [Join] Skipping ' + dmJid + ' for ' + (existing.groupSubject || groupJid) + ' — requirements already sent, waiting for screenshot');
        } else {
            console.log('ℹ️ [Join] Skipping ' + dmJid + ' — already handled (status: ' + existing.status + ')');
        }
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
        rawParticipantJid: participantJid,
        participantJid: dmJid,
        status: 'intro_sent',
        timestamp: new Date().toISOString()
    };

    await saveRegistryItem(registryKey, entry);
    joinIntroSentKeys.add(registryKey);

    console.log('📥 [Join] New ' + groupType + ' request: ' + groupSubject + ' from ' + dmJid);

    /*
     * ====================================================================
     * DM REQUIREMENTS VETTING LOGIC — COMMENTED OUT
     * The bot no longer contacts applicants via DM for screenshots or
     * verification steps. Instead, eligible requests are auto-approved
     * through the human-paced approval engine below.
     * ====================================================================
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
    */
};

// ==========================================
// ⏱️ HUMAN-PACED AUTO-APPROVAL ENGINE
// ==========================================
const approveWithPacing = async (socket, groupJid, participantJids) => {
    const jids = Array.isArray(participantJids) ? participantJids : [participantJids];
    if (!jids.length) return;

    for (let i = 0; i < jids.length; i++) {
        const delayMs = i === 0
            ? Math.floor(Math.random() * 60000) + 60000
            : Math.floor(Math.random() * 20000) + 20000;
        await delay(delayMs);

        try {
            await socket.groupRequestParticipantsUpdate(groupJid, [jids[i]], 'approve');
            console.log('✅ [Auto-Approval] Approved ' + jids[i] + ' into ' + groupJid);
        } catch (e) {
            console.error('❌ [Auto-Approval] Failed for ' + jids[i] + ':', e.message);
        }
    }
};

const approveGroupJoinRequest = async (socket, pendingRequest) => {
    const groupJid = pendingRequest.groupJid;
    const candidates = [
        pendingRequest.rawParticipantJid,
        pendingRequest.participantJid,
        pendingRequest.rawParticipantJid ? jidNormalizedUser(pendingRequest.rawParticipantJid) : null
    ].filter((j, i, arr) => j && arr.indexOf(j) === i);

    for (const jid of candidates) {
        try {
            await socket.groupRequestParticipantsUpdate(groupJid, [jid], 'approve');
            console.log('✅ [Gatekeeper] Approved join for ' + jid + ' into ' + (pendingRequest.groupSubject || groupJid));
            return { success: true, jid };
        } catch (e) {
            console.warn('⚠️ [Gatekeeper] Approve failed for ' + jid + ':', e.message);
        }
    }
    return { success: false, jid: null };
};

const completeGatekeeperApproval = async (socket, senderJid, pendingRequest, verify, proof) => {
    const userPhone = formatPhoneNumberGH(participantDigits(senderJid));
    const approveResult = await approveGroupJoinRequest(socket, pendingRequest);

    const registry = loadRegistry();
    if (registry[pendingRequest.key]) {
        registry[pendingRequest.key].status = approveResult.success ? 'approved' : 'verification_complete';
        registry[pendingRequest.key].proofPlatform = proof.platform;
        registry[pendingRequest.key].approvedAt = new Date().toISOString();
        await saveRegistryItem(pendingRequest.key, registry[pendingRequest.key]);
    }

    if (approveResult.success) {
        await sendAntiBanMessage(socket, senderJid, {
            text: '✅ Your proof was verified! You have been *approved* into *' +
                (pendingRequest.groupSubject || 'the group') + '*. Welcome to TN Connect 🎉'
        });
        const alertText = [
            '✅ *[AUTO-APPROVED — GATEKEEPER]*',
            '',
            '📞 *Applicant:* ' + userPhone,
            '🌐 *Group:* ' + (pendingRequest.groupSubject || pendingRequest.groupJid),
            '📸 *Proof:* ' + (proof.platform || 'verified') + ' — ' + (proof.reason || 'Valid screenshot'),
            '✅ Join request approved automatically.'
        ].join('\n');
        await sendAdminAlert(socket, alertText);
    } else {
        await sendAntiBanMessage(socket, senderJid, {
            text: '✅ Your screenshot was verified, but we could not auto-approve the join yet. An admin will approve you in WhatsApp shortly.'
        });
        await sendAdminAlert(socket, [
            '⚠️ *[VERIFIED — MANUAL APPROVE NEEDED]*',
            '',
            '📞 *Applicant:* ' + userPhone,
            '🌐 *Group:* ' + (pendingRequest.groupSubject || pendingRequest.groupJid),
            '📸 Proof OK but API approve failed. Please approve manually in the group.'
        ].join('\n'));
    }

    pendingVerifications.delete(userPhone);
};

const scanPendingJoinRequests = async (socket) => {
    await ensureRegistryLoaded();

    const admin = getBotAdminContext();
    const meta = loadSessionMeta()[admin.phone] || {};
    const groups = (meta.discoveredGroups || []).filter(g => ALLOWED_GROUPS.includes(g.jid));
    if (!groups.length) return;

    console.log('🔍 [Join] Scanning ' + groups.length + ' allowed groups for pending join requests (auto-approval mode)...');
    for (const group of groups) {
        try {
            const pending = await socket.groupRequestParticipantsList(group.jid);
            if (!pending?.length) continue;
            const pendingJids = [];
            for (const item of pending) {
                const participantJid = item.jid || item.participant || item.requestor;
                if (!participantJid) continue;
                await processJoinRequest(socket, group.jid, participantJid, 'created', group.subject);
                pendingJids.push(participantJid);
            }
            if (pendingJids.length && !isBusinessHubGroup(group.subject)) {
                (async () => {
                    await approveWithPacing(socket, group.jid, pendingJids);
                })();
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
    const saidDone = /\bdone\b/i.test(text);

    if (hasImage) {
        const media = await downloadImageBuffer(socket, msg);
        if (!media?.buffer) {
            await sendAntiBanMessage(socket, senderJid, {
                text: '⚠️ We could not read that image. Please send a normal screenshot (not view-once) showing you follow @tnfilmsgh on TikTok, TN Universities Connect on Facebook/Instagram, or our WhatsApp channel.'
            });
            return;
        }

        verify.attempts += 1;
        console.log('🔎 [Gatekeeper] Deep-checking screenshot from ' + userPhone + ' (attempt ' + verify.attempts + ')...');

        const proof = await deepVerifyScreenshotEvidence(media.buffer, media.mime);

        if (!proof.valid) {
            verify.rejected += 1;
            await sendAntiBanMessage(socket, senderJid, {
                text: '❌ That image was not accepted as valid proof.\n\n*Reason:* ' + proof.reason +
                    '\n\nPlease send a *real screenshot* of at least one:\n' +
                    '• TikTok: following *@tnfilmsgh* (TN Universities Connect)\n' +
                    '• Facebook/Instagram: following *TN Universities Connect*\n' +
                    '• WhatsApp channel joined\n\nNo memes or unrelated photos.'
            });
            return;
        }

        verify.hasValidProof = true;
        verify.platform = proof.platform;
        await completeGatekeeperApproval(socket, senderJid, pendingRequest, verify, proof);
        return;
    }

    if (saidDone) {
        if (verify.hasValidProof) {
            await sendAntiBanMessage(socket, senderJid, {
                text: '✅ You are already verified. If you are not in the group yet, wait a moment or contact an admin.'
            });
        } else {
            await sendAntiBanMessage(socket, senderJid, {
                text: 'Please send *at least one clear screenshot* as proof first (@tnfilmsgh on TikTok, TN Universities Connect on Facebook/Instagram, or our WhatsApp channel). ' +
                    'Use a normal photo — not view-once. We will verify and approve you automatically.'
            });
        }
        return;
    }

    if (text) {
        await sendAntiBanMessage(socket, senderJid, {
            text: 'Send *one screenshot* showing you follow @tnfilmsgh (TikTok), TN Universities Connect (Facebook/Instagram), or joined our WhatsApp channel. ' +
                'We verify it and approve you into *' + (pendingRequest.groupSubject || 'the group') + '* automatically.'
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

    const delayMs = statusCode === DisconnectReason.restartRequired ? 8000 : 30000;
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
            const now = Date.now();
            if (now - lastFullSyncTime > FULL_SYNC_COOLDOWN_MS) {
                lastFullSyncTime = now;
                await detectAdminAlertsGroup(sock);
                await refreshDiscoveredGroups(sock, phone);
                await scanPendingJoinRequests(sock);
            } else {
                const remaining = Math.round((FULL_SYNC_COOLDOWN_MS - (now - lastFullSyncTime)) / 1000);
                console.log('⏳ [Sync] Skipping full sync — cooldown active (' + remaining + 's remaining)');
            }
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

app.post('/api/admins/register', async (req, res) => {
    let phone = String(req.body.adminPhone || req.body.phone || '').replace(/\D/g, '');
    const adminName = (req.body.adminName || 'Admin').trim();
    if (!phone) {
        return res.status(400).json({ error: 'adminPhone or phone is required.' });
    }
    if (!supabase) {
        return res.status(503).json({ error: 'Supabase is required to register broadcast admins.' });
    }
    try {
        const { error } = await supabase.from('gatekeeper_sessions').upsert({
            phone,
            admin_name: adminName,
            role: 'admin_node',
            updated_at: new Date().toISOString()
        });
        if (error) return res.status(500).json({ error: error.message });
        console.log('👤 [Admin] Registered broadcast admin +' + phone + ' (' + adminName + ')');
        res.json({ success: true, phone, adminName });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admins/seed-campus', async (req, res) => {
    if (!supabase) {
        return res.status(503).json({ error: 'Supabase is required.' });
    }
    try {
        const rows = CAMPUS_ADMIN_ROSTER.map(a => ({
            phone: a.phone,
            admin_name: a.admin_name,
            role: 'admin_node',
            updated_at: new Date().toISOString()
        }));
        const { error } = await supabase.from('gatekeeper_sessions').upsert(rows);
        if (error) return res.status(500).json({ error: error.message });
        console.log('👥 [Admin] Seeded ' + rows.length + ' campus admin nodes into gatekeeper_sessions');
        res.json({ success: true, count: rows.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
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
        await socketInstance.sendPresenceUpdate('available', jid);
        await delay(Math.floor(Math.random() * 1800) + 1200);
        await socketInstance.sendPresenceUpdate('composing', jid);
        const charactersCount = content.text ? content.text.length : 40;
        const typingDurationBase = 1200 + charactersCount * 16;
        const patternShatterVariance = Math.floor(Math.random() * 1400) - 400;
        await delay(Math.max(2600, typingDurationBase + patternShatterVariance));
        await socketInstance.sendPresenceUpdate('paused', jid);
        return await socketInstance.sendMessage(jid, content);
    } catch (e) {
        return await socketInstance.sendMessage(jid, content);
    }
}

const senderPhoneFromJid = (jid) => participantDigits(jidNormalizedUser(jid || ''));

const isGreetingOrBroadcastIntent = (lowerText) => {
    return /\b(hello|hi|hey|morning|evening|broadcast|announce|send)\b/.test(lowerText);
};

const resolveAdminDisplayName = (adminName) => {
    const trimmed = (adminName || '').trim();
    return trimmed || 'Leader';
};

const isBroadcastAdminRole = (role) => BROADCAST_ADMIN_ROLES.has(role);

/** Human broadcast admins — Supabase gatekeeper_sessions (phone + admin_name + admin_node role) */
const lookupBroadcastAdmin = async (senderPhone) => {
    if (!supabase) {
        const rosterMatch = CAMPUS_ADMIN_ROSTER.find(a => a.phone === senderPhone);
        if (rosterMatch) {
            return { phone: senderPhone, name: resolveAdminDisplayName(rosterMatch.admin_name) };
        }
        return null;
    }

    try {
        const { data, error } = await supabase
            .from('gatekeeper_sessions')
            .select('phone, admin_name, role')
            .eq('phone', senderPhone)
            .maybeSingle();

        if (error || !data) return null;
        if (data.role === 'core_gatekeeper_bot') return null;
        if (!isBroadcastAdminRole(data.role)) return null;

        return {
            phone: data.phone,
            name: resolveAdminDisplayName(data.admin_name)
        };
    } catch (e) {
        console.warn('⚠️ [Admin Auth] Lookup failed:', e.message);
    }
    return null;
};

const fetchLiveMonitoredGroups = async (socket) => {
    const groups = await socket.groupFetchAllParticipating();
    return Object.values(groups).map(g => ({
        jid: g.id,
        subject: g.subject || 'Unknown Group'
    }));
};

const handleGroupModeration = async (socket, msg, jid, sender, senderPhone, isAdmin) => {
    if (isAdmin) return false;

    const textInput = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const lowerText = textInput.toLowerCase();
    const mentionedCount = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length || 0;

    const containsLink = lowerText.includes('http://') || lowerText.includes('https://') || lowerText.includes('wa.me/');
    const containsBadWord = BANNED_KEYWORDS.some(word => lowerText.includes(word));
    const containsMassMention = textInput.includes('@everyone') || textInput.includes('@all') || mentionedCount > 8;

    if (!containsLink && !containsBadWord && !containsMassMention) return false;

    let shouldAct = containsMassMention || containsBadWord;

    if (!shouldAct && containsLink && supabase) {
        try {
            const { data } = await supabase
                .from('gatekeeper_sessions')
                .select('anti_link_groups')
                .eq('role', 'core_gatekeeper_bot')
                .maybeSingle();
            const protectedGroups = data?.anti_link_groups || [];
            shouldAct = protectedGroups.includes(jid);
        } catch (e) { /* skip link guard if config missing */ }
    }

    if (!shouldAct) return false;

    try {
        await socket.sendMessage(jid, {
            delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender }
        });
        let alertText = '⚠️ *TN Connect Shield:* Link sharing is restricted in this group.';
        if (containsMassMention) {
            alertText = '🚫 *TN Connect Shield:* Unauthorized mass mentions are not allowed.';
        } else if (containsBadWord) {
            alertText = '🚫 *TN Connect Shield:* This message was removed for policy violation.';
        }
        await sendAntiBanMessage(socket, jid, { text: alertText, mentions: [sender] });
        console.log('🔒 [Moderation] Removed message from +' + senderPhone + ' in ' + jid);
    } catch (e) {
        console.error('❌ [Moderation] Failed:', e.message);
    }
    return true;
};

const handleAdminBroadcastDM = async (socket, jid, senderPhone, textInput, adminProfile) => {
    const lowerText = textInput.toLowerCase();
    let adminState = adminBroadcastStates.get(senderPhone);

    if (lowerText === 'cancel') {
        adminBroadcastStates.delete(senderPhone);
        await sendAntiBanMessage(socket, jid, { text: '✅ Broadcast cancelled. Say hello anytime to start again.' });
        return true;
    }

    if (!adminState && isGreetingOrBroadcastIntent(lowerText)) {
        await socket.sendMessage(jid, { text: '⏳ Scanning groups the bot is in…' });
        try {
            const liveGroups = await fetchLiveMonitoredGroups(socket);
            if (!liveGroups.length) {
                await sendAntiBanMessage(socket, jid, {
                    text: '⚠️ The bot is not in any groups yet. Add the bot as admin to your groups first.'
                });
                return true;
            }
            adminBroadcastStates.set(senderPhone, { step: 'CHOOSING_GROUPS', availableGroups: liveGroups });
            const displayName = resolveAdminDisplayName(adminProfile.name);
            let listPrompt = '👋 *Hello ' + displayName + '!* Here is the live list of every single group I am currently monitoring.\n\n' +
                'Reply with the numbers you want to target (comma-separated, e.g. *1, 3, 5*), or type *ALL*:\n\n';
            liveGroups.forEach((group, idx) => {
                listPrompt += (idx + 1) + '️⃣ *' + group.subject + '*\n';
            });
            listPrompt += '\n_Type *cancel* to stop._';
            await sendAntiBanMessage(socket, jid, { text: listPrompt });
        } catch (e) {
            console.error('❌ [Broadcast] Group fetch failed:', e.message);
            await sendAntiBanMessage(socket, jid, { text: '❌ Could not load group list. Try again shortly.' });
        }
        return true;
    }

    if (adminState?.step === 'CHOOSING_GROUPS') {
        const available = adminState.availableGroups;
        let mappedTargetJids = [];

        if (lowerText === 'all') {
            mappedTargetJids = available.map(g => g.jid);
        } else {
            const choices = textInput.split(',').map(c => parseInt(c.trim(), 10) - 1);
            for (const index of choices) {
                if (Number.isNaN(index) || index < 0 || index >= available.length) {
                    await sendAntiBanMessage(socket, jid, {
                        text: '❌ Invalid selection. Use numbers between 1 and ' + available.length + ', or type ALL.'
                    });
                    return true;
                }
                mappedTargetJids.push(available[index].jid);
            }
        }

        if (!mappedTargetJids.length) {
            await sendAntiBanMessage(socket, jid, { text: '❌ No groups selected. Try again (e.g. 1, 2 or ALL).' });
            return true;
        }

        adminBroadcastStates.set(senderPhone, { step: 'CAPTURING_RAW_BODY', targetJids: mappedTargetJids });
        await sendAntiBanMessage(socket, jid, {
            text: '🎯 *' + mappedTargetJids.length + ' group(s) locked.*\n\nNow send the announcement text. It will be posted *exactly* as you type it — no edits.'
        });
        return true;
    }

    if (adminState?.step === 'CAPTURING_RAW_BODY') {
        const destinations = adminState.targetJids;
        const rawBody = textInput;

        await socket.sendMessage(jid, {
            text: '🚀 Broadcasting to ' + destinations.length + ' group(s) with anti-ban pacing…'
        });

        let sent = 0;
        for (const groupJid of destinations) {
            try {
                await sendAntiBanMessage(socket, groupJid, { text: rawBody });
                sent += 1;
                const restMs = Math.floor(Math.random() * 3000) + 6000;
                await delay(restMs);
            } catch (e) {
                console.error('❌ [Broadcast] Failed for ' + groupJid + ':', e.message);
            }
        }

        adminBroadcastStates.delete(senderPhone);
        await sendAntiBanMessage(socket, jid, {
            text: '✅ Done! Message sent to ' + sent + '/' + destinations.length + ' groups.'
        });
        return true;
    }

    if (!adminState) {
        await sendAntiBanMessage(socket, jid, {
            text: '👋 Hi ' + adminProfile.name + '! Say *hello* or *broadcast* to send an announcement to your groups.'
        });
        return true;
    }

    return false;
};

function bindGroupJoinHandlers(socket) {
    socket.ev.on('group.join-request', async (event) => {
        try {
            if (!ALLOWED_GROUPS.includes(event.id)) return;
            const subject = await getGroupSubject(socket, event.id);
            await processJoinRequest(socket, event.id, event.participant, event.action, subject);
            if (event.participant && !isBusinessHubGroup(subject)) {
                (async () => {
                    await approveWithPacing(socket, event.id, event.participant);
                })();
            }
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
            if (!jid) continue;

            const isGroup = jid.endsWith('@g.us');
            const sender = isGroup ? (msg.key.participant || jid) : jid;
            const senderPhone = senderPhoneFromJid(sender);

            const adminProfile = await lookupBroadcastAdmin(senderPhone);
            const isAdmin = !!adminProfile;

            if (isGroup) {
                const moderated = await handleGroupModeration(socket, msg, jid, sender, senderPhone, isAdmin);
                if (moderated) continue;
                continue;
            }

            if (isAdmin) {
                const { text: dmText } = extractIncomingPayload(msg);
                const handled = await handleAdminBroadcastDM(socket, jid, senderPhone, dmText, adminProfile);
                if (handled) continue;
            }

            if (adminBroadcastStates.has(senderPhone)) continue;

            const bizHubRequest = findBusinessHubRequest(jid);
            if (bizHubRequest && !humanTakeoverUsers.has(formatPhoneNumberGH(senderPhone))) {
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
    await ensureRegistryLoaded();
    await restoreCoreSessionOnBoot();
});
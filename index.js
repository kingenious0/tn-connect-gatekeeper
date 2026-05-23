require('dotenv').config();
process.on('uncaughtException', (err) => console.error(' [Crash Guard] Uncaught:', err.message));
process.on('unhandledRejection', (err) => console.error(' [Crash Guard] Rejection:', err.message));
const { EvolutionClient } = require('./evolution-client');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
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

// Evolution API configuration
const EVOLUTION_BASE_URL = process.env.EVOLUTION_BASE_URL || 'https://tn-evolution-gateway.onrender.com';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'tn-connect';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'tn-connect-evo-key-2026';
const SERVER_URL = process.env.SERVER_URL || '';

let evolution = new EvolutionClient(EVOLUTION_BASE_URL, EVOLUTION_INSTANCE, EVOLUTION_API_KEY);

// Global variables
let activeSessionPhone = null;
let isReconnecting = false;
const pendingApprovals = new Map();
const pendingVerifications = new Map();
const businessHubConversations = new Map();
const humanTakeoverUsers = new Set();
const joinIntroSentKeys = new Set();
const adminBroadcastStates = new Map();

const BANNED_KEYWORDS = [
    'fuck', 'fucking', 'fuckin', 'fck', 'fuc',
    'motherfucker', 'motherfuck', 'mf',
    'cocksucker',
    'shit', 's h i t', 'sh!t', 'bullshit', 'horseshit', 'bullcrap',
    'bitch', 'b!tch', 'bich', 'bitches', 'son of a bitch', 'sonofabitch',
    'bastard', 'bastards',
    'cock', 'dick', 'd1ck', 'd!ck', 'dickhead',
    'pussy', 'puss', 'pussi',
    'whore', 'hoe', 'hoes',
    'slut', 'sluts',
    'damn', 'damm', 'goddamn', 'goddamm',
    'bloody',
    'nigga', 'nigger', 'niggas',
    'retard', 'retarded', 'r3tard',
    'idiot', 'idiots', 'idiotic',
    'dumb', 'dumbo',
    'stupid', 'st*pid',
    'kill yourself', 'kys',
    'suck my', 'suck my dick',
    'blowjob', 'blow job',
    'fag', 'faggot', 'fagg0t',
    'douche', 'douchebag',
    'porn', 'p0rn',
    'anal',
    'boner',
    'jerk',
    'ass', 'arse', 'a$$', 'asshole', 'assholes', 'dumbass', 'dipshit', 'shithead',
    'jackass', 'arsewipe', 'asswipe',
    'prick',
    'twat',
    'wanker',
    'cunt',
    'piss off', 'pissoff',
    'shitshow', 'clusterfuck', 'cluster fuck',
    'scam', 'crypto investment', 'betting tips', 'giveaway', 'ponzi', 'mlm',
    'kwasia', 'kawasia', 'kwasia penin', 'kwasia panin', 'wo ye kwasi',
    'gyimi', 'gyimii', 'gyimiii', 'gimi pa pa', 'wagimi papa', 'agyimi dodo',
    'ogyimifoo', 'ogyimifoɔ',
    'gyeese',
    'tibonkosɔ', 'tibɔnkɔsɔ',
    'tiri mu sum',
    'wo tiri mu nni biribiara',
    'adwenebɔne', 'adwenebone',
    'wo tiri ye', 'wo tiri yɛ',
    'okwaseaba',
    'nkwaseadee', 'nkwaseadeɛ',
    'aboa', 'ahbwah', 'aboa kɔkɔɔ', 'aboa kokoo', 'aboa onipa',
    'kraman',
    'prako', 'prakon', 'preko',
    'akoko nan', 'akokɔ nan',
    'opuro',
    'woti se kraman', 'woti sɛ kraman',
    'kusie',
    'aponkye ti',
    'nantwi kotodwe',
    'wu tu bin', 'wo tu bon', 'wo tu bɔn',
    'hwɛ w anim', 'hwe w anim', 'hwɛ w\'anim',
    'wanim se', 'w\'anim sɛ',
    'me bo w asom', 'me bɔ w\'asom',
    'wo ho bon', 'wo ho bɔn',
    'wano bon', 'w\'ano bɔn',
    'wo tiri se cla mine', 'wu ti se cla mine',
    'wo ntɔhwɛ', 'wo nt)hw3',
    'ashawo', 'ashawoah',
    'beyfu',
    'koti', 'kotih', 'cote', 'kototi',
    'tchwe', 'tchwaasini',
    'ohem',
    'nkrasinii', 'nkraseni',
    'odjwain',
    'adjwih',
    'kwakuo',
    'kainkain',
    'taintain',
    'dramain',
    'sansa ni', 'sansani',
    'nsuoba', 'nsyoh',
    'kohweni', 'kohwenni',
    'trumu',
    'wo ye hwan',
    'wabo dam', 'wa bo dam',
    'en fa me ho', 'ɛn fa me hɔ',
    'nkwaseasem', 'nkwaseasɛm',
    'abotchrewa',
    'afenfri',
    'ayanta',
    'petainjeh',
    'akonedi',
    'wo maame twe',
];

const BROADCAST_ADMIN_ROLES = new Set(['admin', 'admin_node']);

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
    { phone: '233595802277', admin_name: 'PROPHETIC BUSINESS' },
    { phone: '233506746307', admin_name: 'The Admin🔐' }
];

const adminLidMap = new Map();
const uploadDebounces = {};

const RATE_LIMIT_COOLDOWN_MS = parseInt(process.env.RATE_LIMIT_COOLDOWN_MS || '') || 5000;
let startupTime = 0;
let lastMessageSendTime = 0;
const MIN_MESSAGE_INTERVAL_MS = 8000;

let adminAlertsGroupJid = null;

let lastFullSyncTime = 0;
const FULL_SYNC_COOLDOWN_MS = 120000;

const ALLOWED_GROUPS = [
    '120363411075020829@g.us',
    '120363427354979370@g.us',
    '120363408180448581@g.us',
    '120363410725653254@g.us',
    '120363409409351609@g.us',
    '120363408812581114@g.us',
    '120363408494102261@g.us',
    '120363428438604848@g.us',
];

const ENABLE_DEPARTURE_NUDGE = false;
const departureNudgedUsers = new Set();

const supabaseUrl = process.env.SUPABASE_URL || process.env['Project URL'];
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env['anon public key'];
let supabase = null;
try {
    supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey, {
        realtime: { transport: ws }
    }) : null;
} catch (e) {
    console.error(" [Supabase] Client initialization failed:", e.message);
    supabase = null;
}

if (supabase) {
    console.log(" [Database] Supabase credentials detected! Cloud Backup Engine is ACTIVE.");
} else {
    console.log(" [Database] Supabase variables missing. Running in OFFLINE / Local File Mode.");
}

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

const BUSINESS_HUB_INTRO_MESSAGE = () => {
    const greetings = ['Hello', 'Hi there', 'Hey', 'Good day', 'Greetings'];
    const intros = [
        'I\'m the virtual intake coordinator assisting the TN Connect team',
        'I\'m a coordinator helping the TN Connect team process new applications',
        'I assist the TN Connect team with intake coordination',
        'I work with the TN Connect team to welcome and screen new members',
    ];
    const checks = [
        'Has any of our team reached out to you already? If yes, just let me know their name.',
        'Has an admin already contacted you about this? If so, kindly share their name.',
        'Have you been contacted by one of our admins yet? If yes, reply with their name.',
    ];
    const prompts = [
        'If not, could you share a bit about yourself and your business? We\'d love to know what you do and where you\'re based in Winneba.',
        'If no one has reached out yet, tell us a little about yourself — your business name, what you do, and your location in Winneba.',
        'If not, kindly introduce yourself — what\'s your business about and where are you located in Winneba?',
    ];
    const g = greetings[Math.floor(Math.random() * greetings.length)];
    const i = intros[Math.floor(Math.random() * intros.length)];
    const c = checks[Math.floor(Math.random() * checks.length)];
    const p = prompts[Math.floor(Math.random() * prompts.length)];
    return `${g}, thanks for requesting to join TN Winneba Business Hub 💼. ${i}.\n\n${c}\n\n${p}`;
};

const BUSINESS_HUB_SYSTEM_PROMPT = `You are a sharp, professional business intake coordinator for TN Winneba Business Hub — an exclusive networking community for serious business owners in Winneba, Ghana. You represent the TN Uni Connect admin team.\r\n\r\nYour job is to screen and onboard business applicants through a natural, concise conversation. Collect the following in this EXACT order, one or two at a time:\r\n1. Full name\r\n2. Are they a resident of Winneba? (ask this SECOND — before any business questions)\r\n3. Business name and type\r\n4. Exact location in Winneba\r\n5. Products or services offered\r\n6. Open to partnerships and vacancy sharing? (yes/no)\r\n7. How TN members and Ghanaians benefit from their business\r\n\r\nResidency Rule (CRITICAL — check at step 2, immediately after getting their name):\r\n- If they say YES to being a Winneba resident → continue with the remaining business questions (3-7)\r\n- If they say NO to being a Winneba resident → ask ONE follow-up: "If we organise a physical meet-up in Winneba, would you be able to attend?"\r\n  - If YES to attending → continue with the remaining business questions (3-7), treat as approved\r\n  - If NO to attending → close gracefully immediately. Thank them warmly, tell them the hub is currently focused on people who can be physically present in Winneba, let them know TN Connect has other exciting opportunities suited to them and an admin will reach out soon. Then end with the [RESIDENT_DECLINED] marker on a new line. No JSON needed for this path. Do NOT ask any more business questions.\r\n\r\nStyle Rules:\r\n- Be concise. One clear question per message, maximum two sentences. No paragraphs.\r\n- Sound like a sharp, experienced business networker — warm but efficient\r\n- Never sound like a bot or a form. Speak like a real person\r\n- Do not use excessive emojis — one per message maximum\r\n- Never reveal you are an AI\r\n- If someone gives a vague or off-topic reply, redirect sharply but politely.`;

const geminiClient = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const geminiModel = geminiClient ? geminiClient.getGenerativeModel({
    model: 'gemini-2.5-flash-lite',
    systemInstruction: BUSINESS_HUB_SYSTEM_PROMPT
}) : null;

if (geminiModel) {
    console.log(' [Gemini] AI intake engine is ACTIVE for Business Hub groups.');
} else {
    console.log(' [Gemini] GEMINI_API_KEY missing. Business Hub AI intake will be DISABLED.');
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
        console.error('Failed to serialize folder ' + dirPath + ':', e);
    }
    return filesData;
};

const deserializeDirectory = (dirPath, filesData) => {
    try {
        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
        for (const [file, base64Content] of Object.entries(filesData)) {
            const filePath = path.join(dirPath, file);
            fs.writeFileSync(filePath, Buffer.from(base64Content, 'base64'));
        }
    } catch (e) {
        console.error('Failed to deserialize folder ' + dirPath + ':', e);
    }
};

const loadSessionMeta = () => {
    if (!fs.existsSync(SESSION_META_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(SESSION_META_FILE, 'utf-8')); }
    catch (e) { return {}; }
};

const saveSessionMeta = (meta) => {
    try { fs.writeFileSync(SESSION_META_FILE, JSON.stringify(meta, null, 2)); }
    catch (e) { console.error("Failed to write sessions_meta.json:", e); }
};

const loadRegistry = () => {
    if (!fs.existsSync(REGISTRY_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8')); }
    catch (e) { return {}; }
};

const INTRO_ALREADY_SENT_STATUSES = [
    'intro_sent', 'pending', 'verification_complete',
    'approved', 'interview_complete', 'non_resident_declined'
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
    if (!supabase) { hydrateJoinIntroCacheFromRegistry(local); return local; }
    try {
        const { data, error } = await supabase.from('gatekeeper_registry').select('*');
        if (error) { hydrateJoinIntroCacheFromRegistry(local); return local; }
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
        console.log(' [Registry] Loaded ' + (data?.length || 0) + ' entries from Supabase');
        return merged;
    } catch (e) {
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
    if (registry[exactKey]) return { key: exactKey, ...registry[exactKey] };
    for (const [key, entry] of Object.entries(registry)) {
        if (!entry || entry.groupJid !== groupJid) continue;
        if (key.includes(digits)) return { key, ...entry };
        if (participantDigits(entry.participantJid || '') === digits) return { key, ...entry };
        if (participantDigits(entry.rawParticipantJid || '') === digits) return { key, ...entry };
    }
    return null;
};

const saveRegistry = (data) => {
    try { fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2)); }
    catch (e) { console.error("Failed to write registry.json:", e); }
};

const saveRegistryItem = async (key, item) => {
    const registry = loadRegistry();
    registry[key] = item;
    saveRegistry(registry);
    if (supabase) {
        try {
            const { error } = await supabase.from('gatekeeper_registry').upsert({
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
            });
            if (error) await supabase.from('gatekeeper_registry').upsert({
                key, admin_name: item.admin, phone: item.phone,
                group_jid: item.groupJid, status: item.status, timestamp: item.timestamp
            });
        } catch (err) {
            console.error(" [Supabase] Registry sync crash:", err);
        }
    }
};

const triggerSessionBackup = (phone, adminName, selectedGroups, discoveredGroups) => {
    if (!supabase) return;
    if (uploadDebounces[phone]) clearTimeout(uploadDebounces[phone]);
    uploadDebounces[phone] = setTimeout(async () => {
        try {
            const dirPath = 'auth_session_' + phone;
            const files = serializeDirectory(dirPath);
            await supabase.from('gatekeeper_sessions').upsert({
                phone, admin_name: adminName, selected_groups: selectedGroups,
                discovered_groups: discoveredGroups, files,
                updated_at: new Date().toISOString()
            });
        } catch (err) {
            console.error(' [Supabase] System error backing up session:', err);
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
        if (group && isBusinessHubGroup(group.subject)) return true;
    }
    return false;
};

const findPendingRequest = (senderJid) => {
    const registry = loadRegistry();
    const cleanSender = senderJid.replace('@s.whatsapp.net', '').replace('@lid', '');
    for (const key of Object.keys(registry)) {
        const entry = registry[key];
        const closedStatuses = ['approved', 'verification_complete', 'interview_complete', 'non_resident_declined'];
        if (key.includes(cleanSender) && !closedStatuses.includes(entry.status)) {
            const isBizHub = entry.groupType === 'business_hub' || isGroupJidBusinessHub(entry.groupJid, entry.phone);
            if (!isBizHub) return { key, ...entry };
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
            if (isBizHub) return { key, ...entry };
        }
    }
    return null;
};

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
    const normalized = (participantJid || '').replace(/@lid.*$/, '').replace(/[^0-9]/g, '');
    if (!normalized) return null;
    return normalized + '@s.whatsapp.net';
};

const getBotAdminContext = () => {
    const phone = activeSessionPhone || '';
    const meta = loadSessionMeta()[phone] || {};
    return { phone, name: meta.adminName || 'TN Connect Assistant' };
};

const getGroupSubject = async (groupJid) => {
    if (groupSubjectCache.has(groupJid)) return groupSubjectCache.get(groupJid);
    const botPhone = getBotAdminContext().phone;
    const meta = loadSessionMeta()[botPhone] || {};
    const discovered = (meta.discoveredGroups || []).find(g => g.jid === groupJid);
    if (discovered?.subject) {
        groupSubjectCache.set(groupJid, discovered.subject);
        return discovered.subject;
    }
    return 'Unknown Group';
};

const classifyGroupType = (groupSubject, groupJid, adminPhone) => {
    if (isBusinessHubGroup(groupSubject) || isGroupJidBusinessHub(groupJid, adminPhone)) return 'business_hub';
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
    const hasImage = !!content.imageMessage || (!!content.documentMessage && content.documentMessage?.mimetype?.startsWith('image/'));
    return { text: (text || '').trim(), hasImage };
};

const parseGeminiJson = (text) => {
    const match = (text || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); }
    catch (e) { return null; }
};

const deepVerifyScreenshotEvidence = async (buffer, mime) => {
    if (!geminiClient) return { valid: false, reason: 'Verification service is temporarily unavailable.', platform: null };
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
            return { valid: parsed.valid, reason: String(parsed.reason || '').trim() || (parsed.valid ? 'Valid proof detected.' : 'Invalid proof.'), platform: parsed.platform || null };
        }
        const raw = (result.response.text() || '').toLowerCase();
        const valid = raw.includes('"valid":true') || raw.includes('"valid": true');
        return { valid, reason: valid ? 'Proof accepted.' : 'Could not verify this image as legitimate proof.', platform: null };
    } catch (e) {
        console.error(' [Gemini] Deep screenshot verify failed:', e.message);
        return { valid: false, reason: 'Verification failed. Please send a clearer screenshot.', platform: null };
    }
};

const initVerificationState = (userPhone) => {
    const state = { attempts: 0, rejected: 0, hasValidProof: false, platform: null };
    pendingVerifications.set(userPhone, state);
    return state;
};

const getVerificationState = (userPhone) => {
    if (!pendingVerifications.has(userPhone)) return initVerificationState(userPhone);
    return pendingVerifications.get(userPhone);
};

const processJoinRequest = async (groupJid, participantJid, action, groupSubjectHint) => {
    if (!participantJid || !groupJid) return;
    if (action && action !== 'created') return;
    await ensureRegistryLoaded();
    const dmJid = dmJidFromParticipant(participantJid);
    if (!dmJid) return;
    const registryKey = buildRegistryKey(groupJid, participantJid);
    if (joinIntroSentKeys.has(registryKey)) return;
    const existing = findExistingRegistryEntry(groupJid, participantJid);
    if (existing && INTRO_ALREADY_SENT_STATUSES.includes(existing.status)) {
        joinIntroSentKeys.add(existing.key || registryKey);
        return;
    }
    const admin = getBotAdminContext();
    const groupSubject = groupSubjectHint || await getGroupSubject(groupJid);
    const groupType = classifyGroupType(groupSubject, groupJid, admin.phone);
    const entry = {
        admin: admin.name, phone: admin.phone, groupJid, groupSubject, groupType,
        rawParticipantJid: participantJid, participantJid: dmJid,
        status: 'intro_sent', timestamp: new Date().toISOString()
    };
    await saveRegistryItem(registryKey, entry);
    joinIntroSentKeys.add(registryKey);
    console.log(' [Join] New ' + groupType + ' request: ' + groupSubject + ' from ' + dmJid);
};

const approveWithPacing = async (groupJid, participantJids) => {
    if (startupTime && (Date.now() - startupTime) < RATE_LIMIT_COOLDOWN_MS) return;
    const jids = Array.isArray(participantJids) ? participantJids : [participantJids];
    if (!jids.length) return;
    for (let i = 0; i < jids.length; i++) {
        const delayMs = i === 0
            ? Math.floor(Math.random() * 60000) + 60000
            : Math.floor(Math.random() * 20000) + 20000;
        await new Promise(r => setTimeout(r, delayMs));
        try {
            await evolution.acceptJoinRequest(groupJid, jids[i]);
            console.log(' [Auto-Approval] Approved ' + jids[i] + ' into ' + groupJid);
        } catch (e) {
            console.error(' [Auto-Approval] Failed for ' + jids[i] + ':', e.message);
        }
    }
};

const approveGroupJoinRequest = async (pendingRequest) => {
    const groupJid = pendingRequest.groupJid;
    const candidates = [
        pendingRequest.rawParticipantJid,
        pendingRequest.participantJid,
    ].filter((j, i, arr) => j && arr.indexOf(j) === i);
    for (const jid of candidates) {
        try {
            await evolution.acceptJoinRequest(groupJid, jid);
            console.log(' [Gatekeeper] Approved join for ' + jid + ' into ' + (pendingRequest.groupSubject || groupJid));
            return { success: true, jid };
        } catch (e) {
            console.warn(' [Gatekeeper] Approve failed for ' + jid + ':', e.message);
        }
    }
    return { success: false, jid: null };
};

const completeGatekeeperApproval = async (senderJid, pendingRequest, verify, proof) => {
    const userPhone = formatPhoneNumberGH(participantDigits(senderJid));
    const approveResult = await approveGroupJoinRequest(pendingRequest);
    const registry = loadRegistry();
    if (registry[pendingRequest.key]) {
        registry[pendingRequest.key].status = approveResult.success ? 'approved' : 'verification_complete';
        registry[pendingRequest.key].proofPlatform = proof.platform;
        registry[pendingRequest.key].approvedAt = new Date().toISOString();
        await saveRegistryItem(pendingRequest.key, registry[pendingRequest.key]);
    }
    if (approveResult.success) {
        await sendAntiBanMessage(senderJid, {
            text: '✅ Your proof was verified! You have been *approved* into *' +
                (pendingRequest.groupSubject || 'the group') + '*. Welcome to TN Connect 🎉'
        });
        await sendAdminAlert([
            '✅ *[AUTO-APPROVED — GATEKEEPER]*', '',
            '📞 *Applicant:* ' + userPhone,
            '🌐 *Group:* ' + (pendingRequest.groupSubject || pendingRequest.groupJid),
            '📸 *Proof:* ' + (proof.platform || 'verified') + ' — ' + (proof.reason || 'Valid screenshot'),
            '✅ Join request approved automatically.'
        ].join('\n'));
    } else {
        await sendAntiBanMessage(senderJid, {
            text: '✅ Your screenshot was verified, but we could not auto-approve the join yet. An admin will approve you in WhatsApp shortly.'
        });
        await sendAdminAlert([
            '⚠️ *[VERIFIED — MANUAL APPROVE NEEDED]*', '',
            '📞 *Applicant:* ' + userPhone,
            '🌐 *Group:* ' + (pendingRequest.groupSubject || pendingRequest.groupJid),
            '📸 Proof OK but API approve failed. Please approve manually in the group.'
        ].join('\n'));
    }
    pendingVerifications.delete(userPhone);
};

const scanPendingJoinRequests = async () => {
    await ensureRegistryLoaded();
    const admin = getBotAdminContext();
    const meta = loadSessionMeta()[admin.phone] || {};
    const groups = (meta.discoveredGroups || []).filter(g => ALLOWED_GROUPS.includes(g.jid));
    if (!groups.length) return;
    console.log(' [Join] Scanning ' + groups.length + ' allowed groups for pending join requests...');
    for (const group of groups) {
        try {
            const pending = await evolution._request('GET', `/group/pendingJoinRequests/${EVOLUTION_INSTANCE}?groupJid=${encodeURIComponent(group.jid)}`);
            const items = pending?.data || pending?.pending || pending?.results || (Array.isArray(pending) ? pending : []);
            if (!items?.length) continue;
            const pendingJids = [];
            for (const item of items) {
                const participantJid = item.jid || item.participant || item.requestor;
                if (!participantJid) continue;
                await processJoinRequest(group.jid, participantJid, 'created', group.subject);
                pendingJids.push(participantJid);
            }
            if (pendingJids.length && !isBusinessHubGroup(group.subject)) {
                (async () => { await approveWithPacing(group.jid, pendingJids); })();
            }
        } catch (e) {
            console.warn(' [Join] Could not list pending requests for ' + group.subject + ':', e.message);
        }
    }
};

const handleGatekeeperDM = async (senderJid, msg, pendingRequest) => {
    const userPhone = formatPhoneNumberGH(participantDigits(senderJid));
    if (humanTakeoverUsers.has(userPhone)) return;
    const { text, hasImage } = extractIncomingPayload(msg);
    const verify = getVerificationState(userPhone);
    const saidDone = /\bdone\b/i.test(text);
    if (hasImage) {
        verify.attempts += 1;
        console.log(' [Gatekeeper] Image from ' + userPhone + ' (attempt ' + verify.attempts + ') — verifying via Gemini...');
        if (msg.message?.imageMessage?.url) {
            try {
                const resp = await fetch(msg.message.imageMessage.url);
                const buffer = Buffer.from(await resp.arrayBuffer());
                const mime = msg.message.imageMessage.mimetype || 'image/jpeg';
                const proof = await deepVerifyScreenshotEvidence(buffer, mime);
                if (!proof.valid) {
                    verify.rejected += 1;
                    await sendAntiBanMessage(senderJid, {
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
                await completeGatekeeperApproval(senderJid, pendingRequest, verify, proof);
                return;
            } catch (e) {
                console.error(' [Gatekeeper] Image download/verify failed:', e.message);
                await sendAntiBanMessage(senderJid, {
                    text: '⚠️ We could not read that image. Please send a normal screenshot (not view-once) showing you follow @tnfilmsgh on TikTok, TN Universities Connect on Facebook/Instagram, or our WhatsApp channel.'
                });
                return;
            }
        }
        await sendAntiBanMessage(senderJid, {
            text: '⚠️ We could not read that image. Please send a normal screenshot (not view-once) showing you follow @tnfilmsgh on TikTok, TN Universities Connect on Facebook/Instagram, or our WhatsApp channel.'
        });
        return;
    }
    if (saidDone) {
        if (verify.hasValidProof) {
            await sendAntiBanMessage(senderJid, { text: '✅ You are already verified. If you are not in the group yet, wait a moment or contact an admin.' });
        } else {
            await sendAntiBanMessage(senderJid, { text: 'Please send *at least one clear screenshot* as proof first (@tnfilmsgh on TikTok, TN Universities Connect on Facebook/Instagram, or our WhatsApp channel). Use a normal photo — not view-once. We will verify and approve you automatically.' });
        }
        return;
    }
    if (text) {
        await sendAntiBanMessage(senderJid, { text: 'Send *one screenshot* showing you follow @tnfilmsgh (TikTok), TN Universities Connect (Facebook/Instagram), or joined our WhatsApp channel. We verify it and approve you into *' + (pendingRequest.groupSubject || 'the group') + '* automatically.' });
    }
};

const loadApplicants = () => {
    if (!fs.existsSync(APPLICANTS_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(APPLICANTS_FILE, 'utf-8')); }
    catch (e) { return []; }
};

const saveApplicant = async (applicantData) => {
    const applicants = loadApplicants();
    const entry = { ...applicantData, id: Date.now(), createdAt: new Date().toISOString(), status: 'pending_review' };
    applicants.push(entry);
    try { fs.writeFileSync(APPLICANTS_FILE, JSON.stringify(applicants, null, 2)); }
    catch (e) { console.error('Failed to save applicant locally:', e); }
    if (supabase) {
        try {
            await supabase.from('business_hub_applicants').insert({
                phone: applicantData.phone || '', name: applicantData.name || '',
                business_name: applicantData.businessName || '',
                business_type: applicantData.businessType || '',
                location: applicantData.location || '', services: applicantData.services || '',
                partnerships: applicantData.partnerships || '', benefit: applicantData.benefit || '',
                status: 'pending_review'
            });
        } catch (e) { console.error(' [Supabase] Applicant insert failed:', e.message); }
    }
    return entry;
};

const callGeminiWithRetry = async (chat, textInput, retries = 3, initialDelayMs = 2000) => {
    let currentDelay = initialDelayMs;
    for (let i = 0; i < retries; i++) {
        try { return await chat.sendMessage(textInput); }
        catch (err) {
            const errStr = String(err.message || err);
            const isTransient = errStr.includes('503') || errStr.includes('429') || errStr.includes('Service Unavailable') || errStr.includes('Resource exhausted') || errStr.includes('overloaded');
            if (isTransient && i < retries - 1) {
                await new Promise(r => setTimeout(r, currentDelay));
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
    if (digits.startsWith('233') && digits.length === 12) return '0' + digits.substring(3);
    if (digits.startsWith('0')) return digits;
    return '+' + digits;
};

const delay = (ms) => new Promise(r => setTimeout(r, ms));

const handleBusinessHubConversation = async (senderJid, textInput, bizHubRequest, adminName) => {
    if (!geminiClient) return;
    const rawPhone = senderJid.replace('@s.whatsapp.net', '').replace('@lid', '');
    const userPhone = formatPhoneNumberGH(rawPhone);
    if (humanTakeoverUsers.has(userPhone)) return;
    let history = businessHubConversations.get(userPhone);
    if (!history) {
        if (supabase) {
            try {
                const { data } = await supabase.from('business_hub_conversations')
                    .select('history').eq('phone', userPhone).single();
                if (data?.history) history = JSON.parse(data.history);
            } catch (e) { }
        }
        history = history || [];
        businessHubConversations.set(userPhone, history);
    }
    const adminRole = activeSessionPhone ? ((loadSessionMeta()[activeSessionPhone] || {}).role || 'Admin') : 'Admin';
    const dynamicInstruction = BUSINESS_HUB_SYSTEM_PROMPT + '\r\n\r\nIMPORTANT CONTEXT FOR YOUR IDENTITY:\r\n- You represent the specific admin named "' + adminName + '" who is the "' + adminRole + '" of TN Uni Connect.\r\n- If the applicant mentions they haven\'t gotten any text from an admin, or asks who you are, explain that you are the virtual intake coordinator assisting ' + adminName + ' (' + adminRole + ') to gather their business details.\r\n- Never use placeholder texts like "[Your Name]". Introduce yourself naturally as a human coordinator or professional assistant representing ' + adminName + ' (e.g., "I\'m the virtual intake coordinator assisting ' + adminName + '..." or "I\'m a coordinator assisting ' + adminName + '..."). Never write grammatically incorrect sentences like "My name is your virtual intake coordinator".';
    try {
        const modelInstance = geminiClient.getGenerativeModel({ model: 'gemini-2.5-flash-lite', systemInstruction: dynamicInstruction });
        const chat = modelInstance.startChat({ history });
        const result = await callGeminiWithRetry(chat, textInput);
        const responseText = result.response.text();
        const INTAKE_MARKER = '[INTAKE_COMPLETE]';
        const DECLINED_MARKER = '[RESIDENT_DECLINED]';
        const HUMAN_MARKER = '[TRIGGER_HUMAN]';
        const isComplete = responseText.includes(INTAKE_MARKER);
        const isDeclined = responseText.includes(DECLINED_MARKER);
        let cleanResponse = responseText
            .replace(INTAKE_MARKER, '').replace(DECLINED_MARKER, '')
            .replace(HUMAN_MARKER, '').trim();
        let applicantData = null;
        if (isComplete) {
            const markerIndex = responseText.indexOf(INTAKE_MARKER);
            cleanResponse = responseText.substring(0, markerIndex).trim();
            const jsonStr = responseText.substring(markerIndex + INTAKE_MARKER.length).trim();
            try { applicantData = JSON.parse(jsonStr); applicantData.phone = userPhone; }
            catch (e) { applicantData = { phone: userPhone, raw: jsonStr }; }
        }
        history.push({ role: 'user', parts: [{ text: textInput }] });
        history.push({ role: 'model', parts: [{ text: responseText }] });
        businessHubConversations.set(userPhone, history);
        if (supabase) {
            try {
                await supabase.from('business_hub_conversations').upsert({
                    phone: userPhone, history: JSON.stringify(history), updated_at: new Date().toISOString()
                }, { onConflict: 'phone' });
            } catch (e) { }
        }
        if (cleanResponse) {
            const readDelay = Math.floor(Math.random() * 2000) + 1500;
            await delay(readDelay);
            await sendAntiBanMessage(senderJid, { text: cleanResponse });
        }
        const sendAlertWithScreenshot = async (alertText) => {
            await sendAdminAlert(alertText);
            try {
                const screenshotBuffer = generateChatScreenshot(history, '+' + userPhone, 'Business Hub Intake');
                if (screenshotBuffer && adminAlertsGroupJid) {
                    await sendAntiBanMessage(adminAlertsGroupJid, { text: alertText });
                    console.log(' [Screenshot] Chat image send skipped (text alert sent for +' + userPhone + ')');
                }
            } catch (imgErr) {
                console.error(' [Screenshot] Failed:', imgErr.message);
            }
        };
        if (isDeclined) {
            console.log(' [Business Hub] Non-resident declined for +' + userPhone);
            humanTakeoverUsers.add(userPhone);
            businessHubConversations.delete(userPhone);
            if (supabase) { try { await supabase.from('business_hub_conversations').delete().eq('phone', userPhone); } catch (e) { } }
            const registry = loadRegistry();
            if (registry[bizHubRequest.key]) {
                registry[bizHubRequest.key].status = 'non_resident_declined';
                await saveRegistryItem(bizHubRequest.key, registry[bizHubRequest.key]);
            }
            await sendAlertWithScreenshot('🚫 *[NON-RESIDENT DECLINED]*\n\n📞 *Number:* ' + userPhone + '\n🏘️ Not based in Winneba and cannot attend physical meetings.\nIntake closed.');
        }
        if (responseText.includes(HUMAN_MARKER)) {
            humanTakeoverUsers.add(userPhone);
            await sendAlertWithScreenshot('⚠️ *[HUMAN HANDOFF REQUIRED]* ⚠️\n\n📞 *Number:* ' + userPhone + '\n💬 *Last message:* "' + textInput + '"\n\nThe AI has been paused. Open a DM with ' + userPhone + ' to take over.');
        }
        if (isComplete && applicantData) {
            await saveApplicant(applicantData);
            const summaryLines = [
                '✅ *[NEW BUSINESS HUB APPLICANT]* ✅', '',
                '📞 *Number:* ' + userPhone + '\n👤 *Name:* ' + (applicantData.name || 'N/A') + '\n🏢 *Business:* ' + (applicantData.businessName || 'N/A') + ' (' + (applicantData.businessType || 'N/A') + ')\n📍 *Location:* ' + (applicantData.location || 'N/A') + '\n🛒 *Services:* ' + (applicantData.services || 'N/A') + '\n🤝 *Partnerships:* ' + (applicantData.partnerships || 'N/A') + '\n💡 *Benefit:* ' + (applicantData.benefit || 'N/A') + '\n🏘️ *Winneba Resident:* ' + (applicantData.resident || 'N/A')
            ].join('\n');
            await sendAlertWithScreenshot(summaryLines);
            const registry = loadRegistry();
            if (registry[bizHubRequest.key]) {
                registry[bizHubRequest.key].status = 'interview_complete';
                await saveRegistryItem(bizHubRequest.key, registry[bizHubRequest.key]);
            }
            businessHubConversations.delete(userPhone);
            if (supabase) { try { await supabase.from('business_hub_conversations').delete().eq('phone', userPhone); } catch (e) { } }
        }
    } catch (err) {
        console.error(' [Gemini] API call failed:', err.message || err);
    }
};

const normalizeApplicant = (row) => ({
    id: row.id, phone: row.phone || '', name: row.name || '',
    businessName: row.businessName || row.business_name || '',
    businessType: row.businessType || row.business_type || '',
    location: row.location || '', services: row.services || '',
    partnerships: row.partnerships || '', benefit: row.benefit || '',
    status: row.status || 'pending_review', createdAt: row.createdAt || row.created_at || null
});

const detectAdminAlertsGroup = async () => {
    try {
        const groups = await evolution.fetchGroups();
        const allGroups = groups?.data || groups?.groups || groups?.results || (Array.isArray(groups) ? groups : []);
        const keyword = (process.env.ADMIN_ALERTS_GROUP_KEYWORD || 'admin alert').toLowerCase();
        for (const g of Object.values(allGroups)) {
            const subject = ((g.subject || g.name || '') + '').toLowerCase();
            if (subject.includes('admin') && (subject.includes('alert') || subject.includes(keyword))) {
                adminAlertsGroupJid = g.jid || g.id;
                console.log(' [Alerts] Admin alerts group detected: ' + (g.subject || g.name));
                return;
            }
        }
    } catch (e) {
        console.warn(' [Alerts] Could not scan groups for admin alerts:', e.message);
    }
};

const refreshDiscoveredGroups = async (phone) => {
    try {
        const groups = await evolution.fetchGroups();
        const allGroups = groups?.data || groups?.groups || groups?.results || (Array.isArray(groups) ? groups : []);
        const discoveredGroups = Object.values(allGroups).map(g => ({
            jid: g.jid || g.id,
            subject: g.subject || g.name || 'Unknown Group'
        }));
        const meta = loadSessionMeta();
        meta[phone] = { ...(meta[phone] || {}), discoveredGroups, updatedAt: new Date().toISOString() };
        saveSessionMeta(meta);
        triggerSessionBackup(phone, meta[phone].adminName || 'TN Connect Assistant', meta[phone].selectedGroups || [], discoveredGroups);
        return discoveredGroups;
    } catch (e) {
        console.warn(' [Groups] Failed to refresh discovered groups:', e.message);
        return (loadSessionMeta()[phone] || {}).discoveredGroups || [];
    }
};

// ==========================================
// 📱 SENDING FUNCTIONS
// ==========================================

async function sendAntiBanMessage(jid, content, retries = 3) {
    const sinceLast = Date.now() - lastMessageSendTime;
    if (sinceLast < MIN_MESSAGE_INTERVAL_MS) {
        await delay(MIN_MESSAGE_INTERVAL_MS - sinceLast);
    }
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            lastMessageSendTime = Date.now();
            return await evolution.sendText(jid, content.text || content, content.options || {});
        } catch (e) {
            const isRateLimit = e.message?.includes('rate-overlimit') || e.message?.includes('429') || e.message?.includes('Connection Closed');
            if (isRateLimit && attempt < retries - 1) {
                await delay((attempt + 1) * 5000);
                continue;
            }
            if (attempt === retries - 1) {
                lastMessageSendTime = Date.now();
                return await evolution.sendText(jid, content.text || content, content.options || {});
            }
        }
    }
}

const senderPhoneFromJid = (jid) => participantDigits(jid || '');

const isGreetingOrBroadcastIntent = (lowerText) => {
    return /\b(hello|hi|hey|morning|evening|broadcast|announce|send)\b/.test(lowerText);
};

const resolveAdminDisplayName = (adminName) => {
    const trimmed = (adminName || '').trim();
    return trimmed || 'Leader';
};

const isBroadcastAdminRole = (role) => BROADCAST_ADMIN_ROLES.has(role);

const lookupBroadcastAdmin = async (senderPhone, rawJid) => {
    let rosterMatch = CAMPUS_ADMIN_ROSTER.find(a => a.phone === senderPhone);
    if (!rosterMatch && rawJid) {
        const lidMatch = adminLidMap.get(rawJid);
        if (lidMatch) rosterMatch = CAMPUS_ADMIN_ROSTER.find(a => a.phone === lidMatch.phone);
    }
    if (rosterMatch) return { phone: rosterMatch.phone, name: resolveAdminDisplayName(rosterMatch.admin_name) };
    if (supabase) {
        try {
            const { data, error } = await supabase.from('gatekeeper_sessions')
                .select('phone, admin_name, role').eq('phone', senderPhone).maybeSingle();
            if (data && data.role !== 'core_gatekeeper_bot' && isBroadcastAdminRole(data.role)) {
                return { phone: data.phone, name: resolveAdminDisplayName(data.admin_name) };
            }
        } catch (e) { }
    }
    return null;
};

const fetchLiveMonitoredGroups = async () => {
    const meta = loadSessionMeta();
    const phone = Object.keys(meta)[0];
    if (phone && meta[phone]?.discoveredGroups?.length) return meta[phone].discoveredGroups.map(g => ({ jid: g.jid, subject: g.subject }));
    try {
        const groups = await evolution.fetchGroups();
        const allGroups = groups?.data || groups?.groups || groups?.results || (Array.isArray(groups) ? groups : []);
        return Object.values(allGroups).map(g => ({ jid: g.jid || g.id, subject: g.subject || g.name || 'Unknown Group' }));
    } catch (e) {
        console.warn(' [Broadcast] Live group fetch failed:', e.message);
        return [];
    }
};

const handleGroupModeration = async (msg, jid, sender, senderPhone, isAdmin) => {
    if (!sender) return false;
    const textInput = handleGroupModerationExtractText(msg);
    const lowerText = textInput.toLowerCase();
    try { fs.appendFileSync('_trace.log', 'MOD status=' + (msg.status || '?') + ' jid=' + jid + ' sender=' + senderPhone + ' isAdmin=' + isAdmin + ' text="' + textInput.substring(0, 80) + '" msgKeys=[' + (msg.message ? Object.keys(msg.message).join(',') : '') + ']\n'); } catch (e) { }
    const containsLink = lowerText.includes('http://') || lowerText.includes('https://') || lowerText.includes('wa.me/');
    const containsBadWord = BANNED_KEYWORDS.some(word => {
        if (word.includes(' ')) return lowerText.includes(word);
        const re = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
        return re.test(lowerText);
    });
    if (!containsLink && !containsBadWord) { try { fs.appendFileSync('_trace.log', 'MOD_SKIP no link+no badword\n'); } catch (e) { } return false; }
    let shouldAct = false;
    if (isAdmin) { shouldAct = containsBadWord; }
    else { shouldAct = containsBadWord || containsLink; }
    if (!shouldAct) { try { fs.appendFileSync('_trace.log', 'MOD_SKIP shouldAct=false isAdmin=' + isAdmin + ' link=' + containsLink + ' badword=' + containsBadWord + '\n'); } catch (e) { } return false; }
    try { fs.appendFileSync('_trace.log', 'MOD_ACT shouldAct=' + shouldAct + ' link=' + containsLink + ' badword=' + containsBadWord + '\n'); } catch (e) { }
    const humanDelay = 8000 + Math.floor(Math.random() * 7000);
    await delay(humanDelay);
    try {
        try { fs.appendFileSync('_trace.log', 'MOD_DELETE_ATTEMPT msgId=' + (msg.key.id || '?').substring(0, 20) + ' participant=' + (sender || '?').substring(0, 40) + '\n'); } catch (e) { }
        for (let d = 0; d < 3; d++) {
            try {
                await evolution.sendDelete(jid, msg.key.id, sender);
                try { fs.appendFileSync('_trace.log', 'MOD_DELETE_OK attempt=' + d + '\n'); } catch (e) { }
                break;
            } catch (de) {
                try { fs.appendFileSync('_trace.log', 'MOD_DELETE_FAIL attempt=' + d + ' err=' + de.message.substring(0, 100) + '\n'); } catch (e) { }
                if (d === 2) throw de;
                await delay(2000);
            }
        }
        const userName = msg.pushName || senderPhone;
        const alertText = containsBadWord
            ? '@' + userName + ' 🚫 inappropriate language — deleted'
            : '⚠️ @' + userName + ' link sharing restricted — deleted';
        await sendAntiBanMessage(jid, { text: alertText, options: { mentions: [sender] } });
        try { fs.appendFileSync('_trace.log', 'MOD_ALERT_SENT\n'); } catch (e) { }
        console.log(' [Moderation] Removed message from +' + senderPhone + ' in ' + jid);
    } catch (e) {
        try { fs.appendFileSync('_trace.log', 'MOD_FAILED err=' + e.message.substring(0, 150) + '\n'); } catch (e2) { }
        console.error(' [Moderation] Failed:', e.message);
    }
    return true;
};

const scanAllGroupsForOldLinks = async () => {
    const meta = loadSessionMeta();
    const phone = Object.keys(meta)[0];
    const groups = meta[phone]?.discoveredGroups || [];
    if (!groups.length) return;
    console.log(' [Group Scan] Scanning ' + groups.length + ' groups for old links…');
    for (const g of groups) {
        await delay(2000 + Math.floor(Math.random() * 3000));
        try {
            const msgsResponse = await evolution._request('GET', `/chat/fetchMessages/${EVOLUTION_INSTANCE}?jid=${encodeURIComponent(g.jid)}&count=20`);
            const msgs = msgsResponse?.data || msgsResponse?.messages || (Array.isArray(msgsResponse) ? msgsResponse : []);
            for (const m of msgs) {
                if (!m.message || m.key?.fromMe) continue;
                const s = m.key?.participant || m.key?.remoteJid;
                const sp = senderPhoneFromJid(s);
                const txt = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
                if (!txt.toLowerCase().includes('http')) continue;
                if (await lookupBroadcastAdmin(sp, s)) continue;
                await delay(8000 + Math.floor(Math.random() * 7000));
                for (let d = 0; d < 3; d++) {
                    try {
                        await evolution.sendDelete(g.jid, m.key.id, s);
                        console.log(' [Group Scan] Cleaned old link in ' + g.subject + ' from +' + sp);
                        break;
                    } catch (de) { if (d === 2) throw de; await delay(2000); }
                }
            }
        } catch (e) {
            console.warn(' [Group Scan] Error in ' + (g.subject || g.jid) + ': ' + e.message);
        }
    }
    console.log(' [Group Scan] Done');
};

const handleAdminBroadcastDM = async (jid, senderPhone, textInput, adminProfile, rawSender) => {
    console.log(' [Broadcast] DM from ' + senderPhone + ': "' + (textInput || '').substring(0, 60) + '" state=' + (adminBroadcastStates.has(senderPhone) ? adminBroadcastStates.get(senderPhone).step : 'none'));
    const lower = (textInput || '').trim().toLowerCase();
    if (lower === 'broadcast' || lower === 'send' || lower === 'announce') {
        const groups = await fetchLiveMonitoredGroups();
        if (!groups.length) {
            await sendAntiBanMessage(jid, { text: '❌ No monitored groups found. Make sure the bot has discovered groups.' });
            return true;
        }
        adminBroadcastStates.set(senderPhone, {
            step: 'CHOOSING_GROUPS',
            groups,
            selected: [],
            adminName: adminProfile?.name || 'Admin'
        });
        const list = groups.map((g, i) => (i + 1) + '. ' + g.subject).join('\n');
        await sendAntiBanMessage(jid, { text: '📢 *Broadcast Wizard*\n\nSelect groups by replying with numbers (e.g., "1,3,5") or "all" for all groups:\n\n' + list });
        return true;
    }
    const state = adminBroadcastStates.get(senderPhone);
    if (!state) return false;
    if (state.step === 'CHOOSING_GROUPS') {
        if (lower === 'all') {
            state.selected = state.groups;
        } else {
            const indices = lower.split(',').map(s => parseInt(s.trim()) - 1).filter(i => i >= 0 && i < state.groups.length);
            if (!indices.length) {
                await sendAntiBanMessage(jid, { text: '❌ No valid group numbers found. Try again (e.g., "1,3,5" or "all").' });
                return true;
            }
            state.selected = indices.map(i => state.groups[i]);
        }
        state.step = 'CAPTURING_RAW_BODY';
        await sendAntiBanMessage(jid, { text: '✅ ' + state.selected.length + ' group(s) selected. Now send the broadcast message you want to send.' });
        return true;
    }
    if (state.step === 'CAPTURING_RAW_BODY') {
        const broadcastText = textInput.trim();
        if (!broadcastText) {
            await sendAntiBanMessage(jid, { text: '❌ Message cannot be empty. Send the text you want to broadcast.' });
            return true;
        }
        await sendAntiBanMessage(jid, { text: '📤 Sending broadcast to ' + state.selected.length + ' group(s)...\n\n"' + broadcastText.substring(0, 100) + (broadcastText.length > 100 ? '...' : '') + '"' });
        let sent = 0;
        let failed = 0;
        for (const group of state.selected) {
            try {
                await sendAntiBanMessage(group.jid, { text: '📢 *' + (state.adminName || 'Admin') + '*:\n\n' + broadcastText });
                sent++;
                await delay(Math.floor(Math.random() * 4000) + 3000);
            } catch (e) {
                console.error(' [Broadcast] Failed to send to ' + group.subject + ':', e.message);
                failed++;
            }
        }
        adminBroadcastStates.delete(senderPhone);
        await sendAntiBanMessage(jid, { text: '✅ *Broadcast complete*\nSent: ' + sent + '/' + state.selected.length + '\nFailed: ' + failed });
        return true;
    }
    return false;
};

// ==========================================
// 📨 WEBHOOK — RECEIVE INCOMING MESSAGES FROM EVOLUTION API
const webhookLog = [];
// ==========================================
app.post('/webhook', async (req, res) => {
    const payload = req.body;
    if (!payload) return res.status(200).json({ ok: true });
    const eventType = (payload.event || payload.Event || '').toUpperCase().replace(/\./g, '_');
    let messages = [];
    if (eventType === 'MESSAGES_UPSERT') {
        const data = payload.data || payload;
        if (Array.isArray(data)) messages = data;
        else if (data?.key) messages = [data];
        else if (data?.messages) messages = data.messages;
    } else if (payload?.key) {
        messages = [payload];
    }
    if (eventType === 'CONNECTION_UPDATE') {
        const state = payload.instance?.state || payload.data?.instance?.state || '';
        if (state === 'open') console.log(' [Webhook] Instance connected');
        res.status(200).json({ ok: true });
        return;
    }
    let detail = { event: eventType, time: Date.now(), count: messages.length };
    if (messages.length && messages[0]) {
        const m = messages[0];
        detail.jid = m.key?.remoteJid || '';
        detail.status = m.status || '';
        detail.fromMe = !!m.key?.fromMe;
        detail.msgKeys = m.message ? Object.keys(m.message).join(',') : '';
        const tx = extractIncomingPayload(m).text || handleGroupModerationExtractText(m);
        detail.text = (tx || '').substring(0, 80);
        detail.participant = m.key?.participant || '';
    }
    webhookLog.unshift(detail);
    if (webhookLog.length > 200) webhookLog.length = 200;
    try { fs.appendFileSync('_trace.log', 'WEBHOOK ' + eventType + ' jid=' + (detail.jid || '') + ' status=' + (detail.status || '') + ' text="' + (detail.text || '') + '" msgKeys=[' + (detail.msgKeys || '') + ']\n'); } catch (e) { }
    res.status(200).json({ ok: true });
    for (const msg of messages) {
        try { await processIncomingMessage(msg); }
        catch (e) { console.error(' [Webhook] Error processing message:', e.message); }
    }
});

const handleGroupModerationExtractText = (msg) => {
    const m = msg.message;
    if (!m) return '';
    if (m.conversation) return m.conversation;
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
    try {
        const ct = Object.keys(m).find(k => k !== 'messageContextInfo');
        if (ct && m[ct]?.text) return m[ct].text;
        if (ct && m[ct]?.caption) return m[ct].caption;
    } catch (e) { }
    return '';
};

async function processIncomingMessage(msg) {
    if (!msg || !msg.key || msg.key.fromMe) return;
    const jid = msg.key.remoteJid;
    if (!jid) return;
    const isGroup = jid.endsWith('@g.us');
    const sender = isGroup ? (msg.key.participant || jid) : jid;
    const senderPhone = senderPhoneFromJid(sender);
    try { fs.appendFileSync('_trace.log', 'RECV jid=' + jid + ' isGroup=' + isGroup + ' fromMe=' + msg.key.fromMe + '\n'); } catch (e) { }
    const adminProfile = await lookupBroadcastAdmin(senderPhone, sender);
    let isAdmin = !!adminProfile;
    console.log(' [Msg] From ' + senderPhone + ' isAdmin=' + isAdmin + ' isGroup=' + isGroup);
    if (isGroup) {
        const moderated = await handleGroupModeration(msg, jid, sender, senderPhone, isAdmin);
        if (moderated) return;
        return;
    }
    const { text: dmText } = extractIncomingPayload(msg);
    if (isAdmin) {
        const handled = await handleAdminBroadcastDM(jid, senderPhone, dmText, adminProfile, sender);
        if (handled) return;
    }
    if (adminBroadcastStates.has(senderPhone)) return;
    const bizHubRequest = findBusinessHubRequest(jid);
    if (bizHubRequest && !humanTakeoverUsers.has(formatPhoneNumberGH(senderPhone))) {
        const { text, hasImage } = extractIncomingPayload(msg);
        const textInput = text || (hasImage ? '(Applicant sent an image)' : '');
        if (textInput) await handleBusinessHubConversation(jid, textInput, bizHubRequest, bizHubRequest.admin || getBotAdminContext().name);
        return;
    }
    const pendingRequest = findPendingRequest(jid);
    if (pendingRequest) await handleGatekeeperDM(jid, msg, pendingRequest);
    if (isAdmin && !bizHubRequest && !pendingRequest) {
        try { fs.appendFileSync('_trace.log', 'ADMIN_CATCHALL trying reply to ' + senderPhone + '\n'); } catch (e) {}
        try {
            await sendAntiBanMessage(jid, { text: '👋 Hi ' + (adminProfile?.name || 'Admin') + '! I\'m the TN Gatekeeper bot.\n\nAvailable commands:\n• *broadcast* — Send a message to monitored groups\n• *send* — Same as broadcast\n• *announce* — Same as broadcast' });
            try { fs.appendFileSync('_trace.log', 'ADMIN_CATCHALL reply SENT OK\n'); } catch (e) {}
        } catch (e) {
            try { fs.appendFileSync('_trace.log', 'ADMIN_CATCHALL REPLY FAILED: ' + e.message + '\n'); } catch (e2) {}
        }
    }
}

// ==========================================
// 🌐 EXPRESS REST API ENDPOINTS
// ==========================================
app.get('/debug/webhook', (req, res) => { res.json(webhookLog); });
app.get('/debug/trace', (req, res) => {
    try {
        const data = fs.readFileSync('_trace.log', 'utf8');
        const lines = data.split('\n').filter(Boolean).slice(-100);
        res.json({ lines, count: lines.length });
    } catch (e) { res.json({ lines: [], error: e.message }); }
});
app.post('/debug/testmod', async (req, res) => {
    const { groupJid, text, senderPhone } = req.body || {};
    if (!groupJid || !text) return res.status(400).json({ error: 'groupJid and text required' });
    const lowerText = text.toLowerCase();
    const containsLink = lowerText.includes('http://') || lowerText.includes('https://') || lowerText.includes('wa.me/');
    const containsBadWord = BANNED_KEYWORDS.some(word => {
        if (word.includes(' ')) return lowerText.includes(word);
        const re = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
        return re.test(lowerText);
    });
    const adminProfile = senderPhone ? await lookupBroadcastAdmin(senderPhone, null) : null;
    const isAdmin = !!adminProfile;
    let wouldAct = false;
    if (isAdmin) wouldAct = containsBadWord;
    else wouldAct = containsBadWord || containsLink;
    res.json({ text, containsLink, containsBadWord, isAdmin, wouldAct, wouldDeleteLink: !isAdmin && containsLink, wouldDeleteBadWord: containsBadWord });
});
app.get('/api/sessions', async (req, res) => {
    try {
        const sessionArray = [];
        if (activeSessionPhone) {
            const meta = loadSessionMeta()[activeSessionPhone] || {};
            sessionArray.push({
                phone: activeSessionPhone, name: meta.adminName || 'TN Connect Assistant',
                connected: true, discoveredGroups: meta.discoveredGroups || []
            });
            return res.json(sessionArray);
        }
        if (supabase) {
            const { data, error } = await supabase.from('gatekeeper_sessions')
                .select('phone, admin_name, discovered_groups').eq('role', 'core_gatekeeper_bot').maybeSingle();
            if (!error && data?.phone) {
                const cloudPhone = String(data.phone).replace(/\D/g, '');
                const meta = loadSessionMeta()[cloudPhone] || {};
                sessionArray.push({
                    phone: cloudPhone, name: data.admin_name || meta.adminName || 'TN Connect Assistant',
                    connected: false, discoveredGroups: meta.discoveredGroups || data.discovered_groups || []
                });
                return res.json(sessionArray);
            }
        }
        res.json(sessionArray);
    } catch (err) {
        console.error('Error in GET /api/sessions:', err.message);
        res.status(500).json([]);
    }
});

app.get('/api/business-hub/applicants', async (req, res) => {
    try {
        if (supabase) {
            const { data, error } = await supabase.from('business_hub_applicants').select('*').order('created_at', { ascending: false });
            if (!error && data) return res.json(data.map(normalizeApplicant));
        }
        const localApplicants = loadApplicants();
        res.json(Array.isArray(localApplicants) ? localApplicants.map(normalizeApplicant) : []);
    } catch (err) {
        console.error("Error in GET /api/business-hub/applicants:", err.message);
        res.status(500).json([]);
    }
});

app.post('/api/auth/request-code', async (req, res) => {
    let phone = req.body.adminPhone || req.body.phone;
    const adminName = (req.body.adminName || 'TN Connect Assistant').trim();
    const selectedGroups = Array.isArray(req.body.selectedGroups) ? req.body.selectedGroups : [];
    const adminRole = req.body.adminRole || 'Admin';
    if (!phone) return res.status(400).json({ error: 'Phone target parameter is required.' });
    phone = String(phone).replace(/\D/g, '');
    console.log(' [Pairing Router] Triggering setup for +' + phone + ' (' + adminName + ')');
    try {
        if (activeSessionPhone === phone) return res.json({ status: 'CONNECTED', success: true });
        activeSessionPhone = phone;
        const meta = loadSessionMeta();
        meta[phone] = { ...(meta[phone] || {}), adminName, role: adminRole, selectedGroups };
        saveSessionMeta(meta);
        startupTime = Date.now();
        console.log(' [Session] Bot session initialized for +' + phone);
        await detectAdminAlertsGroup();
        await refreshDiscoveredGroups(phone);
        await scanPendingJoinRequests();
        await scanAllGroupsForOldLinks();
        res.json({ success: true, status: 'CONNECTED', message: 'Using Evolution API - already connected via tn-connect instance' });
    } catch (err) {
        console.error(' request-code error:', err.message || err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admins/register', async (req, res) => {
    let phone = String(req.body.adminPhone || req.body.phone || '').replace(/\D/g, '');
    const adminName = (req.body.adminName || 'Admin').trim();
    if (!phone) return res.status(400).json({ error: 'adminPhone or phone is required.' });
    if (!supabase) return res.status(503).json({ error: 'Supabase is required.' });
    try {
        const { error } = await supabase.from('gatekeeper_sessions').upsert({
            phone, admin_name: adminName, role: 'admin_node', updated_at: new Date().toISOString()
        });
        if (error) return res.status(500).json({ error: error.message });
        res.json({ success: true, phone, adminName });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admins/seed-campus', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Supabase is required.' });
    try {
        const rows = CAMPUS_ADMIN_ROSTER.map(a => ({
            phone: a.phone, admin_name: a.admin_name, role: 'admin_node', updated_at: new Date().toISOString()
        }));
        const { error } = await supabase.from('gatekeeper_sessions').upsert(rows);
        if (error) return res.status(500).json({ error: error.message });
        res.json({ success: true, count: rows.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:phone/disconnect', async (req, res) => {
    const phone = String(req.params.phone || '').replace(/\D/g, '');
    if (!phone) return res.status(400).json({ success: false, error: 'Invalid phone.' });
    try {
        activeSessionPhone = null;
        const dirPath = path.join(__dirname, 'auth_session_' + phone);
        if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
        if (supabase) {
            await supabase.from('gatekeeper_sessions').delete().eq('phone', phone);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Disconnect error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

async function sendAdminAlert(alertText) {
    if (adminAlertsGroupJid) {
        try {
            await evolution.sendText(adminAlertsGroupJid, alertText);
        } catch (e) {
            console.error("Failed to send message to admin group:", e.message);
        }
    } else {
        console.log("No admin alerts group JID detected. Printing alert:\n" + alertText);
    }
}

app.use('/api', (req, res) => {
    res.status(404).json({ error: 'API Route not found.' });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================
// 🚀 SERVER START
// ==========================================
const server = http.createServer(app);
server.listen(PORT, async () => {
    console.log(' [Server] Gatekeeper v1.4 (Evolution API) is live on port ' + PORT);
    await ensureRegistryLoaded();
    console.log(' [Session] Using Evolution API instance: ' + EVOLUTION_INSTANCE);
    try {
        const status = await evolution.fetchInstanceStatus();
        const state = status?.instance?.state || 'unknown';
        console.log(' [Session] Evolution API instance status: ' + state);
        if (state === 'open') {
            activeSessionPhone = '233536763993';
            startupTime = Date.now();
            console.log(' [Boot] Active session: ' + activeSessionPhone);
            const remainingSilence = Math.max(0, RATE_LIMIT_COOLDOWN_MS - (Date.now() - startupTime));
            if (remainingSilence > 0) {
                const mins = Math.round(remainingSilence / 60000);
                console.log(' [Boot] Rate-limit cooldown: ' + mins + ' min ' + Math.round((remainingSilence % 60000) / 1000) + 's of silence…');
                await delay(remainingSilence);
            }
            await detectAdminAlertsGroup();
            const phone = activeSessionPhone;
            const meta = loadSessionMeta()[phone] || {};
            await refreshDiscoveredGroups(phone);
            await scanPendingJoinRequests();
            await scanAllGroupsForOldLinks();
        }
    } catch (e) {
        console.warn(' [Boot] Could not verify Evolution API instance status:', e.message);
    }
    if (SERVER_URL) {
        console.log(' [Webhook] Configure Evolution API webhook to: ' + SERVER_URL + '/webhook');
    } else {
        console.log(' [Webhook] Set SERVER_URL env var to enable webhook for incoming messages');
    }
});

require('dotenv').config();
process.on('uncaughtException', (err) => console.error(' [Crash Guard] Uncaught:', err.message));
process.on('unhandledRejection', (err) => console.error(' [Crash Guard] Rejection:', err.message));
const { BaileysClient } = require('./baileys-client');
const { BufferJSON, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { AntiBan } = require('baileys-antiban');
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
const OpenAI = require('openai');
const { generateChatScreenshot } = require('./chatScreenshot');

// ==========================================
// 📡 SERVER CONFIGURATION & MIDDLEWARE
// ==========================================
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 10000;
const SESSION_META_FILE = './sessions_meta.json';
const REGISTRY_FILE = './registry.json';
const APPLICANTS_FILE = './business_hub_applicants.json';
const GROUP_FLOWS_FILE = './group_flows.json';
const REGISTERED_ADMINS_FILE = './registered_admins.json';
const BROADCAST_CONFIG_FILE = './broadcast_config.json';
const LOCKED_GROUPS_FILE = './locked_groups.json';

// Baileys configuration
const AUTH_FOLDER = process.env.AUTH_FOLDER || './auth_info';
const SERVER_URL = process.env.SERVER_URL || '';
const PHONE_NUMBER = process.env.PHONE_NUMBER || '';

let client = new BaileysClient({ authFolder: AUTH_FOLDER, sessionName: 'tn-connect' });
let antiban = null;

// Global variables
let activeSessionPhone = null;
const pendingApprovals = new Map();
const pendingVerifications = new Map();
const businessHubConversations = new Map();
const humanTakeoverUsers = new Set();
const joinIntroSentKeys = new Set();
const adminBroadcastStates = new Map();
const groupLockStates = new Map(); // lock/unlock wizard states per admin
const registeredAdmins = new Map(); // local fallback cache of admins registered via WhatsApp DM
const botAdminGroupCache = new Map(); // cache to track if the bot itself is an admin in groups

const loadRegisteredAdmins = () => {
    if (!fs.existsSync(REGISTERED_ADMINS_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(REGISTERED_ADMINS_FILE, 'utf-8')); }
    catch (e) { return {}; }
};
const saveRegisteredAdmins = (data) => {
    try { fs.writeFileSync(REGISTERED_ADMINS_FILE, JSON.stringify(data, null, 2)); }
    catch (e) { console.error('Failed to write registered_admins.json:', e); }
};
// hydrate local cache on boot
(() => {
    const data = loadRegisteredAdmins();
    for (const [phone, entry] of Object.entries(data)) {
        registeredAdmins.set(phone, entry);
    }
    if (Object.keys(data).length) console.log(' [Admin Registry] Loaded ' + Object.keys(data).length + ' registered admin(s) from disk');
})();

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
    { phone: '233264579213', admin_name: 'Yhaar Bhaby' },
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
    { phone: '233506746307', admin_name: 'Kingenious' },
    { phone: '233597626090', admin_name: 'Kingenious' },
    { phone: '233538719819', admin_name: 'Mr.Gyan' },
    { phone: '233595802277', admin_name: 'PROPHETIC BUSINESS' }
];

const adminLidMap = new Map();
const uploadDebounces = {};

const RATE_LIMIT_COOLDOWN_MS = parseInt(process.env.RATE_LIMIT_COOLDOWN_MS || '') || 20000;
let startupTime = 0;
let lastMessageSendTime = 0;
const MIN_MESSAGE_INTERVAL_MS = 8000;

let adminAlertsGroupJid = null;
let cachedGroups = [];
let cachedGroupsLastRefresh = 0;

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
const groqClient = process.env.GROQ_API_KEY ? new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' }) : null;

if (geminiModel) {
    console.log(' [Gemini] AI intake engine is ACTIVE for Business Hub groups.');
} else {
    console.log(' [Gemini] GEMINI_API_KEY missing. Business Hub AI intake will be DISABLED.');
}
if (groqClient) {
    console.log(' [Groq] Vision engine ACTIVE for Reply Assistant.');
} else {
    console.log(' [Groq] GROQ_API_KEY missing. Reply Assistant will use Gemini fallback.');
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

const resolveLidToPhone = (lidJid) => {
    const lidDigits = String(lidJid || '').replace(/@lid.*$/i, '').replace(/\D/g, '');
    if (!lidDigits) return null;
    const filePath = path.join(AUTH_FOLDER, 'lid-mapping-' + lidDigits + '_reverse.json');
    try {
        if (fs.existsSync(filePath)) {
            const phone = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (phone) return String(phone).replace(/\D/g, '');
        }
    } catch (e) { /* lid mapping file may not exist */ }
    return null;
};

const isJidMe = (jid) => {
    if (!jid) return false;
    const myJid = client.sock?.user?.id;
    const myLid = client.sock?.user?.lid;
    const cleanMyJid = myJid ? myJid.split(':')[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : '';
    const cleanMyLid = myLid ? myLid.split(':')[0].replace(/[^0-9]/g, '') + '@lid' : '';
    
    const cleanJidStr = typeof jid === 'string' ? jid : jid.id || jid.jid || '';
    const targetJid = cleanJidStr.split(':')[0].replace(/[^0-9]/g, '');
    
    if (cleanMyJid && targetJid + '@s.whatsapp.net' === cleanMyJid) return true;
    if (cleanMyLid && targetJid + '@lid' === cleanMyLid) return true;
    
    if (activeSessionPhone) {
        const digits = cleanJidStr.replace(/@s\.whatsapp\.net/gi, '').replace(/@lid/gi, '').replace(/\D/g, '');
        if (digits === activeSessionPhone) return true;
    }
    return false;
};

const participantDigits = (jid) => {
    if (typeof jid === 'object') jid = jid.phoneNumber || jid.id || jid.jid || '';
    const str = String(jid || '');
    const lidPhone = resolveLidToPhone(str);
    if (lidPhone) return lidPhone;
    return str.replace(/@s\.whatsapp\.net/gi, '').replace(/@lid/gi, '').replace(/\D/g, '');
};

const buildRegistryKey = (groupJid, participantJid) => {
    return groupJid + '_' + participantDigits(participantJid);
};

const dmJidFromParticipant = (participantJid) => {
    if (!participantJid) return null;
    if (typeof participantJid === 'object') participantJid = participantJid.phoneNumber || participantJid.id || participantJid.jid || '';
    const normalized = String(participantJid || '').replace(/@lid.*$/, '').replace(/[^0-9]/g, '');
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

const extractQuotedMessageText = (msg) => {
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo || msg.message?.imageMessage?.contextInfo || msg.message?.videoMessage?.contextInfo || msg.message?.documentMessage?.contextInfo;
    const quoted = contextInfo?.quotedMessage;
    if (!quoted) return '';
    
    if (quoted.conversation) return quoted.conversation;
    if (quoted.extendedTextMessage?.text) return quoted.extendedTextMessage.text;
    
    try {
        const ct = Object.keys(quoted).find(k => k !== 'messageContextInfo');
        if (ct && quoted[ct]?.text) return quoted[ct].text;
        if (ct && quoted[ct]?.caption) return quoted[ct].caption;
    } catch (e) { }
    return '';
};

const parseGeminiJson = (text) => {
    const match = (text || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); }
    catch (e) { return null; }
};

const deepVerifyScreenshotEvidence = async (buffer, mime) => {
    if (!groqClient && !geminiClient) return { valid: false, reason: 'Verification service is temporarily unavailable.', platform: null };
    try {
        const SYSTEM_PROMPT = 'You are a strict fraud reviewer for TN Connect Ghana WhatsApp group joins. Accept ONLY if this image is a real screenshot showing the user completed AT LEAST ONE valid proof below.\n' +
            PROOF_ACCOUNTS_GUIDE + '\n' +
            'REJECT if: unrelated photo, meme, random chat, black screen, wrong unrelated account, no follow/join proof visible, obvious fake/edited image, stock photo, or bypass attempt.\n' +
            'Do NOT reject solely because the account name differs between platforms (TikTok @tnfilmsgh vs Facebook TN Universities Connect is correct).\n\n' +
            'Reply with ONLY JSON: {"valid":true|false,"reason":"one short sentence","platform":"tiktok|social|channel|none"}';
        const raw = await analyzeScreenshotWithProvider(buffer, mime || 'image/jpeg', SYSTEM_PROMPT, 'Verify this proof screenshot.', 300);
        if (!raw) throw new Error('No response from AI');
        const parsed = parseGeminiJson(raw);
        if (parsed && typeof parsed.valid === 'boolean') {
            return { valid: parsed.valid, reason: String(parsed.reason || '').trim() || (parsed.valid ? 'Valid proof detected.' : 'Invalid proof.'), platform: parsed.platform || null };
        }
        const lower = raw.toLowerCase();
        const valid = lower.includes('"valid":true') || lower.includes('"valid": true');
        return { valid, reason: valid ? 'Proof accepted.' : 'Could not verify this image as legitimate proof.', platform: null };
    } catch (e) {
        console.error(' [DeepVerify] AI screenshot verify failed:', e.message);
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
    if (existing && ['approved', 'verification_complete'].includes(existing.status)) {
        joinIntroSentKeys.add(existing.key || registryKey);
        return;
    }
    const admin = getBotAdminContext();
    const groupSubject = groupSubjectHint || await getGroupSubject(groupJid);
    const entry = {
        admin: admin.name, phone: admin.phone, groupJid, groupSubject,
        rawParticipantJid: participantJid, participantJid: dmJid,
        status: 'pending_approval', timestamp: new Date().toISOString()
    };
    await saveRegistryItem(registryKey, entry);
    joinIntroSentKeys.add(registryKey);
    console.log(' [Join] New join request: ' + groupSubject + ' from ' + dmJid + ' — queuing auto-approve');

    // Auto-approve after a random human-paced delay (3s – 90s)
    const humanDelay = 3000 + Math.floor(Math.random() * 87000);
    console.log(' [Join] Auto-approving ' + dmJid + ' in ' + Math.round(humanDelay / 1000) + 's...');
    setTimeout(async () => {
        try {
            const rawJid = typeof participantJid === 'string' ? participantJid : (participantJid.id || dmJid);
            await client.approveGroupJoinRequest(groupJid, rawJid);
            console.log(' [Join] ✅ Auto-approved ' + dmJid + ' into ' + groupSubject);
            const reg = loadRegistry();
            if (reg[registryKey]) {
                reg[registryKey].status = 'approved';
                reg[registryKey].approvedAt = new Date().toISOString();
                await saveRegistryItem(registryKey, reg[registryKey]);
            }
            await sendAdminAlert([
                '✅ *[AUTO-APPROVED]*', '',
                '📱 *Member:* ' + dmJid.replace('@s.whatsapp.net', ''),
                '🌐 *Group:* ' + groupSubject
            ].join('\n'));
        } catch (e) {
            console.error(' [Join] Auto-approve failed for ' + dmJid + ':', e.message.substring(0, 100));
            // Queue for retry
            const qKey = groupJid + '|' + dmJid;
            pendingApprovals.set(qKey, { groupJid, jid: dmJid, rawJid: participantJid, groupSubject, time: Date.now(), attempts: 0 });
        }
    }, humanDelay);
};

const extractPhoneFromParticipant = (p) => {
    if (!p) return '';
    if (typeof p === 'string') return p.replace(/[^0-9]/g, '');
    if (typeof p === 'object') {
        const phone = p.phoneNumber || p.id || p.jid || p.user || '';
        return String(phone).replace(/[^0-9]/g, '');
    }
    return String(p).replace(/[^0-9]/g, '');
};

const resolveParticipantPhone = (p) => {
    const rawId = typeof p === 'object' ? (p.id || p.jid || '') : String(p || '');
    const extracted = extractPhoneFromParticipant(p);
    if (rawId.endsWith('@lid')) {
        const lidEntry = adminLidMap.get(rawId);
        if (lidEntry) {
            console.log(' [LidMap] Resolved ' + rawId + ' -> ' + lidEntry.phone);
            return lidEntry.phone;
        }
    }
    return extracted;
};

const approveWithPacing = async (groupJid, participantJids) => {
    if (startupTime && (Date.now() - startupTime) < RATE_LIMIT_COOLDOWN_MS) return;
    const raw = Array.isArray(participantJids) ? participantJids : [participantJids];
    const jids = raw.map(resolveParticipantPhone).filter(Boolean);
    if (!jids.length) return;
    for (let i = 0; i < jids.length; i++) {
        const delayMs = i === 0
            ? Math.floor(Math.random() * 60000) + 60000
            : Math.floor(Math.random() * 20000) + 20000;
        await new Promise(r => setTimeout(r, delayMs));
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await client.addGroupParticipant(groupJid, jids[i]);
                console.log(' [Auto-Approval] Approved ' + jids[i] + ' into ' + groupJid);
                // Remove from retry queue if it was there
                const qKey = groupJid + '|' + jids[i];
                pendingApprovals.delete(qKey);
                break;
            } catch (e) {
                const isRetryable = e.message?.includes('Connection Closed') || e.message?.includes('rate-overlimit') || e.message?.includes('timeout');
                if (isRetryable && attempt < 2) {
                    const backoff = (attempt + 1) * 30000;
                    console.log(' [Auto-Approval] Retry ' + (attempt + 1) + '/3 for ' + jids[i] + ' in ' + groupJid + ' after ' + backoff + 'ms');
                    await new Promise(r => setTimeout(r, backoff));
                } else {
                    console.error(' [Auto-Approval] Failed for ' + jids[i] + ' in ' + groupJid + ':', e.message.substring(0, 120));
                    // Queue for later retry
                    const qKey = groupJid + '|' + jids[i];
                    pendingApprovals.set(qKey, { groupJid, jid: jids[i], time: Date.now(), attempts: 0 });
                    break;
                }
            }
        }
    }
};

const approveGroupJoinRequest = async (pendingRequest) => {
    const groupJid = pendingRequest.groupJid;
    const candidates = [
        resolveParticipantPhone(pendingRequest.rawParticipantJid),
        resolveParticipantPhone(pendingRequest.participantJid),
    ].filter((j, i, arr) => j && arr.indexOf(j) === i);
    for (const jid of candidates) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await client.approveGroupJoinRequest(groupJid, jid);
                return { success: true, jid };
            } catch (e) {
                const isRetryable = e.message?.includes('Connection Closed') || e.message?.includes('rate-overlimit') || e.message?.includes('timeout');
                if (isRetryable && attempt < 2) {
                    const backoff = (attempt + 1) * 30000;
                    console.log(' [Gatekeeper] Retry ' + (attempt + 1) + '/3 for ' + jid + ' in ' + groupJid + ' after ' + backoff + 'ms');
                    await new Promise(r => setTimeout(r, backoff));
                } else {
                    console.warn(' [Gatekeeper] Approve failed for ' + jid + ':', e.message.substring(0, 120));
                    break;
                }
            }
        }
    }
    return { success: false, jid: null };
};

// Proof-based gatekeeper removed — all approvals are now fully automatic.

const scanPendingJoinRequests = async () => {
    if (!client || !client.connected) return;
    await ensureRegistryLoaded();
    // If cache is empty, call refreshGroupCache which has the metadata fallback
    // (refreshDiscoveredGroups only uses the live socket — returns nothing while syncing)
    if (!cachedGroups.length) {
        await refreshGroupCache();
    }
    const groupsToScan = cachedGroups.filter(g => botAdminGroupCache.get(g.jid) === true);
    if (!groupsToScan.length) {
        console.log(' [Join Scan] No admin groups in cache yet — skipping scan (will retry on next periodic refresh).');
        return;
    }
    console.log(` [Join Scan] Scanning ${groupsToScan.length} admin group(s) for pending join requests…`);
    for (const g of groupsToScan) {
        const groupJid = g.jid;
        try {
            await delay(2000 + Math.floor(Math.random() * 3000));
            const requests = await client.fetchGroupJoinRequests(groupJid);
            const list = Array.isArray(requests) ? requests : (requests?.records || requests?.results || []);
            if (list.length) {
                console.log(` [Join Scan] Found ${list.length} pending request(s) in ${g.subject || groupJid} — auto-approving`);
                for (const req of list) {
                    const participantJid = req.jid || req.id;
                    if (participantJid) {
                        await processJoinRequest(groupJid, participantJid, 'created', g.subject || '');
                    }
                }
            }
        } catch (e) {
            // "forbidden" = bot not admin in this group at the moment — skip silently
            if (!e.message?.toLowerCase().includes('forbidden')) {
                console.warn(` [Join Scan] Could not scan ${g.subject || groupJid}:`, e.message);
            }
        }
    }
};

// handleGatekeeperDM — now only handles DMs from people whose approval is in-flight
// (no proof needed — auto-approve is already queued)
const handleGatekeeperDM = async (senderJid, msg) => {
    // Silently ignore — approval is already queued automatically, no reply needed
    return;
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

let presenceTimer = null;
const startPresenceCycling = () => {
    if (presenceTimer) return;
    const cycle = async () => {
        try {
            if (client?.sock?.sendPresenceUpdate) {
                await client.sock.sendPresenceUpdate('unavailable');
            }
        } catch {}
        presenceTimer = setTimeout(cycle, 120000 + Math.floor(Math.random() * 120000));
    };
    presenceTimer = setTimeout(cycle, 60000 + Math.floor(Math.random() * 60000));
};

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
        const groups = await client.fetchGroups();
        const allGroups = groups?.data || groups?.groups || groups?.results || (Array.isArray(groups) ? groups : []);
        const keyword = (process.env.ADMIN_ALERTS_GROUP_KEYWORD || 'admin alert').toLowerCase();
        for (const g of Object.values(allGroups)) {
            const subject = ((g.subject || g.name || '') + '').toLowerCase();
            if (subject.includes('admin') && (subject.includes('alert') || subject.includes('broadcast') || subject.includes(keyword))) {
                adminAlertsGroupJid = g.jid || g.id;
                console.log(' [Alerts] Admin alerts group detected: ' + (g.subject || g.name));
                return;
            }
        }
    } catch (e) {
        console.warn(' [Alerts] Could not scan groups for admin alerts:', e.message);
    }
};

const populateLidMap = async () => {
    try {
        const groups = await client.fetchGroups(true);
        const allGroups = groups?.data || groups?.groups || groups?.results || (Array.isArray(groups) ? groups : []);
        let count = 0;
        for (const g of Object.values(allGroups)) {
            for (const p of (g.participants || [])) {
                if (p.id && p.id.endsWith('@lid') && p.phoneNumber) {
                    const phone = p.phoneNumber.replace(/[^0-9]/g, '');
                    adminLidMap.set(p.id, { phone, name: p.name || '' });
                    count++;
                }
            }
        }
        if (count > 0) console.log(' [LidMap] Mapped ' + count + ' Lid IDs to phone numbers');
    } catch (e) {
        console.warn(' [LidMap] Could not populate Lid map:', e.message);
    }
};

const refreshDiscoveredGroups = async (phone) => {
    try {
        const groups = await client.fetchGroups();
        const allGroups = groups?.data || groups?.groups || groups?.results || (Array.isArray(groups) ? groups : []);
        
        if (allGroups.length === 0) {
            console.log(' [Groups] Fetched 0 groups from socket (syncing). Keeping existing session metadata.');
            return (loadSessionMeta()[phone] || {}).discoveredGroups || [];
        }

        const myJid = client.sock?.user?.id;
        const cleanMyJid = myJid ? myJid.split(':')[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : '';

        const discoveredGroups = [];
        for (const g of Object.values(allGroups)) {
            const rawParticipants = g.participants || [];
            const me = rawParticipants.find(p => isJidMe(p));
            const isBotAdmin = !!(me && (me.admin === 'admin' || me.admin === 'superadmin'));
            
            botAdminGroupCache.set(g.jid || g.id, isBotAdmin);

            // ONLY focus on and list groups where the bot itself is an admin
            if (isBotAdmin) {
                discoveredGroups.push({
                    jid: g.jid || g.id,
                    subject: g.subject || g.name || 'Unknown Group',
                    isBotAdmin
                });
            }
        }

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
    const textContent = (typeof content === 'string') ? content : (content.text || '');
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            lastMessageSendTime = Date.now();
            return await client.sendText(jid, content.text || content, content.options || {});
        } catch (e) {
            const msg = (e.message || '').toLowerCase();
            const isRateLimit = msg.includes('rate') || msg.includes('429') || msg.includes('connection closed') || msg.includes('too fast');
            if (isRateLimit && attempt < retries - 1) {
                const backoff = (attempt + 1) * 8000;
                console.warn(' [Send] Rate limited, backing off ' + backoff + 'ms (attempt ' + (attempt + 1) + '/' + retries + ')');
                await delay(backoff);
                continue;
            }
            if (attempt === retries - 1) {
                lastMessageSendTime = Date.now();
                try {
                    return await client.sendText(jid, content.text || content, content.options || {});
                } catch (f) {
                    console.error(' [Send] Final attempt failed:', f.message.substring(0, 100));
                    return null;
                }
            }
        }
    }
}

const senderPhoneFromJid = (jid) => participantDigits(jid || '');

const isBroadcastIntent = (lowerText) => {
    return /\b(broadcast|announce|send)\b/.test(lowerText);
};

const resolveAdminDisplayName = (adminName) => {
    const trimmed = (adminName || '').trim();
    return trimmed || 'Leader';
};

const isBroadcastAdminRole = (role) => BROADCAST_ADMIN_ROLES.has(role);

const lookupBroadcastAdmin = async (senderPhone, rawJid) => {
    let rosterMatch = CAMPUS_ADMIN_ROSTER.find(a => a.phone === senderPhone);
    if (!rosterMatch && rawJid) {
        const variants = [rawJid, rawJid.replace(/:.*@lid/, '@lid')];
        for (const v of variants) {
            const lidMatch = adminLidMap.get(v);
            if (lidMatch) { rosterMatch = CAMPUS_ADMIN_ROSTER.find(a => a.phone === lidMatch.phone); if (rosterMatch) break; }
        }
        if (!rosterMatch) {
            for (const [, entry] of adminLidMap) {
                if (CAMPUS_ADMIN_ROSTER.find(a => a.phone === entry.phone)) { rosterMatch = CAMPUS_ADMIN_ROSTER.find(a => a.phone === entry.phone); break; }
            }
        }
    }
    if (!rosterMatch && rawJid && rawJid.endsWith('@lid')) {
        const noSuffix = rawJid.replace(/:.*@lid/, '@lid');
        const realPhone = resolveLidToPhone(noSuffix);
        if (realPhone) rosterMatch = CAMPUS_ADMIN_ROSTER.find(a => a.phone === realPhone);
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
    // local fallback cache (admins registered via WhatsApp DM without Supabase)
    const localAdmin = registeredAdmins.get(senderPhone);
    if (localAdmin) return { phone: senderPhone, name: resolveAdminDisplayName(localAdmin.name) };
    return null;
};

const refreshGroupCache = async () => {
    try {
        const groups = await client.fetchGroups();
        const allGroups = groups?.data || groups?.groups || groups?.results || (Array.isArray(groups) ? groups : []);
        
        const myJid = client.sock?.user?.id;
        const cleanMyJid = myJid ? myJid.split(':')[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : '';

        const adminGroups = [];
        for (const g of Object.values(allGroups)) {
            const rawParticipants = g.participants || [];
            const me = rawParticipants.find(p => isJidMe(p));
            const isBotAdmin = !!(me && (me.admin === 'admin' || me.admin === 'superadmin'));
            
            botAdminGroupCache.set(g.jid || g.id, isBotAdmin);

            if (isBotAdmin) {
                adminGroups.push({
                    jid: g.jid || g.id,
                    subject: g.subject || g.name || 'Unknown Group'
                });
            }
        }
        if (adminGroups.length > 0) {
            const wasEmpty = !cachedGroups.length;
            cachedGroups = adminGroups;
            cachedGroupsLastRefresh = Date.now();
            console.log(' [Cache] Refreshed ' + cachedGroups.length + ' admin groups');
            
            // Auto-heal empty database row: save discovered groups to Supabase in background
            if (wasEmpty && activeSessionPhone) {
                (async () => {
                    try {
                        console.log(' [Cache] Groups newly detected! Syncing back to Supabase to repair empty metadata...');
                        await refreshDiscoveredGroups(activeSessionPhone);
                    } catch (e) {
                        console.warn(' [Cache] Auto-heal sync failed:', e.message);
                    }
                })();
            }
        } else {
            console.log(' [Cache] Fetched 0 admin groups from socket (possibly syncing). Keeping existing cache.');
            if (!cachedGroups.length) {
                const meta = loadSessionMeta();
                // Intelligent fallback: find the phone session that contains the most groups
                let bestPhone = null;
                let maxGroups = 0;
                for (const [ph, data] of Object.entries(meta)) {
                    if (data?.discoveredGroups?.length > maxGroups) {
                        maxGroups = data.discoveredGroups.length;
                        bestPhone = ph;
                    }
                }
                const phone = bestPhone || activeSessionPhone || Object.keys(meta)[0];
                if (phone && meta[phone]?.discoveredGroups?.length) {
                    cachedGroups = meta[phone].discoveredGroups.map(g => ({ jid: g.jid, subject: g.subject }));
                    meta[phone].discoveredGroups.forEach(g => botAdminGroupCache.set(g.jid, true));
                    console.log(' [Cache] Restored ' + cachedGroups.length + ' admin groups from session metadata fallback (Source: ' + phone + ')');
                    
                    // Auto-heal new session: save these restored groups to Supabase in the background under activeBot JID
                    if (activeSessionPhone && activeSessionPhone !== phone) {
                        (async () => {
                            try {
                                console.log(' [Cache] Migrating groups from source +' + phone + ' to active session +' + activeSessionPhone + '...');
                                await refreshDiscoveredGroups(activeSessionPhone);
                            } catch (e) {
                                console.warn(' [Cache] Migration sync failed:', e.message);
                            }
                        })();
                    }
                }
            }
        }
    } catch (e) {
        if (e.message?.includes('Connection Closed') && cachedGroups.length) {
            console.warn(' [Cache] Connection closed, will retry on next cycle. Using ' + cachedGroups.length + ' cached groups.');
            return;
        }
        console.warn(' [Cache] Group refresh failed, using fallback:', e.message.substring(0, 80));
        if (!cachedGroups.length) {
            const meta = loadSessionMeta();
            let bestPhone = null;
            let maxGroups = 0;
            for (const [ph, data] of Object.entries(meta)) {
                if (data?.discoveredGroups?.length > maxGroups) {
                    maxGroups = data.discoveredGroups.length;
                    bestPhone = ph;
                }
            }
            const phone = bestPhone || activeSessionPhone || Object.keys(meta)[0];
            if (phone && meta[phone]?.discoveredGroups?.length) {
                cachedGroups = meta[phone].discoveredGroups.map(g => ({ jid: g.jid, subject: g.subject }));
                meta[phone].discoveredGroups.forEach(g => botAdminGroupCache.set(g.jid, true));
            }
        }
    }
};

const getBroadcastWhitelist = () => {
    const cfg = loadBroadcastConfig();
    return cfg.whitelist || [];
};
const setBroadcastWhitelist = (jids) => {
    saveBroadcastConfig({ whitelist: jids });
};
const isGroupWhitelisted = (jid) => {
    const wl = getBroadcastWhitelist();
    return !wl.length || wl.includes(jid);
};

const fetchLiveMonitoredGroups = async () => {
    if (!cachedGroups.length) await refreshGroupCache();
    const wl = getBroadcastWhitelist();
    if (!wl.length) return cachedGroups;
    return cachedGroups.filter(g => wl.includes(g.jid));
};

const handleGroupModeration = async (msg, jid, sender, senderPhone, isAdmin) => {
    if (!sender) return false;
    const textInput = handleGroupModerationExtractText(msg);
    const lowerText = textInput.toLowerCase();
    const isStatusMention = !!(msg.message?.groupStatusMentionMessage);
    try { fs.appendFileSync('_trace.log', 'MOD status=' + (msg.status || '?') + ' jid=' + jid + ' sender=' + senderPhone + ' isAdmin=' + isAdmin + ' text="' + textInput.substring(0, 80) + '" msgKeys=[' + (msg.message ? Object.keys(msg.message).join(',') : '') + ']\n'); } catch (e) { }
    const containsLink = lowerText.includes('http://') || lowerText.includes('https://') || lowerText.includes('wa.me/');
    const containsBadWord = BANNED_KEYWORDS.some(word => {
        if (word.includes(' ')) return lowerText.includes(word);
        const re = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
        return re.test(lowerText);
    });
    if (!containsLink && !containsBadWord && !isStatusMention) { try { fs.appendFileSync('_trace.log', 'MOD_SKIP no link+no badword\n'); } catch (e) { } return false; }
    let shouldAct = false;
    if (isStatusMention) { shouldAct = true; }
    else if (isAdmin) { shouldAct = containsBadWord; }
    else { shouldAct = containsBadWord || containsLink; }
    if (!shouldAct) { try { fs.appendFileSync('_trace.log', 'MOD_SKIP shouldAct=false isAdmin=' + isAdmin + ' link=' + containsLink + ' badword=' + containsBadWord + ' statusMention=' + isStatusMention + '\n'); } catch (e) { } return false; }
    try { fs.appendFileSync('_trace.log', 'MOD_ACT shouldAct=' + shouldAct + ' link=' + containsLink + ' badword=' + containsBadWord + ' statusMention=' + isStatusMention + '\n'); } catch (e) { }
    const humanDelay = 1000 + Math.floor(Math.random() * 2000);
    await delay(humanDelay);
    try {
        try { fs.appendFileSync('_trace.log', 'MOD_DELETE_ATTEMPT msgId=' + (msg.key.id || '?').substring(0, 20) + ' participant=' + (sender || '?').substring(0, 40) + '\n'); } catch (e) { }
        for (let d = 0; d < 3; d++) {
            try {
                const delRes = await client.sock.sendMessage(jid, { delete: msg.key });
                try { fs.appendFileSync('_trace.log', 'MOD_DELETE_OK attempt=' + d + ' resp=' + JSON.stringify(delRes).substring(0, 200) + '\n'); } catch (e) { }
                break;
            } catch (de) {
                try { fs.appendFileSync('_trace.log', 'MOD_DELETE_FAIL attempt=' + d + ' err=' + de.message.substring(0, 100) + '\n'); } catch (e) { }
                if (d === 2) throw de;
                await delay(2000);
            }
        }
        const alertText = isStatusMention
            ? '⚠️ @' + senderPhone + ' status mentions not allowed — deleted'
            : containsBadWord
                ? '@' + senderPhone + ' 🚫 inappropriate language — deleted'
                : '⚠️ @' + senderPhone + ' link sharing restricted — deleted';
        const mentionsList = [sender];
        if (senderPhone) {
            mentionsList.push(senderPhone + '@s.whatsapp.net');
        }
        await sendAntiBanMessage(jid, { text: alertText, options: { mentions: mentionsList } });
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
    let bestPhone = null;
    let maxGroups = 0;
    for (const [ph, data] of Object.entries(meta)) {
        if (data?.discoveredGroups?.length > maxGroups) {
            maxGroups = data.discoveredGroups.length;
            bestPhone = ph;
        }
    }
    const phone = bestPhone || activeSessionPhone || Object.keys(meta)[0];
    const groups = meta[phone]?.discoveredGroups || [];
    if (!groups.length) return;
    console.log(' [Group Scan] Scanning ' + groups.length + ' groups for old links…');
    for (const g of groups) {
        await delay(2000 + Math.floor(Math.random() * 3000));
        try {
            const msgsResponse = await client.fetchMessages(g.jid, 20);
            const msgs = msgsResponse?.messages?.records || msgsResponse?.records || (Array.isArray(msgsResponse) ? msgsResponse : []);
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
                        await client.sendDelete(g.jid, m.key.id, s);
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

// ==========================================
// 🔍 NICHE GROUP FINDER — auto-match users to niche groups via Gemini
// ==========================================
const NICHE_FINDER_SYSTEM_PROMPT = `You are a helpful academic and career advisor for TN Universities Connect. Your ONLY task is to match a student's field of study or interest to the MOST relevant niche groups from this list. You MUST respond with ONLY a JSON array of matching group names.

Available groups:
${OFFICIAL_NICHE_GROUPS.map((g, i) => (i + 1) + '. ' + g).join('\n')}

Rules:
- Match 1-3 most relevant groups based on the user's stated field or interest
- If unsure, pick the closest match and explain briefly
- Respond with ONLY valid JSON like: ["Group Name 1", "Group Name 2"]
- If the user says something unrelated or you cannot match, respond with: []`;

const handleNicheFinder = async (jid, senderPhone, textInput) => {
    if (!geminiClient) return false;
    const state = nicheFinderStates.get(senderPhone);
    if (!state) {
        nicheFinderStates.set(senderPhone, { step: 'AWAITING_FIELD' });
        await sendAntiBanMessage(jid, { text: '👋 Welcome! What do you study or what field are you interested in?\n\nTell me your course, profession, or interest and I\'ll match you to the right niche groups automatically.' });
        return true;
    }
    if (state.step === 'AWAITING_FIELD' || state.step === 'REMATCH') {
        try {
            const model = geminiClient.getGenerativeModel({ model: 'gemini-2.5-flash-lite', systemInstruction: NICHE_FINDER_SYSTEM_PROMPT });
            const result = await model.generateContent(textInput);
            const raw = result.response.text().trim();
            const jsonMatch = raw.match(/\[.*?\]/s);
            const matchedNames = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
            if (!matchedNames.length) {
                await sendAntiBanMessage(jid, { text: '🤔 I couldn\'t find a perfect match. Could you tell me more about what you study or do? (e.g., "I study nursing", "I\'m a graphic designer", "I love coding")' });
                nicheFinderStates.set(senderPhone, { step: 'REMATCH' });
                return true;
            }
            const matchedGroups = matchedNames.map(name => {
                const idx = OFFICIAL_NICHE_GROUPS.indexOf(name);
                if (idx === -1) return null;
                const allGroups = cachedGroups;
                return allGroups.find(g => g.subject.toLowerCase().includes(name.toLowerCase().substring(0, 15)));
            }).filter(Boolean);

            if (!matchedGroups.length) {
                await sendAntiBanMessage(jid, { text: '🤔 I found matching groups but couldn\'t locate their invite links. An admin will help you shortly.' });
                nicheFinderStates.delete(senderPhone);
                return true;
            }
            const groupLinks = matchedGroups.map(g => g.jid).join(', ');
            const groupNames = matchedGroups.map(g => '• ' + g.subject).join('\n');
            await sendAntiBanMessage(jid, { text: '📚 *Based on your interest, here are your recommended niche groups:*\n\n' + groupNames + '\n\nReply *yes* to join these groups, or *no* to try a different field.' });
            nicheFinderStates.set(senderPhone, { step: 'CONFIRM', matchedGroups });
            return true;
        } catch (e) {
            console.error(' [NicheFinder] Gemini error:', e.message);
            await sendAntiBanMessage(jid, { text: '⚠️ Sorry, I couldn\'t process that. Please try again or contact an admin.' });
            nicheFinderStates.delete(senderPhone);
            return true;
        }
    }
    if (state.step === 'CONFIRM') {
        const lower = textInput.trim().toLowerCase();
        if (lower === 'yes' || lower === 'yep' || lower === 'ok' || lower === 'sure') {
            const groups = state.matchedGroups;
            for (const g of groups) {
                try {
                    await client.addGroupParticipant(g.jid, [jid]);
                    console.log(' [NicheFinder] Auto-approved ' + senderPhone + ' into ' + g.subject);
                } catch (e) {
                    console.warn(' [NicheFinder] Failed to add to ' + g.subject + ':', e.message.substring(0, 80));
                }
                await delay(5000 + Math.floor(Math.random() * 5000));
            }
            await sendAntiBanMessage(jid, { text: '✅ *Done!* I\'ve added you to the groups above. Welcome to TN Universities Connect! 🎉\n\nIf you have any questions, feel free to ask an admin.' });
            nicheFinderStates.delete(senderPhone);
            return true;
        }
        if (lower === 'no' || lower === 'nope' || lower === 'try again') {
            nicheFinderStates.set(senderPhone, { step: 'AWAITING_FIELD' });
            await sendAntiBanMessage(jid, { text: 'No problem! Tell me your field of study or interest again:' });
            return true;
        }
        await sendAntiBanMessage(jid, { text: 'Reply *yes* to join or *no* to try a different field.' });
        return true;
    }
    return false;
};

// ==========================================
// 🤖 AI REPLY ASSISTANT — admin sends screenshot, bot suggests a reply
// ==========================================
const analyzeScreenshotWithProvider = async (buffer, mime, systemPrompt, userText, maxTokens) => {
    const b64 = buffer.toString('base64');
    if (groqClient) {
        try {
            const response = await groqClient.chat.completions.create({
                model: 'llama-3.2-11b-vision-preview',
                messages: [
                    { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
                    { role: 'user', content: [
                        { type: 'text', text: userText || 'Analyze this image.' },
                        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }
                    ]}
                ],
                max_tokens: maxTokens || 500,
            });
            const content = response.choices[0]?.message?.content;
            if (content) return content;
        } catch (e) {
            console.error(' [Vision] Groq failed (' + e.message.slice(0, 80) + '), falling back to Gemini');
        }
    }
    if (geminiClient) {
        const model = geminiClient.getGenerativeModel({ model: 'gemini-1.5-flash', systemInstruction: systemPrompt });
        const result = await model.generateContent([
            { text: userText || 'Analyze this image.' },
            { inlineData: { data: b64, mimeType: mime } }
        ]);
        return result.response.text();
    }
    return null;
};
const handleAdminReplyAssistant = async (jid, senderPhone, msg, adminName) => {
    if (!groqClient && !geminiClient) return false;
    const { text: msgText, hasImage } = extractIncomingPayload(msg);
    const lowerText = (msgText || '').trim().toLowerCase();
    const wantsHelp = lowerText === 'help' || lowerText.startsWith('help') || lowerText === 'ai' || lowerText.startsWith('ai ');
    const state = adminReplyStates.get(senderPhone);

    if (wantsHelp && !hasImage) {
        await sendAntiBanMessage(jid, { text: '🤖 *AI Reply Helper*\n\nSend a screenshot of the conversation and I\'ll suggest a professional reply for you.\n\nExample: Send "help" with a screenshot attached.\n\nAfter I suggest a reply, type *rewrite: [instruction]* to tweak it.' });
        return true;
    }

    if (hasImage && msg.key?.id) {
        try {
            const mediaResult = await client.getMediaBase64(msg);
            let b64 = mediaResult.base64 || '';
            if (b64.includes(',')) b64 = b64.split(',')[1];
            const buffer = Buffer.from(b64, 'base64');
            if (buffer.length < 100) {
                await sendAntiBanMessage(jid, { text: '⚠️ Could not download that image properly. Try sending again.' });
                return true;
            }
            const rawMime = msg.message?.imageMessage?.mimetype || msg.message?.documentMessage?.mimetype || 'image/jpeg';
            const header = buffer.slice(0, 4).toString('hex').toUpperCase();
            let detectedMime = rawMime;
            if (header.startsWith('FFD8')) detectedMime = 'image/jpeg';
            else if (header.startsWith('89504E47')) detectedMime = 'image/png';
            else if (header.startsWith('474946')) detectedMime = 'image/gif';
            else if (header.startsWith('524946') && buffer.slice(8, 12).toString() === 'WEBP') detectedMime = 'image/webp';
            console.log(' [ReplyAssistant] Image: ' + (buffer.length / 1024).toFixed(1) + 'KB, mime=' + detectedMime);
            
            const SYSTEM_PROMPT = 'You are a professional WhatsApp reply assistant for TN Universities Connect admins. You will be shown a screenshot of a conversation. Analyze it and suggest a professional, helpful reply the admin can send. Be concise and natural. Format your response as: **Suggested reply:** [your suggestion]';
            
            let userPrompt = (msgText || '').replace(/@\d+/g, '').replace(/^(?:bot|gatekeeper|super bot)\b/i, '').trim();
            userPrompt = userPrompt.replace(/@tn connect super bot\.\./gi, '')
                                   .replace(/@tn connect super bot/gi, '')
                                   .replace(/tn connect super bot/gi, '')
                                   .replace(/super bot/gi, '')
                                   .replace(/@\S+/g, '')
                                   .trim();

            if (!userPrompt || userPrompt.toLowerCase() === 'help' || userPrompt.toLowerCase() === 'ai') {
                userPrompt = 'Analyze this conversation screenshot and suggest a professional reply the admin can send.';
            } else {
                userPrompt = `Analyze this conversation screenshot and suggest a professional reply based on the admin's request: "${userPrompt}"`;
            }
            
            const suggestion = await analyzeScreenshotWithProvider(buffer, detectedMime, SYSTEM_PROMPT, userPrompt, 1000);
            if (!suggestion) throw new Error('No response from AI');
            adminReplyStates.set(senderPhone, { imageBuffer: buffer, mime: detectedMime, lastSuggestion: suggestion });
            await sendAntiBanMessage(jid, { text: suggestion + '\n\nType *rewrite: [instructions]* to tweak it, or just copy and send.' });
            return true;
        } catch (e) {
            const provider = groqClient ? 'Groq' : 'Gemini';
            console.error(' [ReplyAssistant] ' + provider + ' error:', e.message.substring(0, 120));
            await sendAntiBanMessage(jid, { text: '⚠️ Could not analyze that screenshot. Try sending as a regular photo (not view-once).' });
            return true;
        }
    }
    if (state && msgText && msgText.trim().toLowerCase().startsWith('rewrite:')) {
        const instruction = msgText.trim().slice('rewrite:'.length).trim();
        try {
            const SYSTEM_PROMPT = 'You are a professional reply assistant. The admin is asking you to revise a suggested reply. Rewrite it based on their instruction. Keep it natural and professional.';
            const revised = await analyzeScreenshotWithProvider(state.imageBuffer, state.mime, SYSTEM_PROMPT, 'Based on this conversation screenshot, revise the reply with this instruction: ' + instruction);
            if (!revised) throw new Error('No response from AI');
            adminReplyStates.set(senderPhone, { ...state, lastSuggestion: revised });
            await sendAntiBanMessage(jid, { text: revised + '\n\nType *rewrite: [instructions]* to tweak further, or just copy and send.' });
            return true;
        } catch (e) {
            console.error(' [ReplyAssistant] Rewrite failed:', e.message);
            await sendAntiBanMessage(jid, { text: '⚠️ Could not rewrite. Please try again.' });
            return true;
        }
    }
    return false;
};

const adminChatHistories = new Map(); // senderPhone -> Array of messages

const callAIChat = async (senderPhone, userText, adminName) => {
    if (!groqClient && !geminiClient) return null;
    if (!adminChatHistories.has(senderPhone)) {
        adminChatHistories.set(senderPhone, []);
    }
    const history = adminChatHistories.get(senderPhone);
    if (history.length > 10) history.shift();

    const systemPrompt = `You are the "TN Connect Super Bot", an ultra-smart, helpful, and friendly AI administrator assistant for TN Universities Connect.
You are an expert in all fields of the world (including technology, business, cybersecurity, operations, marketing, and copywriting).
Your personality is friendly, Gen Z, highly expert, tech-savvy, and warm.
If you are asked about security, respond as an elite cyber security expert. If asked about technology or business, respond as a tech guru or business tycoon.

CRITICAL IDENTITY RULES:
- You were created and developed solely by Elliot Paakow Entsiwah, also known as Kingenious.
- You MUST ONLY mention Elliot Paakow Entsiwah (Kingenious) as your creator/developer IF AND ONLY IF you are explicitly asked who created you, who made you, who developed you, or similar questions about your origin.
- NEVER brag about or randomly mention Elliot Paakow Entsiwah (Kingenious) in normal conversation or casual chitchat when nobody asked about your origin. Keep it natural!

CRITICAL FORMATTING RULES:
- Do NOT use markdown bold/italic tags (like "**" or "*") in your response. Keep the text layout completely clean with standard characters and normal spacing. Do not output any asterisks!
- Use emojis naturally to keep it friendly and engaging, but do NOT spam them in every single sentence. Use them where it makes sense.
- Keep your responses relatively concise (usually 1-3 paragraphs) and professional.
An admin named "${adminName}" is talking to you.`;

    history.push({ role: 'user', content: userText });

    if (groqClient) {
        try {
            const messages = [{ role: 'system', content: systemPrompt }, ...history];
            const response = await groqClient.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages,
                max_tokens: 800,
            });
            const content = response.choices[0]?.message?.content;
            if (content) {
                history.push({ role: 'assistant', content });
                return content;
            }
        } catch (e) {
            console.warn(' [AIChat] Groq 70B failed or rate-limited, trying Groq 8B:', e.message.substring(0, 100));
            try {
                const messages = [{ role: 'system', content: systemPrompt }, ...history];
                const response = await groqClient.chat.completions.create({
                    model: 'llama-3.1-8b-instant',
                    messages,
                    max_tokens: 800,
                });
                const content = response.choices[0]?.message?.content;
                if (content) {
                    history.push({ role: 'assistant', content });
                    return content;
                }
            } catch (e2) {
                console.error(' [AIChat] Groq 8B fallback failed:', e2.message.substring(0, 100));
            }
        }
    }
    if (geminiClient) {
        try {
            const model = geminiClient.getGenerativeModel({ model: 'gemini-1.5-flash', systemInstruction: systemPrompt });
            const contents = history.map(h => ({
                role: h.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: h.content }]
            }));
            const result = await model.generateContent({ contents });
            const content = result.response.text();
            if (content) {
                history.push({ role: 'assistant', content });
                return content;
            }
        } catch (e) {
            console.error(' [AIChat] Gemini fallback failed:', e.message);
        }
    }
    return null;
};

const loadBroadcastConfig = () => {
    if (!fs.existsSync(BROADCAST_CONFIG_FILE)) return { whitelist: [] };
    try { return JSON.parse(fs.readFileSync(BROADCAST_CONFIG_FILE, 'utf-8')); }
    catch { return { whitelist: [] }; }
};
const saveBroadcastConfig = (cfg) => {
    try { fs.writeFileSync(BROADCAST_CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
    catch (e) { console.error(' [Broadcast] Failed to save config:', e.message); }
    if (supabase) {
        try {
            supabase.from('gatekeeper_sessions').upsert({
                phone: '_config_broadcast_whitelist',
                admin_name: 'config',
                selected_groups: [],
                discovered_groups: cfg.whitelist || [],
                files: [],
                updated_at: new Date().toISOString()
            });
        } catch (_) {}
    }
};
const loadBroadcastWhitelistFromSupabase = async () => {
    if (!supabase) return;
    try {
        const { data } = await supabase.from('gatekeeper_sessions').select('discovered_groups').eq('phone', '_config_broadcast_whitelist').single();
        if (data?.discovered_groups?.length) {
            saveBroadcastConfig({ whitelist: data.discovered_groups });
            console.log(' [Broadcast] Loaded ' + data.discovered_groups.length + ' whitelisted groups from Supabase');
        } else {
            console.log(' [Broadcast] No whitelist found in Supabase — will create after first manage');
        }
    } catch (e) {
        if (e.code === 'PGRST116') {
            console.log(' [Broadcast] No whitelist row in Supabase yet — will create after first manage');
        } else {
            console.warn(' [Broadcast] Failed to load whitelist from Supabase:', e.message?.substring(0, 80));
        }
    }
};

const restoreSessionMetaFromSupabase = async () => {
    if (!supabase) return;
    try {
        const { data, error } = await supabase.from('gatekeeper_sessions').select('*').neq('phone', '_config_broadcast_whitelist');
        if (error) { console.warn(' [Meta] Supabase restore error:', error.message?.substring(0, 80)); return; }
        if (!data?.length) { console.log(' [Meta] No session data in Supabase to restore'); return; }
        const meta = loadSessionMeta();
        let restoredCount = 0;
        for (const row of data) {
            const phone = String(row.phone).replace(/\D/g, '');
            if (!phone) continue;
            meta[phone] = {
                ...(meta[phone] || {}),
                adminName: row.admin_name || meta[phone]?.adminName || 'TN Connect Assistant',
                discoveredGroups: row.discovered_groups || meta[phone]?.discoveredGroups || [],
                selectedGroups: row.selected_groups || meta[phone]?.selectedGroups || [],
                updatedAt: row.updated_at || new Date().toISOString()
            };
            if (row.role === 'core_gatekeeper_bot' || phone === activeSessionPhone) {
                (row.discovered_groups || []).forEach(g => botAdminGroupCache.set(g.jid || g.id, true));
            }
            restoredCount++;
        }
        saveSessionMeta(meta);
        console.log(' [Meta] Restored ' + restoredCount + ' admin session(s) from Supabase');
    } catch (e) {
        console.warn(' [Meta] Failed to restore session data:', e.message?.substring(0, 80));
    }
};

// ==========================================
// 🔒 GROUP LOCK/UNLOCK — admins toggle group to messages-admins-only
// ==========================================
const loadLockedGroups = () => {
    if (!fs.existsSync(LOCKED_GROUPS_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(LOCKED_GROUPS_FILE, 'utf-8')); }
    catch { return []; }
};
const saveLockedGroups = (jids) => {
    try { fs.writeFileSync(LOCKED_GROUPS_FILE, JSON.stringify(jids, null, 2)); }
    catch (e) { console.error(' [Lock] Failed to save:', e.message); }
};

const LOCKED_GROUPS_DESC = 'locked_groups';

const isGroupLockIntent = (lowerText) => {
    const word = lowerText.trim().split(/\s+/)[0].toLowerCase();
    return word === 'lock' || word === 'unlock' || word === 'locks' || word === 'unlocks';
};

const handleGroupLockDM = async (jid, senderPhone, textInput, adminProfile) => {
    const lower = (textInput || '').trim().toLowerCase();
    if (lower === 'cancel' || lower === 'abort' || lower === 'stop') {
        groupLockStates.delete(senderPhone);
        await sendAntiBanMessage(jid, { text: '🚫 Lock/unlock cancelled.' });
        return true;
    }
    const firstWord = lower.split(/\s+/)[0];
    const isLock = firstWord === 'lock' || firstWord === 'locks';
    const state = groupLockStates.get(senderPhone);
    const allGroups = cachedGroups.length ? cachedGroups : await fetchLiveMonitoredGroups();
    if (!allGroups.length) {
        await sendAntiBanMessage(jid, { text: '❌ No groups available.' });
        groupLockStates.delete(senderPhone);
        return true;
    }
    if (!state) {
        const locked = loadLockedGroups();
        const lines = allGroups.map((g, i) => {
            const isLocked = locked.includes(g.jid);
            return (i + 1) + '. ' + (g.subject || 'Unknown') + (isLocked ? ' 🔒' : '');
        });
        const action = isLock ? 'lock' : 'unlock';
        groupLockStates.set(senderPhone, { step: 'choose_groups', action, groupJids: allGroups.map(g => g.jid), groupSubjects: allGroups.map(g => g.subject || 'Unknown') });
        await sendAntiBanMessage(jid, {
            text: '📋 *Groups to ' + action + '* (reply with numbers like "1,3" or "all"):\n\n' + lines.join('\n')
        });
        return true;
    }
    if (state.step === 'choose_groups') {
        const locked = loadLockedGroups();
        let selectedJids = [];
        if (lower === 'all') {
            selectedJids = state.groupJids;
        } else {
            const indices = lower.split(/[,\s]+/).map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n > 0 && n <= state.groupJids.length);
            if (!indices.length) {
                await sendAntiBanMessage(jid, { text: '❌ No valid numbers. Try again or type *cancel*.' });
                return true;
            }
            selectedJids = indices.map(i => state.groupJids[i - 1]);
        }
        if (state.action === 'lock') {
            const newLocked = [...new Set([...locked, ...selectedJids])];
            saveLockedGroups(newLocked);
            const results = [];
            for (let i = 0; i < selectedJids.length; i++) {
                const gjid = selectedJids[i];
                try {
                    await client.setGroupAdminsOnly(gjid, true);
                    results.push('✅ ' + (state.groupSubjects[state.groupJids.indexOf(gjid)] || gjid) + ' → Locked (only admins)');
                } catch (e) {
                    results.push('❌ ' + (state.groupSubjects[state.groupJids.indexOf(gjid)] || gjid) + ' → ' + e.message.substring(0, 60));
                }
                if (i < selectedJids.length - 1) await delay(20000 + Math.floor(Math.random() * 20000));
            }
            await sendAntiBanMessage(jid, { text: results.join('\n') });
        } else {
            const newLocked = locked.filter(j => !selectedJids.includes(j));
            saveLockedGroups(newLocked);
            const results = [];
            for (let i = 0; i < selectedJids.length; i++) {
                const gjid = selectedJids[i];
                try {
                    await client.setGroupAdminsOnly(gjid, false);
                    results.push('✅ ' + (state.groupSubjects[state.groupJids.indexOf(gjid)] || gjid) + ' → Unlocked (everyone can message)');
                } catch (e) {
                    results.push('❌ ' + (state.groupSubjects[state.groupJids.indexOf(gjid)] || gjid) + ' → ' + e.message.substring(0, 60));
                }
                if (i < selectedJids.length - 1) await delay(20000 + Math.floor(Math.random() * 20000));
            }
            await sendAntiBanMessage(jid, { text: results.join('\n') });
        }
        groupLockStates.delete(senderPhone);
        return true;
    }
    return true;
};

const handleAdminBroadcastDM = async (jid, senderPhone, textInput, adminProfile, rawSender, originalMsg) => {
    console.log(' [Broadcast] ' + (jid.endsWith('@g.us') ? 'Group' : 'DM') + ' from ' + senderPhone + ': "' + (textInput || '').substring(0, 60) + '" state=' + (adminBroadcastStates.has(senderPhone) ? adminBroadcastStates.get(senderPhone).step : 'none'));
    const lower = (textInput || '').trim().toLowerCase();
    if (lower === 'cancel' || lower === 'abort' || lower === 'stop') {
        adminBroadcastStates.delete(senderPhone);
        adminRegistrationStates.delete(senderPhone);
        await sendAntiBanMessage(jid, { text: '🚫 Broadcast cancelled.' });
        return true;
    }
    const firstWord = (textInput || '').trim().split(/\s+/)[0].toLowerCase();
    if (firstWord === 'broadcast' || firstWord === 'send' || firstWord === 'announce') {
        const secondWord = (textInput || '').trim().split(/\s+/)[1];
        if (secondWord === 'reset' || secondWord === 'all') {
            const allGroups = cachedGroups.length ? cachedGroups : await fetchLiveMonitoredGroups();
            if (!allGroups.length) {
                await sendAntiBanMessage(jid, { text: '❌ No groups found.' });
                return true;
            }
            setBroadcastWhitelist(allGroups.map(g => g.jid));
            await sendAntiBanMessage(jid, { text: '✅ Whitelist reset — all ' + allGroups.length + ' groups are now available for broadcast. Use *broadcast manage* to remove specific ones.' });
            return true;
        }
        if (secondWord === 'manage' || secondWord === 'setup' || secondWord === 'whitelist' || secondWord === 'list') {
            const allGroups = cachedGroups.length ? cachedGroups : await fetchLiveMonitoredGroups();
            if (!allGroups.length) {
                await sendAntiBanMessage(jid, { text: '❌ No groups found.' });
                return true;
            }
            let wl = getBroadcastWhitelist();
            if (!wl.length) {
                // Auto-populate whitelist with all groups so user can remove the ones they don't want
                wl = allGroups.map(g => g.jid);
                setBroadcastWhitelist(wl);
            }
            adminBroadcastStates.set(senderPhone, {
                step: 'MANAGING_GROUPS',
                groups: allGroups,
                selected: [],
                adminName: adminProfile?.name || 'Admin'
            });
            const list = allGroups.map((g, i) => (i + 1) + '. ' + (wl.includes(g.jid) ? '✓ ' : '  ') + g.subject).join('\n');
            await sendAntiBanMessage(jid, { text: '📋 *Broadcast Group Manager*\n\nReply with numbers to REMOVE groups from broadcast (e.g., "1,3,5").\nType *done* when finished. Type *cancel* to abort.\n\n' + list });
            return true;
        }
        const groups = await fetchLiveMonitoredGroups();
        if (!groups.length) {
            const wl = getBroadcastWhitelist();
            if (wl.length) {
                await sendAntiBanMessage(jid, { text: '❌ None of your whitelisted groups are in the cache yet. Try *broadcast manage* to check or wait for cache refresh.' });
                return true;
            }
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
        await sendAntiBanMessage(jid, { text: '📢 *Broadcast Wizard*\n\nSelect groups by replying with numbers (e.g., "1,3,5") or "all" for all groups.\nType *broadcast manage* to control which groups appear here. Type *cancel* to abort:\n\n' + list });
        return true;
    }
    const state = adminBroadcastStates.get(senderPhone);
    if (!state) return false;
    if (state.step === 'MANAGING_GROUPS') {
        const hasDone = lower === 'done' || lower === 'finish' || lower === 'save' || lower.endsWith('\ndone') || lower.endsWith('\nfinish');
        const effectiveInput = hasDone ? lower.replace(/\n?(?:done|finish)$/, '').trim() : lower;
        if (hasDone && !effectiveInput) {
            adminBroadcastStates.delete(senderPhone);
            await sendAntiBanMessage(jid, { text: '✅ Whitelist saved with ' + getBroadcastWhitelist().length + ' groups. Next time you type *broadcast*, only these will show.' });
            return true;
        }
        const wl = getBroadcastWhitelist();
        if (effectiveInput === 'all') {
            setBroadcastWhitelist(state.groups.map(g => g.jid));
            if (hasDone) {
                adminBroadcastStates.delete(senderPhone);
                await sendAntiBanMessage(jid, { text: '✅ All groups whitelisted (' + state.groups.length + '). Next time you type *broadcast*, all will show.' });
            } else {
                const list = state.groups.map((g, i) => (i + 1) + '. ✓ ' + g.subject).join('\n');
                await sendAntiBanMessage(jid, { text: '✅ All groups whitelisted. Reply with numbers to REMOVE specific groups, or *done* to finish.\n\n' + list });
            }
            return true;
        }
        const indices = effectiveInput.replace(/\./g, ',').split(',').map(s => parseInt(s.trim()) - 1).filter(i => i >= 0 && i < state.groups.length);
        if (!indices.length) {
            await sendAntiBanMessage(jid, { text: '❌ No valid group numbers. Reply with numbers to REMOVE from whitelist (e.g., "1,3,5") or *done* to finish.' });
            return true;
        }
        for (const idx of indices) {
            const g = state.groups[idx];
            if (wl.includes(g.jid)) wl.splice(wl.indexOf(g.jid), 1);
        }
        setBroadcastWhitelist(wl);
        if (hasDone) {
            adminBroadcastStates.delete(senderPhone);
            await sendAntiBanMessage(jid, { text: '✅ Whitelist saved with ' + wl.length + ' groups. Next time you type *broadcast*, only these will show.' });
        } else {
            const list = state.groups.map((g, i) => (i + 1) + '. ' + (wl.includes(g.jid) ? '✓ ' : '  ') + g.subject).join('\n');
            await sendAntiBanMessage(jid, { text: '✅ Removed ' + indices.length + ' group(s) from broadcast. Current whitelist: ' + wl.length + ' groups.\n\nReply with more numbers to REMOVE, or *done* to finish.\n\n' + list });
        }
        return true;
    }
    if (state.step === 'CHOOSING_GROUPS') {
        if (lower === 'all') {
            state.selected = state.groups;
        } else {
const indices = lower.replace(/\./g, ',').split(',').map(s => parseInt(s.trim()) - 1).filter(i => i >= 0 && i < state.groups.length);
        if (!indices.length) {
            await sendAntiBanMessage(jid, { text: '❌ No valid group numbers found. Try again (e.g., "1,3,5" or "all").' });
            return true;
        }
        state.selected = indices.map(i => state.groups[i]);
        }
        state.step = 'CAPTURING_RAW_BODY';
        const groupNames = state.selected.map(g => '• ' + g.subject).join('\n');
        await sendAntiBanMessage(jid, { text: '✅ ' + state.selected.length + ' group(s) selected:\n' + groupNames + '\n\nNow send the broadcast message. (Type *cancel* to abort.)' });
        return true;
    }
    if (state.step === 'CAPTURING_RAW_BODY') {
        const content = originalMsg?.message;
        const mediaType = content ? Object.keys(content).find(k => ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(k)) : null;
        const broadcastText = (textInput || '').trim();
        
        if (!broadcastText && !mediaType) {
            await sendAntiBanMessage(jid, { text: '❌ Message cannot be empty. Send the text, image, video, or audio you want to broadcast.' });
            return true;
        }

        let mediaBuffer = null;
        if (mediaType) {
            await sendAntiBanMessage(jid, { text: '📥 Processing and downloading media file...' });
            try {
                mediaBuffer = await downloadMediaMessage(
                    originalMsg,
                    'buffer',
                    {},
                    {
                        logger: P({ level: 'silent' }),
                        reuploadRequest: client.sock.updateMediaMessage
                    }
                );
            } catch (err) {
                console.error(' [Broadcast] Download failed:', err.message);
                await sendAntiBanMessage(jid, { text: '❌ Failed to download your media file. Please try again.' });
                return true;
            }
            if (!mediaBuffer) {
                await sendAntiBanMessage(jid, { text: '❌ Failed to download your media file. Please try again.' });
                return true;
            }
        }

        const adminPhone = formatPhoneNumberGH(senderPhone);
        const signature = '\n\n— ' + (state.adminName || 'Admin') + ', Admin\n' + adminPhone;

        const summaryText = mediaType 
            ? `a ${mediaType.replace('Message', '')} file` + (broadcastText ? ` with caption "${broadcastText.substring(0, 50)}..."` : '')
            : `"${broadcastText.substring(0, 100)}${broadcastText.length > 100 ? '...' : ''}"`;
        await sendAntiBanMessage(jid, { text: '📤 Sending broadcast to ' + state.selected.length + ' group(s)...\n\nSending: ' + summaryText });

        let sent = 0;
        let failed = 0;
        for (const group of state.selected) {
            console.log(' [Broadcast] Sending to ' + group.subject + ' (' + group.jid + ')');
            try {
                if (mediaType) {
                    const mediaObj = content[mediaType];
                    if (mediaType === 'imageMessage') {
                        const originalCaption = mediaObj.caption || '';
                        const caption = (originalCaption + signature).trim();
                        await client.sock.sendMessage(group.jid, { image: mediaBuffer, caption, mimetype: mediaObj.mimetype || 'image/jpeg' });
                    }
                    else if (mediaType === 'videoMessage') {
                        const originalCaption = mediaObj.caption || '';
                        const caption = (originalCaption + signature).trim();
                        await client.sock.sendMessage(group.jid, { video: mediaBuffer, caption, mimetype: mediaObj.mimetype || 'video/mp4' });
                    }
                    else if (mediaType === 'documentMessage') {
                        const originalCaption = mediaObj.caption || '';
                        const caption = (originalCaption + signature).trim();
                        await client.sock.sendMessage(group.jid, { document: mediaBuffer, caption, mimetype: mediaObj.mimetype || 'application/octet-stream', fileName: mediaObj.fileName || 'file' });
                    }
                    else if (mediaType === 'audioMessage') {
                        await client.sock.sendMessage(group.jid, { audio: mediaBuffer, mimetype: mediaObj.mimetype || 'audio/mp4', ptt: !!mediaObj.ptt });
                        await sendAntiBanMessage(group.jid, { text: signature.trim() });
                    }
                    else if (mediaType === 'stickerMessage') {
                        await client.sock.sendMessage(group.jid, { sticker: mediaBuffer });
                        await sendAntiBanMessage(group.jid, { text: signature.trim() });
                    }
                } else {
                    const msgText = broadcastText + signature;
                    await sendAntiBanMessage(group.jid, { text: msgText });
                }
                console.log(' [Broadcast] Sent OK to ' + group.subject);
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
// 👤 ADMIN SELF-REGISTRATION via WhatsApp DM
// ==========================================
const adminRegistrationStates = new Map(); // senderPhone -> { step: 'AWAITING_NAME', name?: ... }
const nicheFinderStates = new Map(); // phone -> { step, matchedGroups, ... }
const adminReplyStates = new Map(); // phone -> { imageBuffer, mime, lastSuggestion, ... }

const handleAdminRegistration = async (jid, senderPhone, textInput) => {
    const lower = (textInput || '').trim().toLowerCase();
    const state = adminRegistrationStates.get(senderPhone);

    // start registration
    if (!state && (lower === 'register' || lower === 'admin' || lower === 'signup')) {
        const existing = CAMPUS_ADMIN_ROSTER.find(a => a.phone === senderPhone) || registeredAdmins.get(senderPhone) || (await (async () => {
            if (supabase) try {
                const { data } = await supabase.from('gatekeeper_sessions').select('phone, admin_name').eq('phone', senderPhone).maybeSingle();
                if (data) return data;
            } catch (e) {}
            return null;
        })());
        if (existing) {
            const existingName = existing.admin_name || existing.name || 'Admin';
            await sendAntiBanMessage(jid, { text: '✅ You\'re already registered as *' + existingName + '*. No need to register again.' });
            return true;
        }
        adminRegistrationStates.set(senderPhone, { step: 'AWAITING_NAME' });
        await sendAntiBanMessage(jid, { text: '👤 *Admin Registration*\n\nReply with your full name to register as an admin.\n(Type *cancel* to abort.)' });
        return true;
    }
    if (!state) return false;

    // cancel
    if (lower === 'cancel' || lower === 'stop') {
        adminRegistrationStates.delete(senderPhone);
        await sendAntiBanMessage(jid, { text: '❌ Registration cancelled.' });
        return true;
    }

    if (state.step === 'AWAITING_NAME') {
        const name = textInput.trim();
        if (name.length < 2) {
            await sendAntiBanMessage(jid, { text: '❌ Name must be at least 2 characters. Try again or type *cancel*.' });
            return true;
        }
        // store locally
        registeredAdmins.set(senderPhone, { name, registeredAt: new Date().toISOString() });
        const localData = loadRegisteredAdmins();
        localData[senderPhone] = { name, registeredAt: new Date().toISOString() };
        saveRegisteredAdmins(localData);
        // also try Supabase
        if (supabase) {
            try {
                await supabase.from('gatekeeper_sessions').upsert({
                    phone: senderPhone, admin_name: name, role: 'admin_node', updated_at: new Date().toISOString()
                });
            } catch (e) { console.warn(' [Admin] Supabase save failed (non-blocking):', e.message); }
        }
        adminRegistrationStates.delete(senderPhone);
        await sendAntiBanMessage(jid, { text: '✅ *Registration successful!*\n\nYou are now a registered admin. Use these commands:\n• *broadcast* — Send a message to all monitored groups\n• *send* — Same as broadcast\n• *announce* — Same as broadcast' });
        return true;
    }
    return false;
};

// ==========================================
// 📨 INCOMING MESSAGE HANDLER — called by Baileys events
// Messages arrive in native WhatsApp protobuf format (same as Baileys sends)

// ==========================================
// 📨 BAILEYS EVENT WIRING — called during boot
// ==========================================
function wireBaileysEvents() {
    // Incoming messages
    client.onMessage = async (msg) => {
        try { await processIncomingMessage(msg); }
        catch (e) { console.error(' [Events] Error processing message:', e.message); }
    };

    // Group participants changed
    client.onParticipantsChanged = async (update) => {
        const { id: groupJid, participants, action } = update;

        // Track bot admin changes dynamically
        if ((action === 'promote' || action === 'demote') && groupJid && participants?.length) {
            const affectedMe = participants.find(p => isJidMe(p));
            if (affectedMe) {
                const isNowAdmin = action === 'promote';
                botAdminGroupCache.set(groupJid, isNowAdmin);
                console.log(` [AdminStatus] Bot was ${action}d in group ${groupJid}. isBotAdmin = ${isNowAdmin}`);
                if (activeSessionPhone) {
                    (async () => {
                        try { await refreshDiscoveredGroups(activeSessionPhone); } catch (e) {}
                    })();
                }
            }
        }
    };

    // Group join requests (membership approval queue)
    client.onJoinRequest = async (update) => {
        const { id: groupJid, participant: participantJid, action } = update;
        if (action === 'created' && groupJid && participantJid) {
            console.log(` [Events] Join request created in group ${groupJid} from ${participantJid}`);
            await processJoinRequest(groupJid, participantJid, 'created', '');
        }
    };

    // Connection state
    client.onConnectionUpdate = async ({ connected, error, shouldReconnect }) => {
        if (connected) {
            console.log(' [Baileys] Connected!');
            startPresenceCycling();
            if (!activeSessionPhone && client.phoneNumber) {
                activeSessionPhone = client.phoneNumber.replace(/[^0-9]/g, '').substring(0, 12);
                startupTime = Date.now();
                const mem = process.memoryUsage();
                console.log(' [Boot] Active session: ' + activeSessionPhone + ' | RSS: ' + (mem.rss / 1024 / 1024).toFixed(1) + 'MB | Heap: ' + (mem.heapUsed / 1024 / 1024).toFixed(1) + 'MB');
                await detectAdminAlertsGroup();
                await delay(5000);
                await populateLidMap();
                await delay(5000);
                await refreshDiscoveredGroups(activeSessionPhone);
                await delay(5000);
                await scanPendingJoinRequests();
                const remainingSilence = Math.max(0, RATE_LIMIT_COOLDOWN_MS - (Date.now() - startupTime));
                if (remainingSilence > 0) {
                    const mins = Math.round(remainingSilence / 60000);
                    console.log(' [Boot] Rate-limit cooldown: ' + mins + ' min ' + Math.round((remainingSilence % 60000) / 1000) + 's of silence…');
                    await delay(remainingSilence);
                }
                refreshGroupCache();
                loadBroadcastWhitelistFromSupabase();
                schedulePeriodicTasks();
            }
        } else if (error) {
            console.warn(' [Baileys] Disconnected: ' + (error.message || 'unknown') + ' | Reconnect: ' + shouldReconnect);
            
            const code = error?.output?.statusCode;
            const isLogout = code === 401 || code === 403 || error?.message?.includes('loggedOut') || error?.message?.includes('401') || error?.message?.includes('QR refs attempts ended');
            
            if (isLogout) {
                console.log(' [Auth] Expired, invalid, or logged-out session detected. Wiping credentials...');
                const phone = activeSessionPhone || getBotAdminContext().phone;
                try {
                    if (phone) {
                        const dirPath = path.join(__dirname, 'auth_session_' + phone);
                        if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
                        if (supabase) {
                            await supabase.from('gatekeeper_sessions').delete().eq('phone', phone);
                        }
                    }
                    const authPath = path.join(AUTH_FOLDER, 'creds.json');
                    if (fs.existsSync(authPath)) fs.rmSync(authPath, { force: true });
                    if (supabase) {
                        await supabase.from('bot_auth').delete().eq('id', 'creds');
                    }
                    console.log(' [Auth] Wiped credentials from local disk and Supabase.');
                } catch (clearErr) {
                    console.error(' [Auth] Failed to clear credentials:', clearErr.message);
                }
                
                // Force a fresh reconnect to display a new active QR code
                console.log(' [Auth] Restarting socket connection in 5 seconds...');
                setTimeout(() => {
                    if (client && typeof client.init === 'function') {
                        client.init().catch(() => {});
                    }
                }, 5000);
            }
        }
    };

    // QR code
    client.onQR = (qr) => {
        const path = require('path');
        const qrPath = path.join(__dirname, 'public', 'qrcode.png');
        if (qr) {
            const b64 = qr.replace(/^data:image\/png;base64,/, '');
            try {
                fs.writeFileSync(qrPath, Buffer.from(b64, 'base64'));
                console.log(' [QR] New QR code saved to public/qrcode.png');
            } catch (e) { /* ignore */ }
            console.log(' [QR] Scan the QR code with your WhatsApp (Linked Devices)');
        }
    };
}

function schedulePeriodicTasks() {
    // Memory monitoring
    setInterval(() => {
        const m = process.memoryUsage();
        console.log(' [Memory] RSS: ' + (m.rss / 1024 / 1024).toFixed(1) + 'MB | Heap: ' + (m.heapUsed / 1024 / 1024).toFixed(1) + 'MB');
    }, 60000);

    // Group cache refresh
    setInterval(() => refreshGroupCache(), 10 * 60 * 1000);

    // Health check
    setInterval(async () => {
        try {
            const st = await client.fetchInstanceStatus();
            const s = typeof st === 'object' ? (st.status || '').toLowerCase() : '';
            if (s !== 'islogged' && s !== 'open' && s !== 'connected') {
                console.log(' [Health] Session state: "' + (s || 'unknown') + '"');
            }
        } catch (e) { /* ignore */ }
    }, 5 * 60 * 1000);

    // Retry queued failed approvals (join-request approve)
    setInterval(async () => {
        if (!pendingApprovals.size) return;
        const now = Date.now();
        for (const [key, q] of pendingApprovals) {
            if (now - q.time < 120000 || q.attempts >= 5) continue;
            q.attempts++;
            q.time = now;
            // Human-paced delay between retries (3s – 30s)
            await delay(3000 + Math.floor(Math.random() * 27000));
            try {
                const rawJid = q.rawJid || q.jid;
                await client.approveGroupJoinRequest(q.groupJid, rawJid);
                console.log(' [Auto-Approval] Retry succeeded for ' + q.jid + ' into ' + (q.groupSubject || q.groupJid));
                pendingApprovals.delete(key);
                await sendAdminAlert([
                    '✅ *[AUTO-APPROVED — RETRY]*', '',
                    '📱 *Member:* ' + q.jid.replace('@s.whatsapp.net', ''),
                    '🌐 *Group:* ' + (q.groupSubject || q.groupJid)
                ].join('\n'));
            } catch (e) {
                if (!e.message?.includes('Connection Closed') && !e.message?.includes('timeout')) {
                    console.log(' [Auto-Approval] Retry failed permanently for ' + q.jid + ': ' + e.message.slice(0, 80));
                    pendingApprovals.delete(key);
                }
            }
        }
    }, 120000);

    // Full periodic refresh
    setInterval(async () => {
        console.log(' [Timer] Periodic group refresh…');
        await detectAdminAlertsGroup();
        await delay(5000);
        await populateLidMap();
        await delay(5000);
        await refreshDiscoveredGroups(activeSessionPhone);
    }, 30 * 60 * 1000);
}

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

const handleNaturalLanguageCommand = async (jid, senderPhone, textInput, adminProfile, originalMsg) => {
    if (!adminProfile) return false;
    let cleanText = (textInput || '').trim();
    
    // Strip bot mention if present
    cleanText = cleanText.replace(/@\d+/g, '').trim();
    // Strip common bot name starters
    cleanText = cleanText.replace(/^(?:bot|gatekeeper|super bot)\b/i, '').trim();
    cleanText = cleanText.replace(/@tn connect super bot\.\./gi, '')
                         .replace(/@tn connect super bot/gi, '')
                         .replace(/tn connect super bot/gi, '')
                         .replace(/super bot/gi, '')
                         .replace(/@\S+/g, '')
                         .trim();
                         
    if (!cleanText) return false;
    
    const lower = cleanText.toLowerCase();
    
    // 1. Lock all groups
    if (lower === 'lock all groups' || lower === 'lock all the groups' || lower === 'lock all group') {
        const allGroups = cachedGroups.length ? cachedGroups : await fetchLiveMonitoredGroups();
        if (!allGroups.length) {
            await sendAntiBanMessage(jid, { text: '❌ No monitored groups available.' });
            return true;
        }
        await sendAntiBanMessage(jid, { text: '🔒 *Locking all groups...*\nExecuting now with a safe, humanized delay (10-30 seconds between groups).' });
        
        const locked = loadLockedGroups();
        const newLocked = [...new Set([...locked, ...allGroups.map(g => g.jid)])];
        saveLockedGroups(newLocked);
        
        const results = [];
        for (let i = 0; i < allGroups.length; i++) {
            const g = allGroups[i];
            try {
                await client.setGroupAdminsOnly(g.jid, true);
                results.push('✅ ' + g.subject + ' → Locked');
            } catch (e) {
                results.push('❌ ' + g.subject + ' → ' + e.message.substring(0, 60));
            }
            if (i < allGroups.length - 1) {
                // Humanized delay: 10 to 30 seconds
                const delayMs = 10000 + Math.floor(Math.random() * 15000);
                await delay(delayMs);
            }
        }
        await sendAntiBanMessage(jid, { text: results.join('\n') + '\n\ncompleted lock all groups' });
        return true;
    }
    
    // 2. Unlock all groups
    if (lower === 'unlock all groups' || lower === 'unlock all the groups' || lower === 'unlock all group') {
        const allGroups = cachedGroups.length ? cachedGroups : await fetchLiveMonitoredGroups();
        if (!allGroups.length) {
            await sendAntiBanMessage(jid, { text: '❌ No monitored groups available.' });
            return true;
        }
        await sendAntiBanMessage(jid, { text: '🔓 *Unlocking all groups...*\nExecuting now with a safe, humanized delay (10-30 seconds between groups).' });
        
        const locked = loadLockedGroups();
        const newLocked = locked.filter(jidVal => !allGroups.some(g => g.jid === jidVal));
        saveLockedGroups(newLocked);
        
        const results = [];
        for (let i = 0; i < allGroups.length; i++) {
            const g = allGroups[i];
            try {
                await client.setGroupAdminsOnly(g.jid, false);
                results.push('✅ ' + g.subject + ' → Unlocked');
            } catch (e) {
                results.push('❌ ' + g.subject + ' → ' + e.message.substring(0, 60));
            }
            if (i < allGroups.length - 1) {
                const delayMs = 10000 + Math.floor(Math.random() * 15000);
                await delay(delayMs);
            }
        }
        await sendAntiBanMessage(jid, { text: results.join('\n') + '\n\ncompleted unlock all groups' });
        return true;
    }
    
    // 3. Lock group {name}
    if (lower.startsWith('lock group ') || (lower.startsWith('lock ') && !lower.startsWith('lock all'))) {
        const name = cleanText.replace(/^(?:lock group|lock)\s+/i, '').trim();
        if (name && name.toLowerCase() !== 'all' && !name.toLowerCase().startsWith('all ')) {
            const allGroups = cachedGroups.length ? cachedGroups : await fetchLiveMonitoredGroups();
            const matched = allGroups.filter(g => g.subject.toLowerCase().includes(name.toLowerCase()));
            if (!matched.length) {
                await sendAntiBanMessage(jid, { text: `❌ Could not find any group matching "${name}".` });
                return true;
            }
            await sendAntiBanMessage(jid, { text: `🔒 *Locking ${matched.length} matched group(s)...*\nMatching: ${name}` });
            
            const locked = loadLockedGroups();
            const newLocked = [...new Set([...locked, ...matched.map(g => g.jid)])];
            saveLockedGroups(newLocked);
            
            const results = [];
            for (let i = 0; i < matched.length; i++) {
                const g = matched[i];
                try {
                    await client.setGroupAdminsOnly(g.jid, true);
                    results.push('✅ ' + g.subject + ' → Locked');
                } catch (e) {
                    results.push('❌ ' + g.subject + ' → ' + e.message.substring(0, 60));
                }
                if (i < matched.length - 1) {
                    const delayMs = 10000 + Math.floor(Math.random() * 15000);
                    await delay(delayMs);
                }
            }
            await sendAntiBanMessage(jid, { text: results.join('\n') + `\n\ncompleted lock group ${name}` });
            return true;
        }
    }
    
    // 4. Unlock group {name}
    if (lower.startsWith('unlock group ') || (lower.startsWith('unlock ') && !lower.startsWith('unlock all'))) {
        const name = cleanText.replace(/^(?:unlock group|unlock)\s+/i, '').trim();
        if (name && name.toLowerCase() !== 'all' && !name.toLowerCase().startsWith('all ')) {
            const allGroups = cachedGroups.length ? cachedGroups : await fetchLiveMonitoredGroups();
            const matched = allGroups.filter(g => g.subject.toLowerCase().includes(name.toLowerCase()));
            if (!matched.length) {
                await sendAntiBanMessage(jid, { text: `❌ Could not find any group matching "${name}".` });
                return true;
            }
            await sendAntiBanMessage(jid, { text: `🔓 *Unlocking ${matched.length} matched group(s)...*\nMatching: ${name}` });
            
            const locked = loadLockedGroups();
            const newLocked = locked.filter(jidVal => !matched.some(g => g.jid === jidVal));
            saveLockedGroups(newLocked);
            
            const results = [];
            for (let i = 0; i < matched.length; i++) {
                const g = matched[i];
                try {
                    await client.setGroupAdminsOnly(g.jid, false);
                    results.push('✅ ' + g.subject + ' → Unlocked');
                } catch (e) {
                    results.push('❌ ' + g.subject + ' → ' + e.message.substring(0, 60));
                }
                if (i < matched.length - 1) {
                    const delayMs = 10000 + Math.floor(Math.random() * 15000);
                    await delay(delayMs);
                }
            }
            await sendAntiBanMessage(jid, { text: results.join('\n') + `\n\ncompleted unlock group ${name}` });
            return true;
        }
    }
    
    // 5. Broadcast to {groups}: [message]
    const bcastRegex = /^(?:broadcast to|send broadcast to|announce to)\s+(.+?)(?:\s*:\s*([\s\S]+))?$/i;
    const bcastMatch = cleanText.match(bcastRegex);
    if (bcastMatch) {
        const targetGroupsStr = bcastMatch[1].trim();
        const rawMessage = bcastMatch[2] ? bcastMatch[2].trim() : '';
        
        // Split group names by comma or 'and'
        const targetNames = targetGroupsStr.split(/, | and |,/).map(s => s.trim().toLowerCase()).filter(Boolean);
        if (targetNames.length > 0) {
            const allGroups = cachedGroups.length ? cachedGroups : await fetchLiveMonitoredGroups();
            const matched = [];
            
            for (const name of targetNames) {
                const found = allGroups.filter(g => g.subject.toLowerCase().includes(name));
                matched.push(...found);
            }
            
            // Remove duplicates
            const uniqueMatched = [];
            const seen = new Set();
            for (const g of matched) {
                if (!seen.has(g.jid)) {
                    seen.add(g.jid);
                    uniqueMatched.push(g);
                }
            }
            
            if (!uniqueMatched.length) {
                await sendAntiBanMessage(jid, { text: `❌ Could not find any matching groups for: "${targetGroupsStr}".` });
                return true;
            }
            
            if (rawMessage) {
                // We have a message body, broadcast immediately!
                const adminPhone = formatPhoneNumberGH(senderPhone);
                const signature = '\n\n— ' + (adminProfile.name || 'Admin') + ', Admin\n' + adminPhone;
                const msgText = rawMessage + signature;
                
                await sendAntiBanMessage(jid, { text: `📤 *Broadcasting immediately to ${uniqueMatched.length} matched group(s)...*\n${uniqueMatched.map(g => '• ' + g.subject).join('\n')}` });
                
                let sent = 0;
                let failed = 0;
                for (let i = 0; i < uniqueMatched.length; i++) {
                    const group = uniqueMatched[i];
                    try {
                        await sendAntiBanMessage(group.jid, { text: msgText });
                        sent++;
                    } catch (e) {
                        failed++;
                    }
                    if (i < uniqueMatched.length - 1) {
                        const delayMs = 10000 + Math.floor(Math.random() * 15000);
                        await delay(delayMs);
                    }
                }
                await sendAntiBanMessage(jid, { text: `✅ *Broadcast complete*\nSent: ${sent}/${uniqueMatched.length}\nFailed: ${failed}\n\ncompleted broadcast to ${targetGroupsStr}` });
                return true;
            } else {
                // No message body yet, trigger the wizard at CAPTURING_RAW_BODY step with groups pre-selected!
                adminBroadcastStates.set(senderPhone, {
                    step: 'CAPTURING_RAW_BODY',
                    groups: allGroups,
                    selected: uniqueMatched,
                    adminName: adminProfile?.name || 'Admin'
                });
                
                const groupNames = uniqueMatched.map(g => '• ' + g.subject).join('\n');
                await sendAntiBanMessage(jid, { text: `✅ *${uniqueMatched.length} Group(s) Pre-Selected:*\n${groupNames}\n\nNow send the broadcast message (text, image, video, audio, or document). (Type *cancel* to abort.)` });
                return true;
            }
        }
    }
    
    return false;
};

async function processIncomingMessage(msg) {
    if (!msg || !msg.key || msg.key.fromMe) return;
    const jid = msg.key.remoteJid;
    if (!jid) return;
    
    // Ignore protocol/status/receipt messages that have no actual content to prevent duplicate blank catches
    const payload = extractIncomingPayload(msg);
    const isStatus = !!(msg.message?.groupStatusMentionMessage);
    const isMedia = !!(
        msg.message?.imageMessage ||
        msg.message?.videoMessage ||
        msg.message?.audioMessage ||
        msg.message?.documentMessage ||
        msg.message?.stickerMessage
    );
    if (!payload.text && !payload.hasImage && !isStatus && !isMedia) {
        return;
    }

    const isGroup = jid.endsWith('@g.us');
    const sender = isGroup ? (msg.key.participant || jid) : jid;
    const senderPhone = senderPhoneFromJid(sender);
    try { fs.appendFileSync('_trace.log', 'RECV jid=' + jid + ' isGroup=' + isGroup + ' fromMe=' + msg.key.fromMe + '\n'); } catch (e) { }
    const adminProfile = await lookupBroadcastAdmin(senderPhone, sender);
    let isAdmin = !!adminProfile;
    console.log(' [Msg] From ' + senderPhone + ' isAdmin=' + isAdmin + ' isGroup=' + isGroup);
    if (isGroup) {
        // Rule: If the bot itself is not an admin in this group, do absolutely nothing (not even a dot)
        const isBotAdmin = botAdminGroupCache.get(jid) === true;
        if (!isBotAdmin) return;

        // Perform core group moderation (deleting link/badword/status-mention)
        const moderated = await handleGroupModeration(msg, jid, sender, senderPhone, isAdmin);
        if (moderated) return;

        // Rule: Bot is NOT allowed to chat or trigger commands with non-admins in group chats
        if (!isAdmin) return;

        const { text: groupText, hasImage } = extractIncomingPayload(msg);
        const lower = (groupText || '').trim().toLowerCase();
        const hasActiveWizard = adminBroadcastStates.has(senderPhone);
        if (hasActiveWizard || (groupText && isBroadcastIntent(lower))) {
            if (hasActiveWizard) {
                const handled = await handleAdminBroadcastDM(jid, senderPhone, groupText, adminProfile, sender, msg);
                if (handled) return;
            }
            if (!adminAlertsGroupJid) {
                await detectAdminAlertsGroup();
            }
            if (adminAlertsGroupJid && jid === adminAlertsGroupJid) {
                const handled = await handleAdminBroadcastDM(jid, senderPhone, groupText, adminProfile, sender, msg);
                if (handled) return;
            }
            if (!adminAlertsGroupJid) {
                adminAlertsGroupJid = jid;
                console.log(' [Alerts] Admin alerts group set dynamically to ' + jid);
                const handled = await handleAdminBroadcastDM(jid, senderPhone, groupText, adminProfile, sender, msg);
                if (handled) return;
            }
        }

        // Dynamic AI Chit-Chat for Admins in group chats
        const myJid = client.sock?.user?.id;
        const myLid = client.sock?.user?.lid;
        const cleanMyJid = myJid ? myJid.split(':')[0].replace(/[^0-9]/g, '') : '';
        const cleanMyLid = myLid ? myLid.split(':')[0].replace(/[^0-9]/g, '') : '';

        const getContextInfo = (mObj) => {
            const m = mObj?.message;
            if (!m) return null;
            return m.extendedTextMessage?.contextInfo ||
                   m.imageMessage?.contextInfo ||
                   m.videoMessage?.contextInfo ||
                   m.documentMessage?.contextInfo ||
                   m.audioMessage?.contextInfo ||
                   m.stickerMessage?.contextInfo;
        };

        const contextInfo = getContextInfo(msg);
        const mentions = contextInfo?.mentionedJid || [];
        const isBotTagged = mentions.some(m => m.includes(cleanMyJid) || (cleanMyLid && m.includes(cleanMyLid)));

        const isCallingBot = (groupText || hasImage) && (
            isBotTagged ||
            lower.startsWith('bot ') ||
            lower.startsWith('bot') ||
            lower.startsWith('gatekeeper') ||
            lower.startsWith('super bot') ||
            lower.includes('@tn connect') ||
            lower.includes('super bot') ||
            lower.includes('gatekeeper')
        );

        if (isCallingBot && !moderated) {
            const handledNatural = await handleNaturalLanguageCommand(jid, senderPhone, groupText, adminProfile, msg);
            if (handledNatural) return;

            if (hasImage) {
                const handledReply = await handleAdminReplyAssistant(jid, senderPhone, msg, adminProfile?.name || 'Admin');
                if (handledReply) return;
            } else {
                let cleanPrompt = groupText.replace(/@\d+/g, '').replace(/^(?:bot|gatekeeper|super bot)\b/i, '').trim();
                cleanPrompt = cleanPrompt.replace(/@tn connect super bot\.\./gi, '')
                                         .replace(/@tn connect super bot/gi, '')
                                         .replace(/tn connect super bot/gi, '')
                                         .replace(/super bot/gi, '')
                                         .replace(/@\S+/g, '')
                                         .trim();
                if (cleanPrompt) {
                    const quotedText = extractQuotedMessageText(msg);
                    let finalPrompt = cleanPrompt;
                    if (quotedText) {
                        finalPrompt = `[The admin is replying to this quoted message: "${quotedText}"]\n\nAdmin says: ${cleanPrompt}`;
                    }
                    const aiResponse = await callAIChat(senderPhone, finalPrompt, adminProfile.name);
                    if (aiResponse) {
                        await sendAntiBanMessage(jid, { text: aiResponse });
                        return;
                    }
                }
            }
        }
        return;
    }
    const { text: dmText } = extractIncomingPayload(msg);
    // admin self-registration — any user can register
    if (dmText) {
        const handledReg = await handleAdminRegistration(jid, senderPhone, dmText);
        if (handledReg) return;
    }
    if (isAdmin) {
        const handledNatural = await handleNaturalLanguageCommand(jid, senderPhone, dmText, adminProfile, msg);
        if (handledNatural) return;

        const hasLockWizard = groupLockStates.has(senderPhone);
        if (isGroupLockIntent(dmText) || hasLockWizard) {
            const handledLock = await handleGroupLockDM(jid, senderPhone, dmText, adminProfile);
            if (handledLock) return;
        }
        const hasBroadcastWizard = adminBroadcastStates.has(senderPhone);
        if (dmText || hasBroadcastWizard) {
            const handled = await handleAdminBroadcastDM(jid, senderPhone, dmText, adminProfile, sender, msg);
            if (handled) return;
        }

        // Dynamic AI Chit-Chat for Admins in DM
        if (dmText && !dmText.toLowerCase().startsWith('rewrite:')) {
            const quotedText = extractQuotedMessageText(msg);
            let finalPrompt = dmText;
            if (quotedText) {
                finalPrompt = `[The admin is replying to this quoted message: "${quotedText}"]\n\nAdmin says: ${dmText}`;
            }
            const aiResponse = await callAIChat(senderPhone, finalPrompt, adminProfile.name);
            if (aiResponse) {
                await sendAntiBanMessage(jid, { text: aiResponse });
                return;
            }
        }
    }
    if (adminBroadcastStates.has(senderPhone)) return;
    if (groupLockStates.has(senderPhone)) return;
    if (adminRegistrationStates.has(senderPhone)) return;
    const bizHubRequest = findBusinessHubRequest(jid);
    if (bizHubRequest && !humanTakeoverUsers.has(formatPhoneNumberGH(senderPhone))) {
        const { text, hasImage } = extractIncomingPayload(msg);
        const textInput = text || (hasImage ? '(Applicant sent an image)' : '');
        if (textInput) await handleBusinessHubConversation(jid, textInput, bizHubRequest, bizHubRequest.admin || getBotAdminContext().name);
        return;
    }
    const pendingRequest = findPendingRequest(jid);
    if (pendingRequest) await handleGatekeeperDM(jid, msg, pendingRequest);
    if (pendingRequest) return;
    // 🤖 AI Reply Assistant — admin sends screenshot
    if (isAdmin) {
        const handledReply = await handleAdminReplyAssistant(jid, senderPhone, msg, adminProfile?.name || 'Admin');
        if (handledReply) return;
    }
    // 🔍 Niche Group Finder — non-admin users DMs
    if (nicheFinderStates.has(senderPhone)) {
        if (dmText) await handleNicheFinder(jid, senderPhone, dmText);
        return;
    }
    if (!isAdmin && dmText) {
        const handledNiche = await handleNicheFinder(jid, senderPhone, dmText);
        if (handledNiche) return;
    }
    if (isAdmin && !bizHubRequest && !pendingRequest) {
        try { fs.appendFileSync('_trace.log', 'ADMIN_CATCHALL trying reply to ' + senderPhone + '\n'); } catch (e) {}
        try {
            await sendAntiBanMessage(jid, { text: '👋 Hi ' + (adminProfile?.name || 'Admin') + '! I\'m the TN Gatekeeper bot.\n\nAvailable commands:\n• *broadcast* — Send a message to all monitored groups\n• *lock/unlock* — Lock/unlock groups (admin-only messaging)\n• *help* + *screenshot* — I\'ll suggest a professional reply\n• *register* — Register as an admin' });
            try { fs.appendFileSync('_trace.log', 'ADMIN_CATCHALL reply SENT OK\n'); } catch (e) {}
        } catch (e) {
            try { fs.appendFileSync('_trace.log', 'ADMIN_CATCHALL REPLY FAILED: ' + e.message + '\n'); } catch (e2) {}
        }
    }
}

// ==========================================
// 🌐 EXPRESS REST API ENDPOINTS
// ==========================================
app.get('/debug/webhook', (req, res) => { res.json({ message: 'Webhook not used — Baileys handles messages directly' }); });
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
        const authedPhone = client.phoneNumber || null;
        const authed = !!(authedPhone && client.connected);
        // If client is connected to any phone, report it
        if (authed) {
            const targetPhone = activeSessionPhone || authedPhone;
            const meta = loadSessionMeta()[targetPhone] || {};
            sessionArray.push({
                phone: targetPhone, name: meta.adminName || 'TN Connect Assistant',
                connected: true, discoveredGroups: meta.discoveredGroups || []
            });
            return res.json(sessionArray);
        }
        if (activeSessionPhone && !authed) {
            const meta = loadSessionMeta()[activeSessionPhone] || {};
            sessionArray.push({
                phone: activeSessionPhone, name: meta.adminName || 'TN Connect Assistant',
                connected: false, discoveredGroups: meta.discoveredGroups || []
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
        if (client.connected) {
            const rawAuthed = (client.phoneNumber || '').replace(/\D/g, '');
            const authedPhone = rawAuthed.substring(0, 12);
            return res.json({
                status: 'CONNECTED',
                success: true,
                message: 'Bot is already connected to +' + authedPhone + '. Please disconnect first if you wish to link a new number.'
            });
        }
        activeSessionPhone = phone;
        const meta = loadSessionMeta();
        meta[phone] = { ...(meta[phone] || {}), adminName, role: adminRole, selectedGroups };
        saveSessionMeta(meta);
        startupTime = Date.now();
        // Request pairing code from Baileys
        if (client.getQrCode && typeof client.requestPairingCode === 'function') {
            const pairingCode = await client.requestPairingCode(phone);
            console.log(' [Pairing] Code generated for +' + phone + ': ' + pairingCode);
            return res.json({
                success: true,
                status: 'PAIRING_CODE',
                pairingCode: pairingCode,
                message: 'Enter this code in WhatsApp > Linked Devices > Link a Device',
            });
        }
        // Fallback: session already active
        console.log(' [Session] Bot session initialized for +' + phone);
        await detectAdminAlertsGroup();
        await populateLidMap();
        await refreshDiscoveredGroups(phone);
        await scanPendingJoinRequests();
        await scanAllGroupsForOldLinks();
        res.json({ success: true, status: 'CONNECTED', message: 'Session already active' });
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

app.all('/api/admins/seed-campus', async (req, res) => {
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

app.get('/api/admins/list', async (req, res) => {
    const admins = [];
    // hardcoded roster
    for (const a of CAMPUS_ADMIN_ROSTER) {
        admins.push({ phone: a.phone, name: a.admin_name, source: 'roster' });
    }
    // locally registered
    for (const [phone, entry] of registeredAdmins) {
        if (!admins.find(a => a.phone === phone)) {
            admins.push({ phone, name: entry.name, source: 'local' });
        }
    }
    // supabase
    if (supabase) {
        try {
            const { data } = await supabase.from('gatekeeper_sessions')
                .select('phone, admin_name, role').in('role', ['admin', 'admin_node']);
            if (data) {
                for (const d of data) {
                    if (!admins.find(a => a.phone === d.phone)) {
                        admins.push({ phone: d.phone, name: d.admin_name, source: 'supabase' });
                    }
                }
            }
        } catch (e) { }
    }
    res.json(admins);
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
            await client.sendText(adminAlertsGroupJid, alertText);
        } catch (e) {
            console.error("Failed to send message to admin group:", e.message);
        }
    } else {
        console.log("No admin alerts group JID detected. Printing alert:\n" + alertText);
    }
}

app.get('/qr', async (req, res) => {
    const qrPath = path.join(__dirname, 'public', 'qrcode.png');
    if (fs.existsSync(qrPath)) {
        const img = fs.readFileSync(qrPath);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': img.length, 'Cache-Control': 'no-cache' });
        return res.end(img);
    }
    res.status(404).json({ error: 'No QR available. Check server logs for status.' });
});

app.use('/api', (req, res) => {
    res.status(404).json({ error: 'API Route not found.' });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================
// ⏰ KEEP-AWAKE — pings self every 5 min so Render never spins down
// ==========================================
const KEEP_AWAKE_URL = SERVER_URL || ('http://localhost:' + PORT);
setInterval(() => {
    const mod = KEEP_AWAKE_URL.startsWith('https') ? https : http;
    mod.get(KEEP_AWAKE_URL + '/', (res) => res.resume()).on('error', () => {});
}, 5 * 60 * 1000);

// ==========================================
// 🚀 SERVER START
// ==========================================
let lockHeartbeatInterval = null;
const INSTANCE_ID = process.env.RENDER_INSTANCE_ID || ('local_' + Math.random().toString(36).substring(2, 10));

const acquireLock = async () => {
    if (!supabase) return true;
    console.log(' [Lock] Checking for active instance lock...');
    const maxWaitTime = 180000;
    const pollInterval = 5000;
    let waited = 0;
    
    while (waited < maxWaitTime) {
        try {
            const { data, error } = await supabase.from('bot_auth').select('creds_json').eq('id', 'active_lock').maybeSingle();
            if (error) throw error;
            
            if (data?.creds_json) {
                const lockInfo = JSON.parse(data.creds_json);
                const age = Date.now() - lockInfo.heartbeat;
                if (lockInfo.instanceId !== INSTANCE_ID && age < 45000) {
                    console.log(` [Lock] Active instance detected (Instance: ${lockInfo.instanceId}, Heartbeat age: ${Math.round(age / 1000)}s). Waiting for release…`);
                    await delay(pollInterval);
                    waited += pollInterval;
                    continue;
                }
            }
            
            await supabase.from('bot_auth').upsert({
                id: 'active_lock',
                creds_json: JSON.stringify({ heartbeat: Date.now(), instanceId: INSTANCE_ID }),
                updated_at: new Date().toISOString()
            });
            console.log(` [Lock] Successfully acquired session lock (Instance: ${INSTANCE_ID})`);
            startLockHeartbeat();
            return true;
        } catch (e) {
            console.error(' [Lock] Error checking/acquiring lock:', e.message);
            await delay(pollInterval);
            waited += pollInterval;
        }
    }
    
    console.warn(' [Lock] Timed out waiting for active lock to release. Forcing acquisition…');
    try {
        await supabase.from('bot_auth').upsert({
            id: 'active_lock',
            creds_json: JSON.stringify({ heartbeat: Date.now(), instanceId: INSTANCE_ID }),
            updated_at: new Date().toISOString()
        });
        startLockHeartbeat();
    } catch (e) {
        console.error(' [Lock] Failed to force acquire lock:', e.message);
    }
    return true;
};

const startLockHeartbeat = () => {
    if (lockHeartbeatInterval) clearInterval(lockHeartbeatInterval);
    lockHeartbeatInterval = setInterval(async () => {
        if (!supabase) return;
        try {
            await supabase.from('bot_auth').upsert({
                id: 'active_lock',
                creds_json: JSON.stringify({ heartbeat: Date.now(), instanceId: INSTANCE_ID }),
                updated_at: new Date().toISOString()
            });
        } catch (e) {
            console.warn(' [Lock] Heartbeat update failed:', e.message);
        }
    }, 20000);
};

const releaseLock = async () => {
    if (lockHeartbeatInterval) clearInterval(lockHeartbeatInterval);
    if (!supabase) return;
    try {
        console.log(' [Lock] Releasing active lock in Supabase...');
        const { data } = await supabase.from('bot_auth').select('creds_json').eq('id', 'active_lock').maybeSingle();
        if (data?.creds_json) {
            const lockInfo = JSON.parse(data.creds_json);
            if (lockInfo.instanceId === INSTANCE_ID) {
                await supabase.from('bot_auth').delete().eq('id', 'active_lock');
                console.log(' [Lock] Active lock released successfully.');
            }
        }
    } catch (e) {
        console.error(' [Lock] Error releasing lock:', e.message);
    }
};

const cleanShutdown = async (signal) => {
    console.log(`\n [Shutdown] Received ${signal}. Initiating clean exit sequence…`);
    try {
        if (presenceTimer) clearTimeout(presenceTimer);
        
        if (client && client.sock) {
            console.log(' [Shutdown] Closing WhatsApp socket connection...');
            client.sock.ev.removeAllListeners();
            if (client.sock.ws) {
                client.sock.ws.close();
            }
        }
        
        await releaseLock();
    } catch (e) {
        console.error(' [Shutdown] Error during clean shutdown:', e.message);
    } finally {
        console.log(' [Shutdown] Exit sequence completed. Bye!');
        process.exit(0);
    }
};

process.on('SIGTERM', () => cleanShutdown('SIGTERM'));
process.on('SIGINT', () => cleanShutdown('SIGINT'));

const server = http.createServer(app);
server.listen(PORT, async () => {
    console.log(' [Server] Gatekeeper v3.0 (Baileys) is live on port ' + PORT);
    
    await acquireLock();
    await ensureRegistryLoaded();

    // Restore session meta & broadcast whitelist from Supabase (survives Redeploys)
    await restoreSessionMetaFromSupabase();
    await loadBroadcastWhitelistFromSupabase();

    // Initialize anti-ban module
    antiban = new AntiBan({
        preset: 'moderate',
        logging: true,
        persist: './antiban-state.json',
    });
    console.log(' [AntiBan] Rate limiter initialized');

    // Wire Baileys events to business logic
    wireBaileysEvents();

    // Restore auth creds from Supabase (survives Render deploys)
    if (supabase) {
        try {
            const { data } = await supabase.from('bot_auth').select('creds_json').eq('id', 'creds').maybeSingle();
            if (data?.creds_json) {
                const credsPath = path.join(AUTH_FOLDER, 'creds.json');
                if (!fs.existsSync(AUTH_FOLDER)) {
                    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
                }
                fs.writeFileSync(credsPath, data.creds_json);
                console.log(' [Auth] Restored creds.json from Supabase');
            } else {
                console.log(' [Auth] No saved creds in Supabase — will create new session');
            }
        } catch (e) {
            if (e.message?.includes('relation') || e.code === '42P01') {
                console.log(' [Auth] Table bot_auth missing — run in Supabase SQL Editor:\n   CREATE TABLE IF NOT EXISTS bot_auth (id TEXT PRIMARY KEY, creds_json TEXT, updated_at TIMESTAMP DEFAULT NOW());');
            } else {
                console.warn(' [Auth] Supabase restore failed:', e.message);
            }
        }
    }
    // Save creds to Supabase on update
    client.onCredsUpdate = async (creds) => {
        if (!supabase) return;
        try {
            await supabase.from('bot_auth').upsert({
                id: 'creds',
                creds_json: JSON.stringify(creds, BufferJSON.replacer),
                updated_at: new Date().toISOString()
            });
        } catch (e) {
            if (e.message?.includes('relation') || e.code === '42P01') {
                console.log(' [Auth] Table bot_auth missing — run in Supabase SQL Editor:\n   CREATE TABLE IF NOT EXISTS bot_auth (id TEXT PRIMARY KEY, creds_json TEXT, updated_at TIMESTAMP DEFAULT NOW());');
            } else {
                console.warn(' [Auth] Supabase save failed:', e.message);
            }
        }
    };

    // Initialize Baileys socket
    console.log(' [Baileys] Initializing WhatsApp session...');
    try {
        await client.init();
        console.log(' [Baileys] Socket created. Waiting for connection...');
        console.log(' [Baileys] QR code will appear in logs when ready. Open /qr to view.');
        console.log(' [Baileys] Or use /api/auth/request-code to trigger pairing code.');
    } catch (e) {
        console.error(' [Baileys] Init failed:', e.message);
    }
});

// Global error middleware
app.use((err, req, res, next) => {
    console.error(' [Error] ' + (err.type || err.code || err.message || 'Unknown error'));
    if (err.type === 'entity.too.large') {
        return res.status(200).json({ ok: true, warning: 'payload too large, skipped' });
    }
    res.status(200).json({ ok: true, error: err.message });
});

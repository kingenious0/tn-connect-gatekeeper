// Version 1.3 Pro - Single-Worker Cloud Engine with Anti-Ban & Gemini Multimodal
require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, delay } = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const P = require('pino');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
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

// Global variables for active socket sessions and status
const activeSessions = {};
const activeQRs = {};
const pendingApprovals = new Map(); 
const pendingVerifications = new Map(); 
const businessHubConversations = new Map(); 
const humanTakeoverUsers = new Set(); 
const uploadDebounces = {}; 

let sock = null; // Global active single-worker socket reference
let adminAlertsGroupJid = null;
const ENABLE_DEPARTURE_NUDGE = false;
const departureNudgedUsers = new Set(); 

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
    console.error("❌ [Supabase] Client initialization failed:", e.message);
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

const BUSINESS_HUB_SYSTEM_PROMPT = `You are a sharp, professional business intake coordinator for TN Winneba Business Hub — an exclusive networking community for serious business owners in Winneba, Ghana. You represent the TN Uni Connect admin team.\r\n\r\nYour job is to screen and onboard business applicants through a natural, concise conversation. Collect the following in this EXACT order, one or two at a time:\r\n1. Full name\r\n2. Are they a resident of Winneba? (ask this SECOND — before any business questions)\r\n3. Business name and type\r\n4. Exact location in Winneba\r\n5. Products or services offered\r\n6. Open to partnerships and vacancy sharing? (yes/no)\r\n7. How TN members and Ghanaians benefit from their business\r\n\r\nResidency Rule (CRITICAL — check at step 2, immediately after getting their name):\r\n- If they say YES to being a Winneba resident → continue with the remaining business questions (3-7)\r\n- If they say NO to being a Winneba resident → ask ONE follow-up: "If we organise a physical meet-up in Winneba, would you be able to attend?"\r\n  - If YES to attending → continue with the remaining business questions (3-7), treat as approved\r\n  - If NO to attending → close gracefully immediately. Thank them warmly, tell them the hub is currently focused on people who can be physically present in Winneba, let them know TN Connect has other exciting opportunities suited to them and an admin will reach out soon. Then end with the [RESIDENT_DECLINED] marker on a new line. No JSON needed for this path. Do NOT ask any more business questions.\r\n\r\nStyle Rules:\r\n- Be concise. One clear question per message, maximum two sentences. No paragraphs.\r\n- Sound like a sharp, experienced business networker — warm but efficient\r\n- Never sound like a bot or a form. Speak like a real person\r\n- Do not use excessive emojis — one per message maximum\r\n- Never reveal you are an AI\r\n- If someone gives a vague or off-topic reply, redirect sharply but politely.`;

// ==========================================
// 🧠 GEMINI 2.5 FLASH-LITE ENGINE (1,000 RPD)
// ==========================================
const geminiClient = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const geminiModel = geminiClient ? geminiClient.getGenerativeModel({
    model: 'gemini-2.5-flash-lite', // Activated safe quota layer
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
// 🗄️ LOCAL / SERIALIZER STORAGE UTILITIES
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
                filesData[file] = fs.readFileSync(filePath).toString('base64');
            }
        }
    } catch (e) { console.error('❌ Failed to serialize folder:', e); }
    return filesData;
};

const loadSessionMeta = () => {
    if (!fs.existsSync(SESSION_META_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(SESSION_META_FILE, 'utf-8')); } catch (e) { return {}; }
};

const saveSessionMeta = (meta) => {
    try { fs.writeFileSync(SESSION_META_FILE, JSON.stringify(meta, null, 2)); } catch (e) { console.error("❌ Failed to write sessions_meta.", e); }
};

const loadRegistry = () => {
    if (!fs.existsSync(REGISTRY_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8')); } catch (e) { return {}; }
};

const saveRegistry = (data) => {
    try { fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2)); } catch (e) { console.error("❌ Failed to write registry.", e); }
};

const saveRegistryItem = async (key, item) => {
    const registry = loadRegistry();
    registry[key] = item;
    saveRegistry(registry);
    if (supabase) {
        try {
            await supabase.from('gatekeeper_registry').upsert({
                key, admin_name: item.admin, phone: item.phone, group_jid: item.groupJid, status: item.status, timestamp: item.timestamp
            });
        } catch (err) { console.error("❌ [Supabase] Registry sync crash:", err); }
    }
};

const loadApplicants = () => {
    if (!fs.existsSync(APPLICANTS_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(APPLICANTS_FILE, 'utf-8')); } catch (e) { return []; }
};

const saveApplicant = async (applicantData) => {
    const applicants = loadApplicants();
    const entry = { ...applicantData, id: Date.now(), createdAt: new Date().toISOString(), status: 'pending_review' };
    applicants.push(entry);
    try { fs.writeFileSync(APPLICANTS_FILE, JSON.stringify(applicants, null, 2)); } catch (e) { console.error('❌ Error saving applicant locally:', e); }
    if (supabase) {
        try {
            await supabase.from('business_hub_applicants').insert({
                phone: applicantData.phone || '', name: applicantData.name || '', business_name: applicantData.businessName || '',
                business_type: applicantData.businessType || '', location: applicantData.location || '', services: applicantData.services || '',
                partnerships: applicantData.partnerships || '', benefit: applicantData.benefit || '', status: 'pending_review'
            });
        } catch (e) { console.error('❌ [Supabase] Applicant write skipped:', e.message); }
    }
    return entry;
};

// ==========================================
// 🌐 EXPRESS REST API ENDPOINTS (Clears 404s)
// ==========================================

// Dashboard Status Endpoint
app.get('/api/sessions', async (req, res) => {
    try {
        if (sock && sock.user) {
            return res.json({ status: 'connected', user: sock.user });
        }
        if (supabase) {
            const { data } = await supabase.from('gatekeeper_sessions').select('phone').eq('role', 'core_gatekeeper_bot').single();
            if (data) return res.json({ status: 'resting_in_cloud', phone: data.phone });
        }
        res.json({ status: 'disconnected' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Dashboard Applicants Data Sync
app.get('/api/business-hub/applicants', async (req, res) => {
    try {
        if (supabase) {
            const { data, error } = await supabase.from('business_hub_applicants').select('*').order('created_at', { ascending: false });
            if (!error && data) return res.json(data);
        }
        res.json(loadApplicants());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Dashboard Active Pairing Generator Hook
app.post('/api/auth/request-code', async (req, res) => {
    let { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "Phone target parameter is required." });

    phone = phone.replace(/\D/g, '');
    console.log(`📡 [Pairing Router] Triggering engine layer code lifecycle for +${phone}`);

    try {
        const dirPath = path.join(__dirname, 'auth_session_' + phone);
        if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
        fs.mkdirSync(dirPath, { recursive: true });

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
            if (supabase) {
                const files = serializeDirectory(dirPath);
                await supabase.from('gatekeeper_sessions').upsert({
                    phone,
                    admin_name: "TN Connect Assistant",
                    role: "core_gatekeeper_bot",
                    files,
                    updated_at: new Date().toISOString()
                });
            }
        });

        sock.ev.on('connection.update', (update) => {
            const { connection } = update;
            if (connection === 'open') console.log(`🚀 SUCCESS: TN Connect Assistant is 100% Linked via Server!`);
        });

        // Initialize background group monitors
        bindBotMessageHandlers(sock);

        setTimeout(async () => {
            try {
                const pairingCode = await sock.requestPairingCode(phone);
                console.log(`🔑 Generated Teleprompter Code Connection: ${pairingCode}`);
                res.json({ success: true, code: pairingCode });
            } catch (err) {
                res.status(500).json({ error: "Meta system credentials handshake error." });
            }
        }, 3000);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Anti-Ban Asymmetric Message Dispatch Engine
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

// ==========================================
// ⚙️ AUTOMATED WHATSAPP ROUTING FLOWS
// ==========================================
function bindBotMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async (chatUpdate) => {
        const msg = chatUpdate.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const isGroup = jid.endsWith('@g.us');
        const textInput = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        if (!isGroup) {
            const bizHubRequest = findBusinessHubRequest(jid);
            if (bizHubRequest) {
                await handleBusinessHubConversation(socket, jid, textInput, bizHubRequest, "TN Admin");
            }
        }
    });
}

// Fallback HTML route match for browser routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================
// 🤖 GEMINI LOGIC WITH CHAT HANDOFFS
// ==========================================
const callGeminiWithRetry = async (chat, textInput, retries = 3, initialDelayMs = 2000) => {
    let currentDelay = initialDelayMs;
    for (let i = 0; i < retries; i++) {
        try {
            return await chat.sendMessage(textInput);
        } catch (err) {
            const errStr = String(err.message || err);
            if (i < retries - 1) {
                console.warn(`⚠️ [Gemini Error Retry Loop]: ${errStr}`);
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
    if (digits.startsWith('233') && digits.length === 12) return '0' + digits.substring(3);
    return digits.startsWith('0') ? digits : '+' + digits;
};

const handleBusinessHubConversation = async (sockInstance, senderJid, textInput, bizHubRequest, adminName) => {
    if (!geminiClient) return;
    const rawPhone = senderJid.replace('@s.whatsapp.net', '').replace('@lid', '');
    const userPhone = formatPhoneNumberGH(rawPhone);

    let history = businessHubConversations.get(userPhone) || [];

    try {
        const dynamicInstruction = BUSINESS_HUB_SYSTEM_PROMPT + `\r\n\r\nIdentity Context: Represent admin "${adminName}".`;
        const modelInstance = geminiClient.getGenerativeModel({
            model: 'gemini-2.5-flash-lite',
            systemInstruction: dynamicInstruction
        });
        const chat = modelInstance.startChat({ history });
        const result = await callGeminiWithRetry(chat, textInput);
        const responseText = result.response.text();

        const INTAKE_MARKER = '[INTAKE_COMPLETE]';
        let cleanResponse = responseText.replace(INTAKE_MARKER, '').trim();

        history.push({ role: 'user', parts: [{ text: textInput }] });
        history.push({ role: 'model', parts: [{ text: responseText }] });
        businessHubConversations.set(userPhone, history);

        if (cleanResponse) {
            await sendAntiBanMessage(sockInstance, senderJid, { text: cleanResponse });
        }

        if (responseText.includes(INTAKE_MARKER)) {
            let applicantData = { name: "Extracted", phone: userPhone };
            await saveApplicant(applicantData);
            businessHubConversations.delete(userPhone);
        }
    } catch (err) {
        console.error('❌ [Gemini Pipeline Fault]:', err.message);
    }
};

// Start Unified Application Interface Server
const server = http.createServer(app);
const wss = new ws.Server({ server });

wss.on('connection', wsInstance => {
    console.log('Frontend WebSocket connection established.');
    wsInstance.send('Unified System Connection Engine Sync [Active]');
});

server.listen(PORT, () => {
    console.log(`⚡️ [Server] Gatekeeper Engine + API Dashboard listening cleanly on port ${PORT}`);
});
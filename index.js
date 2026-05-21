// Version 1.3 Pro - Single-Worker Cloud Engine with Anti-Ban & Gemini Multimodal
require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, delay, downloadMediaMessage } = require('@whiskeysockets/baileys');

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
        if (key.includes(cleanSender) && entry.status !== 'approved') {
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

        if (isDeclined) {
            console.log(`🚫 [Business Hub] Non-resident declined physical attendance for +${userPhone}. Closing intake.`);
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
            await sendAlertWithScreenshot(`🚫 *[NON-RESIDENT DECLINED]*\n\n📞 *Number:* ${userPhone}\n🏘️ Not based in Winneba and cannot attend physical meetings.\nIntake closed. Manual follow-up optional.`);
        }

        if (responseText.includes(HUMAN_MARKER)) {
            console.log(`⚠️ [Business Hub] Human handooff triggered for +${userPhone}. Alerting admins...`);
            humanTakeoverUsers.add(userPhone);
            const alertText = `⚠️ *[HUMAN HANDOFF REQUIRED]* ⚠️\n\n📞 *Number:* ${userPhone}\n💬 *Last message:* "${textInput}"\n\nThe AI has been paused. Open a DM with ${userPhone} to take over.`;
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

// 🚨 Fixed Express 5 Wildcard Matcher
app.get('/*splat', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`⚡️ [Server] Gatekeeper is live on port ${PORT}`);
});
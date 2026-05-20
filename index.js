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
const GATEKEEPER_MESSAGE = `*{hello|hi|hey}, we just got your request to join our group*
🚨ACTION REQUIRED🚨

To be approved into the niche group first join one of the general market groups (tap links in channel to see all the links). 

TikTok: Follow *TN FILMS GH*


We’ll view your chat before approving. {If we get to your chat and you’ve not done these we will cancel your request.|Please complete these steps to avoid your request being cancelled.} Follow these steps 

Facebook/Instagram: Follow *TN UNIVERSITIES CONNECT*

WhatsApp Channel: Join our official update channel: https://whatsapp.com/channel/0029VbCNby81CYoPIpEQMD1D
⚠️ Delay = Cancellation. We are clearing the pending list.

Once you’ve followed all, send a DONE({with a screenshot|along with screenshots}). 

We are viewing chats before approving. If we get to your chat twice and you’ve not done so we will cancel your request

SEND ME SCREENSHOTS WHEN DONE`;

// Business Hub intro DM — dynamic variations to avoid WhatsApp spam detection
// The bot introduces itself as an "intake assistant" for TN Uni Connect (no admin name, no bot mention)
const BUSINESS_HUB_INTRO_MESSAGE = () => {
    const greetings = ['Hello', 'Hi there', 'Hey', 'Good day', 'Greetings'];
    const intros = [
        `I'm the intake assistant for TN Uni Connect`,
        `I assist the TN Uni Connect team with processing new applications`,
        `I handle intake coordination for TN Uni Connect`,
        `I work with the TN Uni Connect admin team to screen and welcome new members`,
    ];
    const checks = [
        'Has any of our team reached out to you already? If yes, just let me know their name.',
        'Has an admin already contacted you about this? If so, kindly share their name.',
        'Have you been contacted by one of our admins yet? If yes, reply with their name.',
    ];
    const prompts = [
        `If not, could you share a bit about yourself and your business? We'd love to know what you do and where you're based in Winneba.`,
        `If no one has reached out yet, tell us a little about yourself — your business name, what you do, and your location in Winneba.`,
        `If not, kindly introduce yourself — what's your business about and where are you located in Winneba?`,
    ];
    const g = greetings[Math.floor(Math.random() * greetings.length)];
    const i = intros[Math.floor(Math.random() * intros.length)];
    const c = checks[Math.floor(Math.random() * checks.length)];
    const p = prompts[Math.floor(Math.random() * prompts.length)];
    return `${g}, thanks for requesting to join TN Winneba Business Hub 💼. ${i}.\n\n${c}\n\n${p}`;
};

// Gemini AI system prompt — acts as a professional business intake coordinator
const BUSINESS_HUB_SYSTEM_PROMPT = `You are a sharp, professional business intake coordinator for TN Winneba Business Hub — an exclusive networking community for serious business owners in Winneba, Ghana. You represent the TN Uni Connect admin team.

Your job is to screen and onboard business applicants through a natural, concise conversation. Collect the following in this EXACT order, one or two at a time:
1. Full name
2. Are they a resident of Winneba? (ask this SECOND — before any business questions)
3. Business name and type
4. Exact location in Winneba
5. Products or services offered
6. Open to partnerships and vacancy sharing? (yes/no)
7. How TN members and Ghanaians benefit from their business

Residency Rule (CRITICAL — check at step 2, immediately after getting their name):
- If they say YES to being a Winneba resident → continue with the remaining business questions (3-7)
- If they say NO to being a Winneba resident → ask ONE follow-up: "If we organise a physical meet-up in Winneba, would you be able to attend?"
  - If YES to attending → continue with the remaining business questions (3-7), treat as approved
  - If NO to attending → close gracefully immediately. Thank them warmly, tell them the hub is currently focused on people who can be physically present in Winneba, let them know TN Connect has other exciting opportunities suited to them and an admin will reach out soon. Then end with the [RESIDENT_DECLINED] marker on a new line. No JSON needed for this path. Do NOT ask any more business questions.

Style Rules:
- Be concise. One clear question per message, maximum two sentences. No paragraphs.
- Sound like a sharp, experienced business networker — warm but efficient
- Never sound like a bot or a form. Speak like a real person
- Do not use excessive emojis — one per message maximum
- Never reveal you are an AI
- If someone gives a vague or off-topic reply, redirect sharply but politely in one line
- Never ask all questions at once
- Variation Rule: Always change your phrasing for every new user and every turn. Use synonyms for questions like "What is your business name?", "What do you do?", "Where are you located?". NEVER repeat the same greeting or question structure across different conversations.

Completion (when ALL points collected and residency approved):
First send a warm, professional closing message (2-3 lines max) telling them their application is received and an admin will review it. Then on a NEW LINE add this exact marker followed immediately by a valid JSON object (no space):
[INTAKE_COMPLETE]{"name":"...","businessName":"...","businessType":"...","location":"...","services":"...","partnerships":"...","benefit":"...","resident":"...","canAttend":"..."}

Escalation Rule:
- If the applicant is hostile, threatening, deeply confused, or explicitly asks for a real person for 2+ consecutive turns, append [TRIGGER_HUMAN] at the very end of your reply. Stay polite in your visible message.

Anti-Spam Variation Rule (CRITICAL for WhatsApp compliance):
- NEVER use the exact same wording twice across different conversations
- Vary your phrasing by ~20% each time — use synonyms, rearrange sentence structure, change greeting style
- This prevents WhatsApp from flagging identical bulk messages as spam
- Example: Instead of always saying "What's your business name?" — alternate with "Tell me about your business", "What do you do professionally?", "What's the name of your venture?" etc.`;


// Gemini client + model initialization
// gemini-2.5-flash-lite: 15 RPM, 1000 RPD free — fast, lightweight, ideal for conversational intake
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

// Encodes a directory of files as base64 to save in PostgreSQL
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
        console.error(`❌ Failed to serialize folder ${dirPath}:`, e);
    }
    return filesData;
};

// Recreates a directory structure from base64 payloads
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
        console.error(`❌ Failed to deserialize folder ${dirPath}:`, e);
    }
};

// Local storage fallbacks
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

// Cloud registry sync wrapper
const saveRegistryItem = async (key, item) => {
    // 1. Update locally
    const registry = loadRegistry();
    registry[key] = item;
    saveRegistry(registry);

    // 2. Synchronize to Supabase
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

// Debounced Cloud backup to protect API request limit bounds
const triggerSessionBackup = (phone, adminName, selectedGroups, discoveredGroups) => {
    if (!supabase) return;

    if (uploadDebounces[phone]) {
        clearTimeout(uploadDebounces[phone]);
    }

    uploadDebounces[phone] = setTimeout(async () => {
        try {
            const dirPath = `auth_session_${phone}`;
            const files = serializeDirectory(dirPath);

            console.log(`💾 [Supabase] Pushing backup for Admin node +${phone}...`);
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

            if (error) console.error(`❌ [Supabase] Backup error for +${phone}:`, error.message);
            else console.log(`✅ [Supabase] Session data backed up successfully for +${phone}!`);
        } catch (err) {
            console.error(`❌ [Supabase] System error backing up session for +${phone}:`, err);
        }
    }, 5000); // 5 seconds debounce
};

// Detect if a group name is TN Winneba Business Hub
const isBusinessHubGroup = (groupName) => {
    const name = (groupName || '').toLowerCase();
    return name.includes('business hub') || name.includes('winneba business');
};

// Helper: Check if a group JID belongs to a Business Hub group dynamically using admin session meta
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

// Find an active Business Hub registry entry for a given sender
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
// 📂 BUSINESS HUB APPLICANT STORAGE
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
                console.warn(`⚠️ [Gemini] API returned transient error: "${errStr}". Retrying in ${currentDelay}ms (Attempt ${i + 1}/${retries})...`);
                await delay(currentDelay);
                currentDelay *= 2;
                continue;
            }
            throw err;
        }
    }
};

const handleBusinessHubConversation = async (sock, senderJid, textInput, bizHubRequest, adminName) => {
    if (!geminiClient) return;
    const userPhone = senderJid.replace('@s.whatsapp.net', '').replace('@lid', '');

    // 📦 LOAD HISTORY: Check in-memory first, then restore from Supabase
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
                    console.log(`📦 [Business Hub] Restored ${history.length} conversation turns from Supabase for +${userPhone}`);
                }
            } catch (e) { /* no prior history */ }
        }
        history = history || [];
        businessHubConversations.set(userPhone, history);
    }

    // Dynamically retrieve the admin's role from metadata
    const cleanPhone = sock.user?.id ? sock.user.id.split(':')[0].replace(/[^0-9]/g, '') : '';
    const adminRole = cleanPhone ? ((loadSessionMeta()[cleanPhone] || {}).role || 'Admin') : 'Admin';

    // Inject actual admin name and role into Gemini's prompt instructions
    const dynamicInstruction = `${BUSINESS_HUB_SYSTEM_PROMPT}

IMPORTANT CONTEXT FOR YOUR IDENTITY:
- You represent the specific admin named "${adminName}" who is the "${adminRole}" of TN Uni Connect.
- If the applicant mentions they haven't gotten any text from an admin, or asks who you are, explain that you are the virtual intake coordinator assisting ${adminName} (${adminRole}) to gather their business details.
- Never use placeholder texts like "[Your Name]". Introduce yourself naturally as a human coordinator or professional assistant representing ${adminName} (e.g., "I'm the virtual intake coordinator assisting ${adminName}..." or "I'm a coordinator assisting ${adminName}..."). Never write grammatically incorrect sentences like "My name is your virtual intake coordinator".`;

    try {
        const modelInstance = geminiClient.getGenerativeModel({
            model: 'gemini-2.5-flash-lite',
            systemInstruction: dynamicInstruction
        });
        const chat = modelInstance.startChat({ history });
        const result = await callGeminiWithRetry(chat, textInput);
        const responseText = result.response.text();

        // Check for markers
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

        // Strip JSON from cleanResponse if present
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

        // Update in-memory conversation history
        history.push({ role: 'user', parts: [{ text: textInput }] });
        history.push({ role: 'model', parts: [{ text: responseText }] });
        businessHubConversations.set(userPhone, history);

        // 💾 PERSIST history to Supabase after every turn
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
            // Human-like typing simulation before sending Gemini response
            // 1. Simulate reading the user's message (1.5 - 3.5s)
            const readDelay = Math.floor(Math.random() * 2000) + 1500;
            await delay(readDelay);

            // 2. Show typing indicator for time proportional to response length
            // Average human types ~40 chars/sec, capped between 3s and 12s
            const typingDuration = Math.min(Math.max(Math.floor(cleanResponse.length / 40) * 1000, 3000), 12000);
            await sock.sendPresenceUpdate('composing', senderJid);
            await delay(typingDuration);
            await sock.sendPresenceUpdate('paused', senderJid);

            await sendAntiBanMessage(sock, senderJid, { text: cleanResponse });
        }

        // Build readable chat transcript from conversation history
        const buildTranscript = (hist) => {
            if (!hist || hist.length === 0) return '_(no prior messages)_';
            return hist.map(h => {
                const role = h.role === 'user' ? '👤 Applicant' : '🤖 Assistant';
                const text = (h.parts?.[0]?.text || '').substring(0, 300); // cap per turn
                return `${role}: "${text}${text.length >= 300 ? '...' : ''}"` ;
            }).join('\n');
        };
        const transcript = buildTranscript(history);

        // 📸 Helper: Send alert text + WhatsApp-style chat screenshot image to admin group
        const sendAlertWithScreenshot = async (alertText) => {
            // Always send text alert first
            await sendAdminAlert(sock, alertText);
            // Then try to generate and send screenshot image
            try {
                const screenshotBuffer = generateChatScreenshot(history, `+${userPhone}`, 'Business Hub Intake');
                if (screenshotBuffer && adminAlertsGroupJid) {
                    await sock.sendMessage(adminAlertsGroupJid, {
                        image: screenshotBuffer,
                        caption: `📸 Chat transcript for +${userPhone}`
                    });
                    console.log(`📸 [Screenshot] Chat image sent to admin alerts group for +${userPhone}`);
                }
            } catch (imgErr) {
                console.error('❌ [Screenshot] Failed to send chat image (text alert was sent):', imgErr.message);
            }
        };

        // 🚫 RESIDENT DECLINED: Non-resident won't attend. Close gracefully, stop AI, notify admins
        if (isDeclined) {
            console.log(`🚫 [Business Hub] Non-resident declined physical attendance for +${userPhone}. Closing intake.`);
            humanTakeoverUsers.add(userPhone); // Stop AI responses
            businessHubConversations.delete(userPhone);
            // Clean from Supabase
            if (supabase) {
                try { await supabase.from('business_hub_conversations').delete().eq('phone', userPhone); } catch(e) {}
            }
            const registry = loadRegistry();
            if (registry[bizHubRequest.key]) {
                registry[bizHubRequest.key].status = 'non_resident_declined';
                await saveRegistryItem(bizHubRequest.key, registry[bizHubRequest.key]);
            }
            await sendAlertWithScreenshot(`🚫 *[NON-RESIDENT DECLINED]*\n\n📞 *Number:* +${userPhone}\n🏘️ Not based in Winneba and cannot attend physical meetings.\nIntake closed. Manual follow-up optional.`);
        }

        // Handle [TRIGGER_HUMAN] — escalate to admin group, pause AI for this user
        if (responseText.includes(HUMAN_MARKER)) {
            console.log(`⚠️ [Business Hub] Human handoff triggered for +${userPhone}. Alerting admins...`);
            humanTakeoverUsers.add(userPhone);
            const alertText = `⚠️ *[HUMAN HANDOFF REQUIRED]* ⚠️\n\n📞 *Number:* +${userPhone}\n💬 *Last message:* "${textInput}"\n\nThe AI has been paused. Open a DM with +${userPhone} to take over.`;
            await sendAlertWithScreenshot(alertText);
        }

        if (isComplete && applicantData) {
            console.log(`✅ [Business Hub] Intake complete for +${userPhone}. Saving applicant data...`);
            await saveApplicant(applicantData);

            // 🔔 Alert admins with full applicant summary + transcript
            const summaryLines = [
                `✅ *[NEW BUSINESS HUB APPLICANT]* ✅`,
                ``,
                `📞 *Number:* +${userPhone}`,
                `👤 *Name:* ${applicantData.name || 'N/A'}`,
                `🏢 *Business:* ${applicantData.businessName || 'N/A'} (${applicantData.businessType || 'N/A'})`,
                `📍 *Location:* ${applicantData.location || 'N/A'}`,
                `🛒 *Services:* ${applicantData.services || 'N/A'}`,
                `🤝 *Partnerships:* ${applicantData.partnerships || 'N/A'}`,
                `💡 *Benefit:* ${applicantData.benefit || 'N/A'}`,
                `🏘️ *Winneba Resident:* ${applicantData.resident || 'N/A'}`
            ].join('\n');
            await sendAlertWithScreenshot(summaryLines);

            // Update registry status so this user is not processed again
            const registry = loadRegistry();
            if (registry[bizHubRequest.key]) {
                registry[bizHubRequest.key].status = 'interview_complete';
                await saveRegistryItem(bizHubRequest.key, registry[bizHubRequest.key]);
            }

            // Clear conversation memory + Supabase
            businessHubConversations.delete(userPhone);
            if (supabase) {
                try { await supabase.from('business_hub_conversations').delete().eq('phone', userPhone); } catch(e) {}
            }
        }
    } catch (err) {
        console.error('❌ [Gemini] API call failed after retries:', err.message || err);
        // Silent failure so we don't break character or reveal the bot's existence.
    }
};


// ==========================================
// 🔍 GEMINI MULTIMODAL SCREENSHOT VERIFICATION
// ==========================================
// Downloads screenshot image buffers and sends them to Gemini 2.5 Flash
// for OCR analysis to verify the applicant actually completed the tasks.

const SCREENSHOT_VERIFICATION_PROMPT = `Analyze this screenshot image carefully. Determine if it shows evidence of ANY of the following actions:
1. Following a TikTok account (look for TikTok UI, "Following" button state, profile pages)
2. Following a Facebook or Instagram page (look for Facebook/Instagram UI, "Following" state, page profiles)
3. Joining a WhatsApp Channel (look for WhatsApp Channel UI, subscription confirmation)

Respond with ONLY a valid JSON object, nothing else:
{"tiktok": true/false, "social": true/false, "channel": true/false}

Set true ONLY if you can clearly see evidence of that specific action being completed. If the image is unclear, blurry, or does not show any of these, set all to false.`;

const verifyScreenshotWithGemini = async (imageBuffer, mimeType = 'image/jpeg') => {
    if (!geminiClient) return null;
    try {
        // gemini-2.5-flash-lite: 15 RPM, 1000 RPD free — covers both chat and vision tasks
        const model = geminiClient.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
        const imagePart = {
            inlineData: {
                data: imageBuffer.toString('base64'),
                mimeType: mimeType
            }
        };
        const result = await model.generateContent([SCREENSHOT_VERIFICATION_PROMPT, imagePart]);
        const responseText = result.response.text().trim();

        // Extract JSON from response (handle markdown code blocks)
        let jsonStr = responseText;
        const jsonMatch = responseText.match(/\{[^}]+\}/);
        if (jsonMatch) jsonStr = jsonMatch[0];

        const parsed = JSON.parse(jsonStr);
        console.log(`🔍 [Gemini Vision] Screenshot analysis result:`, parsed);
        return parsed;
    } catch (err) {
        console.error('❌ [Gemini Vision] Screenshot verification failed:', err.message || err);
        return null; // Fallback: null means Gemini couldn't analyze it
    }
};

// ==========================================
// 🤖 CORE WHATSAPP SOCKET ENGINE
// ==========================================

const discoverTNGroups = async (sock, phone) => {
    try {
        console.log(`🔍 [Admin +${phone}] Scanning groups for dynamic auto-discovery...`);
        const groups = await sock.groupFetchAllParticipating();
        const tnGroups = [];

        const keywords = [
            "corporate", "protocol", "events", "marketing", "publicity", "awareness", "brand",
            "healthcare", "wellness", "safety", "technical", "engineering", "it support", "support",
            "media", "production", "post-production", "grooming", "aesthetics", "enterprise", 
            "leadership", "business", "strategy", "voice", "audio", "branding", "field", "sales", 
            "activations", "performance", "commercial", "talent", "gatekeeper"
        ];

        for (const [jid, metadata] of Object.entries(groups)) {
            const subject = metadata.subject || '';
            const cleanSubject = subject.toLowerCase();
            
            // 🔔 Auto-detect Admin Alerts Group by name
            if (cleanSubject.includes('bot alert') || cleanSubject.includes('bot alerts')) {
                adminAlertsGroupJid = jid;
                console.log(`🔔 [Alerts] Auto-detected Admin Alerts Group: "${subject}" (${jid})`);
            }

            // Match if it contains TN (with/without space, bracket, or dash) OR contains official niche keywords
            const isTNOfficial = cleanSubject.includes('tn') || keywords.some(kw => cleanSubject.includes(kw));
            
            if (isTNOfficial) {
                tnGroups.push({ jid, subject });
            }
        }


        console.log(`🎯 [Admin +${phone}] Auto-discovered ${tnGroups.length} TN groups.`);
        
        // Update metadata & save
        const sessionMeta = loadSessionMeta();
        if (sessionMeta[phone]) {
            sessionMeta[phone].discoveredGroups = tnGroups;
            saveSessionMeta(sessionMeta);
            
            // Backup updated groups array to Cloud
            triggerSessionBackup(phone, sessionMeta[phone].name, sessionMeta[phone].selectedGroups, tnGroups);
        }

        return tnGroups;
    } catch (err) {
        console.error(`❌ [Admin +${phone}] Group auto-discovery failed:`, err.message || err);
        
        // Auto-retry in 30 seconds to allow message history decryption sync to complete
        if (!sock.discoveryRetryActive) {
            sock.discoveryRetryActive = true;
            console.log(`🔄 [Admin +${phone}] Scheduling group auto-discovery retry in 30 seconds...`);
            setTimeout(async () => {
                try {
                    sock.discoveryRetryActive = false;
                    if (activeSessions[phone]) {
                        await discoverTNGroups(activeSessions[phone], phone);
                    }
                } catch (retryErr) {
                    console.error("❌ Retry discovery error:", retryErr);
                }
            }, 30000);
        }
        return [];
    }

};

// ==========================================
// 🛡️ ANTI-BAN MIDDLEWARE & HELPER FUNCTIONS
// ==========================================

const conversationCooldowns = new Map();
const connectionAttempts = {};

// ==========================================
// 📤 SEQUENTIAL ASYMMETRIC OUTBOUND QUEUE
// ==========================================
// Forces all cold-outreach DMs (join requests, departure nudges) into a
// single-file chronological array with randomized cool-downs between
// processing different users. Reactive messages (Gemini replies,
// approvals, screenshot nudges) bypass this queue entirely.

class OutboundQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
    }

    push(sock, jid, messageContent, label = 'outbound') {
        this.queue.push({ sock, jid, messageContent, label });
        console.log(`📤 [Queue] Task added: ${label} to +${jid.replace(/[^0-9]/g, '')}. Queue depth: ${this.queue.length}`);
        if (!this.processing) this._process();
    }

    async _process() {
        this.processing = true;
        while (this.queue.length > 0) {
            const task = this.queue.shift();
            try {
                console.log(`📤 [Queue] Processing: ${task.label} to +${task.jid.replace(/[^0-9]/g, '')}`);
                await sendAntiBanMessage(task.sock, task.jid, task.messageContent);
            } catch (err) {
                console.error(`❌ [Queue] Task failed (${task.label}):`, err.message || err);
            }

            // Inter-task cool-down: 45s to 120s randomized gap between different users
            if (this.queue.length > 0) {
                const cooldown = Math.floor(Math.random() * (120000 - 45000 + 1)) + 45000;
                console.log(`⏱️ [Queue] Cool-down rest: ${Math.round(cooldown / 1000)}s before next task (${this.queue.length} remaining)...`);
                await delay(cooldown);
            }
        }
        this.processing = false;
        console.log('📤 [Queue] All tasks processed. Queue idle.');
    }
}

const outboundQueue = new OutboundQueue();

// Helper: send alert to Admin Alerts Group (or fallback to bot's own JID)
const sendAdminAlert = async (sock, alertText) => {
    const targetJid = adminAlertsGroupJid || (sock.user?.id ? (sock.user.id.split(':')[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net') : null);
    if (!targetJid) return;
    try {
        await sock.sendMessage(targetJid, { text: alertText });
    } catch (err) {
        console.error('❌ [Admin Alert] Failed to send alert:', err.message || err);
    }
};

// Transforms "{Hello|Hi|Greetings} admin" into a randomized variation to mask string filters
function applySpintax(text) {
    const spintaxPattern = /\{([^}]+)\}/g;
    return text.replace(spintaxPattern, (match, options) => {
        const choices = options.split('|');
        return choices[Math.floor(Math.random() * choices.length)];
    });
}

// Simulates realistic human pacing, typing indicators, and read receipts
async function sendAntiBanMessage(sock, jid, messageContent) {
    try {
        // Trigger composing presence state
        await sock.sendPresenceUpdate('composing', jid);

        // Gaussian Jitter (Variable Typing Speed Delay)
        const textLength = messageContent.text ? messageContent.text.length : 50;
        const baseTypingDelay = 1500 + (textLength * 15); // 1.5s base + 15ms per character
        
        // Add random variance (-400ms to +1200ms) to destroy predictable bot patterns
        const patternShatterVariance = Math.floor(Math.random() * 1600) - 400;
        const finalDelay = Math.max(2500, baseTypingDelay + patternShatterVariance); 

        // Sleep during typing phase
        await delay(finalDelay);

        // Turn off typing status and instantly dispatch
        await sock.sendPresenceUpdate('paused', jid);
        
        // Content Variation (Spintax) for standard text
        if (messageContent.text) {
            messageContent.text = applySpintax(messageContent.text);
        }

        return await sock.sendMessage(jid, messageContent);

    } catch (error) {
        console.error("Anti-Ban Middleware error, falling back to direct send:", error);
        return await sock.sendMessage(jid, messageContent);
    }
}


const initializeAdminSocket = async (adminName, phone, selectedGroups = []) => {
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const sessionDir = `auth_session_${cleanPhone}`;
    
    // Close existing socket if already open to prevent memory leaks and duplicate connection loops
    if (activeSessions[cleanPhone]) {
        console.log(`🔌 [Admin: ${adminName}] Ending existing active connection loop for +${cleanPhone} to start fresh.`);
        try {
            activeSessions[cleanPhone].ev.removeAllListeners();
            activeSessions[cleanPhone].end();
        } catch (e) {
            console.error("❌ Error closing active socket:", e);
        }
        delete activeSessions[cleanPhone];
    }

    console.log(`⚙️ [Admin: ${adminName}] Spawning connection loop for +${cleanPhone}`);
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1017578297] }));

    const sock = makeWASocket({
        version,
        logger: P({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        browser: ["Windows", "Chrome", "122.0.0.0"],
        keepAliveIntervalMs: 30000,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000
    });


    activeSessions[cleanPhone] = sock;

    // Trigger backup on creds update
    sock.ev.on('creds.update', async () => {
        await saveCreds();
        const meta = loadSessionMeta()[cleanPhone] || {};
        triggerSessionBackup(cleanPhone, adminName, selectedGroups, meta.discoveredGroups || []);
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`📡 [Admin: ${adminName}] Live QR Code captured for web dashboard scan!`);
            activeQRs[cleanPhone] = qr;
        }


        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode || 
                           lastDisconnect?.error?.statusCode || 
                           null;

            
            const shouldReconnect = reason !== DisconnectReason.loggedOut;
            console.log(`🔌 [Admin: ${adminName}] Socket closed. Reason: ${reason}. Reconnecting: ${shouldReconnect}`);

            if (reason === DisconnectReason.loggedOut) {
                console.log(`🚨 [Admin: ${adminName}] Device logged out from phone. Cleaning database...`);
                delete activeSessions[cleanPhone];
                delete connectionAttempts[cleanPhone];
                
                const meta = loadSessionMeta();
                delete meta[cleanPhone];
                saveSessionMeta(meta);

                // Delete from Supabase
                if (supabase) {
                    await supabase.from('gatekeeper_sessions').delete().eq('phone', cleanPhone);
                }

                fs.rm(sessionDir, { recursive: true, force: true }, (err) => {
                    if (err) console.error(`❌ Failed to delete folder ${sessionDir}:`, err);
                });
            } else {
                connectionAttempts[cleanPhone] = (connectionAttempts[cleanPhone] || 0) + 1;
                const backoffDelay = Math.min(5000 * connectionAttempts[cleanPhone], 90000); // starts at 5s, caps at 1.5 minutes
                console.warn(`🔌 [Admin: ${adminName}] Connection dropped. Throttling reconnect sequence. Retrying in ${backoffDelay / 1000}s...`);
                setTimeout(() => initializeAdminSocket(adminName, cleanPhone, selectedGroups), backoffDelay);
            }
        } else if (connection === 'open') {
            console.log(`🚀 [Admin: ${adminName}] Authenticated successfully!`);
            delete activeQRs[cleanPhone];
            connectionAttempts[cleanPhone] = 0; // Reset network retry metrics
            // Wait 10 seconds for WhatsApp group synchronization before scanning

            setTimeout(async () => {
                try {
                    if (activeSessions[cleanPhone]) {
                        await discoverTNGroups(activeSessions[cleanPhone], cleanPhone);
                    }
                } catch (e) {
                    console.error("❌ Group discovery delayed error:", e);
                }
            }, 10000);
        }

    });

    // 🚪 DEPARTURE PROTOCOL: Capture left/removed group members, alert admins, optional safe departure nudge
    sock.ev.on('group-participants.update', async (anu) => {
        const groupJid = anu.id;
        const action = anu.action;

    // 🔄 AUTO-RESCAN: Also fires when bot creates a group (groups.upsert catches group creation)
    sock.ev.on('groups.upsert', async (newGroups) => {
        console.log(`🔄 [Auto-Rescan] New group(s) detected via groups.upsert. Re-scanning in 5s...`);
        setTimeout(async () => {
            try {
                await discoverTNGroups(sock, cleanPhone);
            } catch (e) {
                console.error('❌ [Auto-Rescan] Failed:', e.message || e);
            }
        }, 5000);
    });

        // 🔄 AUTO-RESCAN: When the bot is added to a new group, re-discover all groups
        if (action === 'add') {
            const botJid = sock.user?.id ? (sock.user.id.split(':')[0] + '@s.whatsapp.net') : null;
            const botWasAdded = botJid && anu.participants.includes(botJid);
            if (botWasAdded) {
                console.log(`🔄 [Auto-Rescan] Bot was added to a new group (${groupJid}). Re-scanning all groups in 5s...`);
                setTimeout(async () => {
                    try {
                        await discoverTNGroups(sock, cleanPhone);
                    } catch (e) {
                        console.error('❌ [Auto-Rescan] Failed:', e.message || e);
                    }
                }, 5000);
            }
        }
        
        if (action === 'remove' || action === 'leave') {
            const participants = anu.participants;
            for (const participant of participants) {
                // Ignore bot self-exit
                const botJid = sock.user?.id ? (sock.user.id.split(':')[0] + '@s.whatsapp.net') : null;
                if (botJid && participant === botJid) continue;
                
                // Ensure this group is monitored
                const meta = loadSessionMeta()[cleanPhone] || {};
                const isMonitoredGroup = selectedGroups.includes(groupJid) || 
                                         (meta.discoveredGroups && meta.discoveredGroups.some(g => g.jid === groupJid));
                if (!isMonitoredGroup) continue;
                
                // Find group name
                let groupName = "our group";
                if (meta.discoveredGroups) {
                    const matchedGroup = meta.discoveredGroups.find(g => g.jid === groupJid);
                    if (matchedGroup) groupName = matchedGroup.subject;
                }
                
                console.log(`🚶 Member ${participant} left group ${groupName} (${groupJid})`);
                
                // Clear their approved/pending logs from registry & Supabase so they can re-join cleanly!
                const registryKey = `${groupJid}_${participant.replace('@s.whatsapp.net', '').replace('@lid', '')}`;
                const registry = loadRegistry();
                if (registry[registryKey]) {
                    console.log(`🗑️ [Retention] Wiping registry entry for ${participant} to reset re-join approval status.`);
                    delete registry[registryKey];
                    saveRegistry(registry);
                    
                    if (supabase) {
                        try {
                            await supabase.from('gatekeeper_registry').delete().eq('key', registryKey);
                            console.log(`✅ [Supabase] Deleted cloud registry lock: ${registryKey}`);
                        } catch (e) {
                            console.error("❌ Failed to delete cloud registry key:", e);
                        }
                    }
                }

                // Departure alert — only fire for @s.whatsapp.net JIDs (real phone numbers)
                // Skip @lid JIDs since we can't resolve their actual phone number
                if (participant.endsWith('@s.whatsapp.net')) {
                    const phoneNumber = participant.split('@')[0];
                    const alertText = `⚠️ *[Departure Alert]* ⚠️\n\nMember +${phoneNumber} has left or been removed from *${groupName}*.\n\nTheir verification lock has been wiped so they can re-join and verify again if needed.`;
                    await sendAdminAlert(sock, alertText);
                } else {
                    console.log(`⚠️ [Departure] Skipping alert for LID participant ${participant} (no phone number available).`);
                }

                // 🚪 SAFE DEPARTURE NUDGE (Disabled by default — flip ENABLE_DEPARTURE_NUDGE to true)
                // Only sends if: flag is on, user hasn't been nudged before (one-strike rule)
                if (ENABLE_DEPARTURE_NUDGE && !departureNudgedUsers.has(participant)) {
                    departureNudgedUsers.add(participant);
                    const departureNudge = `{Hey|Hi|Hello} {there|}, {we noticed you left|it looks like you exited} *${groupName}*.\n\n{We'd love to know if there's anything we could improve|Is there anything we could have done better}? {Feel free to rejoin anytime|You're always welcome back}! 🙏`;
                    
                    // Push through outbound queue with built-in cool-down delays
                    outboundQueue.push(sock, participant, { text: departureNudge }, 'departure-nudge');
                    console.log(`🚪 [Departure] Nudge queued for +${participant.replace(/[^0-9]/g, '')}`);
                }
            }
        }
    });


    // 🛡️ NATIVE INTERCEPTION: Capture join requests
    sock.ev.on('group.join-request', async (request) => {
        const incomingGroupJID = request.id;
        const participant = request.participant;
        if (!participant) return;

        const cleanSender = participant.replace('@s.whatsapp.net', '').replace('@lid', '');
        const registryKey = `${incomingGroupJID}_${cleanSender}`;

        // Ensure this group is monitored
        const meta = loadSessionMeta()[cleanPhone] || {};
        const isMonitoredGroup = selectedGroups.includes(incomingGroupJID) || 
                                 (meta.discoveredGroups && meta.discoveredGroups.some(g => g.jid === incomingGroupJID));

        if (!isMonitoredGroup) return;

        // Check registry for double-trigger lock (allow retry if status is 'pending' and lock is older than 2 minutes)
        const registry = loadRegistry();
        const existingRequest = registry[registryKey];
        if (existingRequest) {
            const lockTime = new Date(existingRequest.timestamp).getTime();
            const timeElapsedMs = Date.now() - lockTime;
            
            // If they are already approved, skip them entirely
            if (existingRequest.status === 'approved') {
                console.log(`🛑 User +${cleanSender} is already APPROVED in group ${incomingGroupJID}. Skipping.`);
                return;
            }
            
            // If it is 'pending' but was created more than 2 minutes (120000ms) ago, allow a retry!
            const isStaleLock = existingRequest.status === 'pending' && timeElapsedMs > 120000;
            
            if (!isStaleLock) {
                console.log(`🛑 Request already active/processing by Admin ${existingRequest.admin}. Status: ${existingRequest.status}. Skipping duplicate trigger.`);
                return;
            } else {
                console.log(`🔄 Stale pending lock detected for user +${cleanSender} (created ${Math.round(timeElapsedMs / 1000)}s ago). Re-triggering verification...`);
            }
        }


        // Detect group type from name
        let groupName = '';
        const currentMeta = loadSessionMeta()[cleanPhone] || {};
        if (currentMeta.discoveredGroups) {
            const matchedGroup = currentMeta.discoveredGroups.find(g => g.jid === incomingGroupJID);
            if (matchedGroup) groupName = matchedGroup.subject;
        }
        const isBizHub = isBusinessHubGroup(groupName);

        // Lock the registry with group type
        const item = {
            admin: adminName,
            phone: cleanPhone,
            groupJid: incomingGroupJID,
            groupType: isBizHub ? 'business_hub' : 'standard',
            status: 'pending',
            timestamp: new Date().toISOString()
        };
        await saveRegistryItem(registryKey, item);
        console.log(`🎯 [Admin: ${adminName}] Lock acquired for +${cleanSender} in "${groupName}" [Type: ${item.groupType}]`);

        // Pacing human simulation delays (15 to 40 seconds)
        const randomDelay = Math.floor(Math.random() * (40 - 15 + 1) + 15) * 1000;
        console.log(`⏳ [Admin: ${adminName}] Delaying messaging for ${randomDelay / 1000}s...`);
        await delay(randomDelay);

        // Typing simulation
        await sock.sendPresenceUpdate('composing', participant);
        await delay(6000);
        await sock.sendPresenceUpdate('paused', participant);

        // Route initial DMs through the Sequential Outbound Queue (cold outreach = highest ban risk)
        if (isBizHub) {
            const adminRole = (loadSessionMeta()[cleanPhone] || {}).role || 'Admin';
            console.log(`🏢 [Admin: ${adminName}] Business Hub intro DM queued for +${cleanSender}`);
            outboundQueue.push(sock, participant, { text: BUSINESS_HUB_INTRO_MESSAGE() }, 'biz-hub-intro');
        } else {
            console.log(`✉️ [Admin: ${adminName}] Requirement guidelines DM queued for +${cleanSender}`);
            outboundQueue.push(sock, participant, { text: GATEKEEPER_MESSAGE }, 'join-request-dm');
        }
    });

    // 🎯 SCREENSHOT VERIFICATION & TEXT TRIGGERS
    sock.ev.on('messages.upsert', async (m) => {
        if (!m.messages || m.messages.length === 0) return;

        // Helper: send reminder nudge if they sent only 1 screenshot
        const sendReminderNudge = async (jid) => {
            console.log(`⚠️ User +${jid.replace('@s.whatsapp.net', '')} only submitted 1 proof. Sending nudge.`);
            try {
                await sendAntiBanMessage(sock, jid, {
                    text: `⚠️ *GATEKEEPER NOTICE* ⚠️\n\nWe received 1 screenshot, but we require at least **2 screenshots** to verify all tasks (TikTok follow, Facebook/Instagram follow, and WhatsApp Channel join).\n\nPlease send the remaining screenshot(s) so we can automatically approve you! 📸✨`
                });
            } catch (err) {
                console.error("❌ Failed to send reminder nudge:", err);
            }
        };

        // Approval mutex — prevents race conditions when 2 screenshots arrive simultaneously
        const approvalInProgress = new Set();

        // Helper: execute dynamic entry approval
        const executeApproval = async (jid, targetGroupJid, registryKey) => {
            // Mutex check — if already approving this user, skip duplicate call
            if (approvalInProgress.has(jid)) {
                console.log(`🔒 [Approval] Already processing approval for ${jid}. Skipping duplicate.`);
                return;
            }
            approvalInProgress.add(jid);
            console.log(`🔓 Criteria verified! Approving ${jid} into group ${targetGroupJid}`);
            
            await sock.sendPresenceUpdate('composing', jid);
            await delay(2000);
            await sock.sendPresenceUpdate('paused', jid);

            try {
                // Execute automatic cloud approval
                await sock.groupRequestParticipantsUpdate(targetGroupJid, [jid], 'approve');
                
                // Confirm entry via DM
                await sendAntiBanMessage(sock, jid, { 
                    text: `🎉 AUTOMATED VERIFICATION SUCCESSFUL!\n\nYour screenshot evidence has been validated. You have been successfully approved into the group. Welcome elite! 👋✨` 
                });

                // Update registry status to approved
                const registry = loadRegistry();
                if (registry[registryKey]) {
                    registry[registryKey].status = 'approved';
                    await saveRegistryItem(registryKey, registry[registryKey]);
                }
            } catch (err) {
                // internal-server-error usually means WhatsApp already processed the request
                // (user was manually approved or request expired) — not a real failure
                if (err.message && err.message.includes('internal-server-error')) {
                    console.log(`⚠️ [Approval] WhatsApp returned internal-server-error for ${jid}. User may already be approved or request expired.`);
                    // Still mark as approved in registry to prevent re-processing
                    const registry = loadRegistry();
                    if (registry[registryKey]) {
                        registry[registryKey].status = 'approved';
                        await saveRegistryItem(registryKey, registry[registryKey]);
                    }
                } else {
                    console.error(`❌ [Approval] Failed for ${jid}:`, err.message || err);
                }
            } finally {
                approvalInProgress.delete(jid);
            }
        };

        // Process message packets
        for (const msg of m.messages) {
            if (!msg || msg.key.fromMe) continue;

            const senderJid = msg.key.remoteJid;
            if (!senderJid || (!senderJid.endsWith('@s.whatsapp.net') && !senderJid.endsWith('@lid'))) continue;

            // Extract content safely
            let messageContent = msg.message;
            if (messageContent?.ephemeralMessage) messageContent = messageContent.ephemeralMessage.message;
            if (messageContent?.viewOnceMessage) messageContent = messageContent.viewOnceMessage.message;
            if (messageContent?.viewOnceMessageV2) messageContent = messageContent.viewOnceMessageV2.message;
            if (messageContent?.documentWithCaptionMessage) messageContent = messageContent.documentWithCaptionMessage.message;

            const textInput = messageContent?.conversation || 
                              messageContent?.extendedTextMessage?.text || 
                              messageContent?.imageMessage?.caption || 
                              '';

            // Detect if this is an image message early (needed for rate limit exemption)
            const isImageMessage = !!(messageContent?.imageMessage || 
                            messageContent?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage ||
                            (messageContent?.documentMessage && messageContent.documentMessage.mimetype?.startsWith('image/')));

            // Anti-Ban Rate Limiting & Cooldowns
            // EXEMPTIONS from rate limiter:
            // 1. Image messages from users with a pending join request (multi-screenshot submission)
            // 2. Business Hub users mid-conversation (never drop Gemini interview replies)
            const hasPendingRequest = !!findPendingRequest(senderJid);
            const hasBizHubConversation = !!findBusinessHubRequest(senderJid);
            const now = Date.now();
            const cooldownKey = `${cleanPhone}_${senderJid}`;
            if (conversationCooldowns.has(cooldownKey)) {
                const lastMessageTime = conversationCooldowns.get(cooldownKey);
                const isExempt = (isImageMessage && hasPendingRequest) || hasBizHubConversation;
                if (now - lastMessageTime < 3000 && !isExempt) {
                    console.log(`⚠️ [Anti-Ban] Rate limit tripped for user +${senderJid.replace(/[^0-9]/g, '')} on Admin node +${cleanPhone}. Drop execution.`);
                    continue; 
                }
            }
            conversationCooldowns.set(cooldownKey, now);

            // 🏢 BUSINESS HUB: Route to Gemini AI if sender has an active Business Hub intake
            if (geminiModel && textInput.trim().length > 0) {
                // Check if this user has been flagged for human takeover
                const userPhone = senderJid.replace('@s.whatsapp.net', '').replace('@lid', '');
                if (humanTakeoverUsers.has(userPhone)) {
                    console.log(`🔒 [Business Hub] User +${userPhone} is flagged for HUMAN TAKEOVER. Skipping AI routing.`);
                    continue; // Admin handles this user manually now
                }

                const bizHubRequest = findBusinessHubRequest(senderJid);
                if (bizHubRequest) {
                    console.log(`🤖 [Business Hub] Routing reply from +${senderJid.replace('@s.whatsapp.net', '')} to Gemini AI intake engine...`);
                    await handleBusinessHubConversation(sock, senderJid, textInput, bizHubRequest, adminName);
                    continue;
                }
            }

            // Admin Keyword Locking ("Ken")
            if (textInput.toLowerCase().includes('ken')) {
                console.log(`🔒 Keyword Match: Thread +${senderJid.replace('@s.whatsapp.net', '')} routed manually.`);
                await sendAntiBanMessage(sock, senderJid, {
                    text: `⚙️ Verification File Locked. Assigned Admin: Ken. Please provide your verification screenshots below.`
                });
                continue;
            }

            // Image message processing
            const isImage = messageContent?.imageMessage || 
                            messageContent?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage ||
                            (messageContent?.documentMessage && messageContent.documentMessage.mimetype?.startsWith('image/'));

            if (isImage) {
                // Find matching registration
                const pendingRequest = findPendingRequest(senderJid);
                if (!pendingRequest) continue;

                console.log(`📸 Screenshot captured from candidate: ${senderJid} for group: ${pendingRequest.groupJid}`);

                // Initialize verification tracker for this user if not exists
                if (!pendingVerifications.has(senderJid)) {
                    pendingVerifications.set(senderJid, { tiktok: false, social: false, channel: false, screenshotCount: 0 });
                }
                const verification = pendingVerifications.get(senderJid);
                verification.screenshotCount += 1;

                // Attempt Gemini Vision verification on the screenshot
                let geminiResult = null;
                try {
                    const imageMsg = messageContent?.imageMessage || messageContent?.documentMessage;
                    if (imageMsg) {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        const mime = imageMsg.mimetype || 'image/jpeg';
                        geminiResult = await verifyScreenshotWithGemini(buffer, mime);
                    }
                } catch (dlErr) {
                    console.error('❌ [Gemini Vision] Failed to download/analyze image:', dlErr.message || dlErr);
                }

                if (geminiResult) {
                    // Merge Gemini results into cumulative tracker
                    if (geminiResult.tiktok) verification.tiktok = true;
                    if (geminiResult.social) verification.social = true;
                    if (geminiResult.channel) verification.channel = true;

                    // Count how many tasks are verified
                    const verifiedCount = [verification.tiktok, verification.social, verification.channel].filter(Boolean).length;
                    console.log(`🔍 [Verification] User +${senderJid.replace(/[^0-9]/g, '')} status: TikTok=${verification.tiktok}, Social=${verification.social}, Channel=${verification.channel} — ${verifiedCount}/3 tasks (need any 2)`);

                    // ✅ APPROVE if any 2 out of 3 tasks are verified
                    if (verifiedCount >= 2) {
                        pendingVerifications.delete(senderJid);
                        pendingApprovals.delete(senderJid);
                        await executeApproval(senderJid, pendingRequest.groupJid, pendingRequest.key);
                        continue;
                    }

                    // Build list of tasks NOT yet verified (for the nudge)
                    const notVerified = [];
                    if (!verification.tiktok) notVerified.push('Follow our *TikTok* account');
                    if (!verification.social) notVerified.push('Follow our *Facebook/Instagram* page');
                    if (!verification.channel) notVerified.push('Join our *WhatsApp Channel*');

                    // Clear any existing timer and nudge with smart message
                    if (pendingApprovals.has(senderJid)) {
                        clearTimeout(pendingApprovals.get(senderJid).timer);
                    }
                    const entry = pendingApprovals.get(senderJid) || { screenshotCount: verification.screenshotCount, timer: null };
                    entry.screenshotCount = verification.screenshotCount;
                    entry.timer = setTimeout(async () => {
                        console.log(`⚠️ [Gemini Vision] Nudging user +${senderJid.replace(/[^0-9]/g, '')} — only ${verifiedCount}/3 tasks verified`);
                        await sendAntiBanMessage(sock, senderJid, {
                            text: `⚠️ *GATEKEEPER NOTICE* ⚠️\n\n{Thanks for the screenshot|We received your screenshot}! You need to complete *any 2* of the following tasks to be approved:\n\n${notVerified.map(t => `• ${t}`).join('\n')}\n\nPlease send a screenshot proving you completed {at least one more|another} task and we will approve you instantly! 📸✨`
                        });
                    }, 20000);
                    pendingApprovals.set(senderJid, entry);

                } else {
                    // FALLBACK: Gemini unavailable — use legacy count-based approval (≥ 2 screenshots)
                    console.log(`⚠️ [Fallback] Gemini Vision unavailable. Using count-based approval (${verification.screenshotCount}/2).`);

                    if (pendingApprovals.has(senderJid)) {
                        const pending = pendingApprovals.get(senderJid);
                        pending.screenshotCount = verification.screenshotCount;
                        clearTimeout(pending.timer);

                        if (pending.screenshotCount >= 2) {
                            pending.timer = setTimeout(async () => {
                                pendingApprovals.delete(senderJid);
                                pendingVerifications.delete(senderJid);
                                await executeApproval(senderJid, pendingRequest.groupJid, pendingRequest.key);
                            }, 2000);
                        } else {
                            pending.timer = setTimeout(async () => {
                                pending.timer = null;
                                await sendReminderNudge(senderJid);
                            }, 25000);
                        }
                    } else {
                        const entry = { screenshotCount: 1, timer: null };
                        pendingApprovals.set(senderJid, entry);
                        entry.timer = setTimeout(async () => {
                            entry.timer = null;
                            await sendReminderNudge(senderJid);
                        }, 25000);
                    }
                }
            }
        }
    });

    return sock;
};

// ==========================================
// 🔌 AUTO-SESSION RECOVERY ON SERVER BOOT
// ==========================================

const recoverAllSessions = async () => {
    console.log("⏱️ Initiating system recovery sequence...");
    
    // 🧹 PRE-EMPTIVE CLEANUP: Completely wipe the test user's lock from Supabase cloud database
    // BEFORE downloading registry and BEFORE launching connection loops! This completely prevents any race conditions!
    if (supabase) {
        console.log("🧹 [Startup Clean] Pre-emptively deleting test lock key from Supabase cloud database...");
        try {
            await supabase.from('gatekeeper_registry').delete().eq('key', '120363428438604848@g.us_271824470417590');
            console.log("🧹 [Startup Clean] Cloud lock cleared successfully!");
        } catch (e) {
            console.error("❌ Pre-emptive cloud wipe failed:", e);
        }
    }
    
    // Clean local disk registry key too
    const testKey = '120363428438604848@g.us_271824470417590';
    let registry = loadRegistry();
    if (registry[testKey]) {
        console.log("🧹 [Startup Clean] Deleting test lock from local registry.json disk...");
        delete registry[testKey];
        saveRegistry(registry);
    }

    let meta = loadSessionMeta();

    
    if (supabase) {
        console.log("📡 [Supabase] Synchronizing database backups to disk...");
        try {
            // Restore sessions
            const { data: dbSessions, error: sessErr } = await supabase
                .from('gatekeeper_sessions')
                .select('*');
            
            if (sessErr) {
                console.error("❌ [Supabase] Failed to fetch sessions from cloud:", sessErr.message);
            } else if (dbSessions) {
                console.log(`🤖 [Supabase] Restoring ${dbSessions.length} active sessions from database...`);
                for (const session of dbSessions) {
                    const phone = session.phone;
                    const dirPath = `auth_session_${phone}`;
                    
                    // Recreate folder structures from backup ONLY if not present locally
                    if (!fs.existsSync(dirPath)) {
                        console.log(`📥 [Supabase] Restoring session backup for +${phone} from cloud...`);
                        deserializeDirectory(dirPath, session.files);
                    } else {
                        console.log(`💾 [Supabase] Local session folder for +${phone} already exists. Skipping cloud restore to protect active keys.`);
                    }
                    
                    // Sync local session metadata configuration
                    meta[phone] = {
                        name: session.admin_name,
                        selectedGroups: session.selected_groups,
                        discoveredGroups: session.discovered_groups,
                        timestamp: session.updated_at
                    };
                }
                saveSessionMeta(meta);

            }

            // Restore double-trigger registry logs
            const { data: dbRegistry, error: regErr } = await supabase
                .from('gatekeeper_registry')
                .select('*');
            
            if (regErr) {
                console.error("❌ [Supabase] Failed to fetch registry logs:", regErr.message);
            } else if (dbRegistry) {
                for (const reg of dbRegistry) {
                    registry[reg.key] = {
                        admin: reg.admin_name,
                        phone: reg.phone,
                        groupJid: reg.group_jid,
                        status: reg.status,
                        timestamp: reg.timestamp
                    };
                }
                saveRegistry(registry);
            }
        } catch (err) {
            console.error("❌ [Supabase] Error during synchronization:", err);
        }
    } else {
        // Local directory fallback
        const directories = fs.readdirSync('./');
        const savedPhones = directories.filter(d => d.startsWith('auth_session_') && fs.lstatSync(d).isDirectory())
                                       .map(d => d.replace('auth_session_', ''));
        
        for (const phone of savedPhones) {
            if (!meta[phone]) {
                meta[phone] = { name: "System Admin Recovery", selectedGroups: [] };
            }
        }
    }
    
    // Trigger sockets connections
    const activeAdminPhones = Object.keys(meta);
    console.log(`🔌 Restoring connection loops for ${activeAdminPhones.length} verified admin nodes...`);
    for (const phone of activeAdminPhones) {
        const metadata = meta[phone];
        await initializeAdminSocket(metadata.name, phone, metadata.selectedGroups);
    }
};

// Trigger boot-up sync
recoverAllSessions().catch(e => console.error("❌ Recovery sequence failed:", e));

// ==========================================
// 🧹 24-HOUR REGISTRY PRUNING CRON
// ==========================================
// Automatically clean stale 'pending' registry entries older than 72 hours

const pruneStaleRegistryEntries = async () => {
    console.log('🧹 [Pruning] Running 24-hour registry cleanup...');
    const registry = loadRegistry();
    const now = Date.now();
    const STALE_THRESHOLD = 72 * 60 * 60 * 1000; // 72 hours in ms
    let pruneCount = 0;

    for (const [key, entry] of Object.entries(registry)) {
        if (entry.status === 'pending' && entry.timestamp) {
            const entryAge = now - new Date(entry.timestamp).getTime();
            if (entryAge > STALE_THRESHOLD) {
                console.log(`🧹 [Pruning] Deleting stale entry: ${key} (age: ${Math.round(entryAge / 3600000)}h)`);
                delete registry[key];
                pruneCount++;

                // Also clean from Supabase
                if (supabase) {
                    try {
                        await supabase.from('gatekeeper_registry').delete().eq('key', key);
                    } catch (e) {
                        console.error(`❌ [Pruning] Failed to delete cloud key ${key}:`, e.message);
                    }
                }
            }
        }
    }

    if (pruneCount > 0) {
        saveRegistry(registry);
        console.log(`🧹 [Pruning] Cleaned ${pruneCount} stale registry entries.`);
    } else {
        console.log('🧹 [Pruning] No stale entries found. Registry is clean.');
    }
};

// Run pruning every 24 hours
setInterval(pruneStaleRegistryEntries, 24 * 60 * 60 * 1000);
// Also run once on boot after a short delay
setTimeout(pruneStaleRegistryEntries, 30000);

// ==========================================
// 🌐 EXPRESS WEB PORTAL REST API
// ==========================================

app.get('/ping', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('🚀 TN Connect Gatekeeper (v1.2 Central Server) is live and running 24/7!');
});

app.get('/api/sessions', (req, res) => {
    const meta = loadSessionMeta();
    const result = Object.keys(meta).map(phone => ({
        phone,
        name: meta[phone].name,
        monitoredGroupsCount: meta[phone].selectedGroups?.length || 0,
        discoveredGroups: meta[phone].discoveredGroups || [],
        connected: !!activeSessions[phone] && !!activeSessions[phone].authState?.creds?.registered,
        qr: activeQRs[phone] || null
    }));
    res.json(result);
});



app.post('/api/auth/request-code', async (req, res) => {
    const { adminName, adminPhone, selectedGroups, method, adminRole } = req.body;
    if (!adminPhone || !adminName) {
        return res.status(400).json({ error: "Admin Name and WhatsApp phone number required!" });
    }

    let cleanPhone = adminPhone.replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('0')) {
        cleanPhone = '233' + cleanPhone.substring(1);
    } else if (!cleanPhone.startsWith('233')) {
        cleanPhone = '233' + cleanPhone;
    }

    console.log(`📡 Spawning dynamic authentication process (${method || 'pairing-code'}) for +${cleanPhone}...`);


    try {
        // Save metadata configuration
        const meta = loadSessionMeta();
        meta[cleanPhone] = {
            name: adminName,
            role: adminRole || 'Admin',
            selectedGroups: selectedGroups || [],
            timestamp: new Date().toISOString()
        };
        saveSessionMeta(meta);

        // Spawns connection
        const sock = await initializeAdminSocket(adminName, cleanPhone, selectedGroups || []);

        if (sock.authState.creds.registered) {
            return res.json({ status: "CONNECTED", message: "Admin socket is already connected!" });
        }

        if (method === 'qr') {
            return res.json({ status: "AWAITING_QR", message: "QR Code initialized. Scan to link!" });
        }

        // Default to pairing code
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(cleanPhone);
                return res.json({ pairingCode: code });
            } catch (pairingError) {
                console.error("❌ Failed to request pairing code:", pairingError);
                return res.status(500).json({ error: "Pairing service timeout. Try again." });
            }
        }, 6000);
    } catch (err) {


        console.error("❌ Express request-code error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sessions/:phone/disconnect', async (req, res) => {
    const { phone } = req.params;
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    
    console.log(`🔌 [Dashboard] Request to disconnect session +${cleanPhone}...`);
    
    // Close and remove socket connection
    if (activeSessions[cleanPhone]) {
        try {
            await activeSessions[cleanPhone].logout();
        } catch (e) {
            console.log("⚠️ Session logout error (already closed?):", e.message);
            try {
                activeSessions[cleanPhone].end();
            } catch (endErr) {}
        }
        delete activeSessions[cleanPhone];
        delete activeQRs[cleanPhone];
    }

    
    // Remove local metadata
    const meta = loadSessionMeta();
    delete meta[cleanPhone];
    saveSessionMeta(meta);
    
    // Clean up Supabase
    if (supabase) {
        try {
            const { error } = await supabase
                .from('gatekeeper_sessions')
                .delete()
                .eq('phone', cleanPhone);
            if (error) console.error("❌ [Supabase] Failed to delete session record:", error.message);
            else console.log(`✅ [Supabase] Deleted credentials backup for +${cleanPhone}`);
        } catch (dbErr) {
            console.error("❌ [Supabase] DB delete error:", dbErr.message);
        }
    }
    
    // Delete local authentication credentials folder
    const sessionDir = `auth_session_${cleanPhone}`;
    fs.rm(sessionDir, { recursive: true, force: true }, (err) => {
        if (err) console.error(`❌ Failed to delete folder ${sessionDir}:`, err);
        else console.log(`🗑️ Cleaned up local directory: ${sessionDir}`);
    });
    
    res.json({ success: true, message: "Logged out and wiped session successfully!" });
});

// ==========================================
// 🏢 BUSINESS HUB APPLICANTS API
// ==========================================
app.get('/api/business-hub/applicants', (req, res) => {
    const applicants = loadApplicants();
    res.json(applicants);
});

app.delete('/api/business-hub/applicants/:id', (req, res) => {
    const { id } = req.params;
    let applicants = loadApplicants();
    applicants = applicants.filter(a => String(a.id) !== String(id));
    try {
        fs.writeFileSync(APPLICANTS_FILE, JSON.stringify(applicants, null, 2));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete applicant' });
    }
});

// ==========================================
// ⚙️ GROUP FLOWS CONFIG API
// ==========================================
const loadGroupFlows = () => {
    if (!fs.existsSync(GROUP_FLOWS_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(GROUP_FLOWS_FILE, 'utf-8')); }
    catch (e) { return {}; }
};

app.get('/api/group-flows', (req, res) => {
    res.json(loadGroupFlows());
});

app.post('/api/group-flows', (req, res) => {
    const flows = req.body;
    try {
        fs.writeFileSync(GROUP_FLOWS_FILE, JSON.stringify(flows, null, 2));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to save group flows' });
    }
});


// Self-ping to prevent sleep
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_EXTERNAL_URL) {
    console.log(`⏱️ Keep-alive loop active targeting: ${RENDER_EXTERNAL_URL}`);
    setInterval(() => {
        https.get(`${RENDER_EXTERNAL_URL}/ping`, (res) => {
            console.log(`💓 Heartbeat ping dispatched. Status code: ${res.statusCode}`);
        }).on('error', (err) => {
            console.error('❌ Heartbeat ping failed:', err.message);
        });
    }, 10 * 60 * 1000);
}

// Start API Server
app.listen(PORT, () => {
    console.log(`📡 TN Gatekeeper Central Server online on port ${PORT}`);
});

// ==========================================
// 🛡️ GLOBAL PRODUCTION PROCESS SHIELD
// ==========================================
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [Process] Unhandled Rejection detected at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err, origin) => {
    console.error('⚠️ [Process] Uncaught Exception thrown:', err, 'origin:', origin);
});
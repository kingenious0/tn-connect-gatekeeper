require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, delay } = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const P = require('pino');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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
const businessHubConversations = new Map(); // Gemini AI conversation history per user (phone -> history[])

const uploadDebounces = {}; // debounces for Supabase credentials upload

// ==========================================
// 🗄️ SUPABASE DATABASE INITIALIZATION
// ==========================================
const supabaseUrl = process.env.SUPABASE_URL || process.env['Project URL'];
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env['anon public key'];
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;


if (supabase) {
    console.log("💾 [Database] Supabase credentials detected! Cloud Backup Engine is ACTIVE.");
} else {
    console.log("⚠️ [Database] Supabase variables missing. Running in OFFLINE / Local File Mode.");
}

// ==========================================
// 📋 OFFICIAL MESSAGES & GROUPS REFERENCE
// ==========================================
const GATEKEEPER_MESSAGE = `*hello, we just got your request to join our group*
🚨ACTION REQUIRED🚨

To be approved into the niche group first join one of the general market groups (tap links in channel to see all the links). 

TikTok: Follow *TN FILMS GH*


We’ll view your chat before approving. If we get to your chat and you’ve not done these we will cancel your request. Follow these steps 

Facebook/Instagram: Follow *TN UNIVERSITIES CONNECT*

WhatsApp Channel: Join our official update channel: https://whatsapp.com/channel/0029VbCNby81CYoPIpEQMD1D
⚠️ Delay = Cancellation. We are clearing the pending list. I

Once you’ve followed all, send a DONE(with a screenshot). 

We are viewing chats before approving. If we get to your chat twice and you’ve not done so we will cancel your request

SEND ME SCREENSHOTS WHEN DONE`;

// Business Hub intro DM (Version B — named admin + role + double-text check)
const BUSINESS_HUB_INTRO_MESSAGE = (adminName, adminRole) =>
`Hello, thanks for requesting to join TN Winneba Business Hub. I'm ${adminName} 📌, ${adminRole || 'Admin'} of TN Uni Connect.

Has any of our admins texted you already? If yes, please reply with the admin's name.

If not, kindly tell us a little about yourself, your business, and where you are located in Winneba. Anything we need to know before you are approved.`;

// Gemini AI system prompt — acts as a professional business intake coordinator
const BUSINESS_HUB_SYSTEM_PROMPT = `You are a professional and warm business intake coordinator for TN Winneba Business Hub, a prestigious networking community for business owners in Winneba, Ghana. You represent the TN Uni Connect admin team.

Your task is to interview business applicants through a natural, human-feeling conversation. You need to collect ALL of the following:
1. Full name
2. Business name
3. Type of business (e.g. restaurant, salon, IT services, etc.)
4. Exact location in Winneba
5. Products or services they offer
6. Whether they are open to partnerships and vacancy sharing
7. How TN members and Ghanaians can benefit from their business

Rules:
- Be warm, professional, and encouraging — like a real human business coordinator, NOT a bot
- Do NOT ask all 7 questions at once. Have a natural flowing conversation
- If someone replies with something vague, short, irrelevant or nonsensical (like a single dot, "ok", "yes", etc.), politely and professionally redirect them and ask for the specific information you need
- Never reveal you are an AI
- Do not use excessive emojis — keep it professional
- Ask one or two things at a time
- Only conclude when you have collected clear, specific answers to ALL 7 points

When ALL 7 points are clearly answered, first send a warm professional closing message telling them their application has been received and an admin will review and get back to them. Then on a NEW LINE, add this exact marker followed immediately (no space) by a valid JSON object:
[INTAKE_COMPLETE]{"name":"...","businessName":"...","businessType":"...","location":"...","services":"...","partnerships":"...","benefit":"..."}`;

// Gemini client + model initialization
const geminiClient = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const geminiModel = geminiClient ? geminiClient.getGenerativeModel({
    model: 'gemini-2.5-flash',
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

// ==========================================
// 🔍 PENDING REQUEST RESOLVER
// ==========================================
const findPendingRequest = (senderJid) => {
    const registry = loadRegistry();
    const cleanSender = senderJid.replace('@s.whatsapp.net', '').replace('@lid', '');
    
    for (const key of Object.keys(registry)) {
        const entry = registry[key];
        // Only match standard screenshot-flow entries (not business hub)
        if (key.includes(cleanSender) && entry.groupType !== 'business_hub' && entry.status !== 'approved') {
            return { key, ...entry };
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
        if (key.includes(cleanSender) && entry.groupType === 'business_hub' && entry.status !== 'interview_complete') {
            return { key, ...entry };
        }
    }
    return null;
};

// Detect if a group name is TN Winneba Business Hub
const isBusinessHubGroup = (groupName) => {
    const name = (groupName || '').toLowerCase();
    return name.includes('winneba business hub') || name.includes('winneba business');
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
    const history = businessHubConversations.get(userPhone) || [];

    // Dynamically retrieve the admin's role from metadata
    const cleanPhone = sock.user?.id ? sock.user.id.split(':')[0].replace(/[^0-9]/g, '') : '';
    const adminRole = cleanPhone ? ((loadSessionMeta()[cleanPhone] || {}).role || 'Admin') : 'Admin';

    // Inject actual admin name and role into Gemini's prompt instructions
    const dynamicInstruction = `${BUSINESS_HUB_SYSTEM_PROMPT}

IMPORTANT CONTEXT FOR YOUR IDENTITY:
- You represent the specific admin named "${adminName}" who is the "${adminRole}" of TN Uni Connect.
- If the applicant mentions they haven't gotten any text from an admin, or asks who you are, explain that you are the virtual intake coordinator assisting ${adminName} (${adminRole}) to gather their business details.
- Never use placeholder texts like "[Your Name]". Introduce yourself dynamically as the assistant or coordinator on behalf of ${adminName}.`;

    try {
        const modelInstance = geminiClient.getGenerativeModel({
            model: 'gemini-2.5-flash',
            systemInstruction: dynamicInstruction
        });
        const chat = modelInstance.startChat({ history });
        const result = await callGeminiWithRetry(chat, textInput);
        const responseText = result.response.text();

        // Check for completion marker
        const INTAKE_MARKER = '[INTAKE_COMPLETE]';
        const isComplete = responseText.includes(INTAKE_MARKER);
        let cleanResponse = responseText;
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

        // Simulate realistic human typing pace
        await sock.sendPresenceUpdate('composing', senderJid);
        await delay(Math.min(cleanResponse.length * 25, 9000));
        await sock.sendPresenceUpdate('paused', senderJid);

        if (cleanResponse) {
            await sock.sendMessage(senderJid, { text: cleanResponse });
        }

        if (isComplete && applicantData) {
            console.log(`✅ [Business Hub] Intake complete for +${userPhone}. Saving applicant data...`);
            await saveApplicant(applicantData);

            // Update registry status so this user is not processed again
            const registry = loadRegistry();
            if (registry[bizHubRequest.key]) {
                registry[bizHubRequest.key].status = 'interview_complete';
                await saveRegistryItem(bizHubRequest.key, registry[bizHubRequest.key]);
            }

            // Clear conversation memory
            businessHubConversations.delete(userPhone);
        }
    } catch (err) {
        console.error('❌ [Gemini] API call failed after retries:', err.message || err);
        try {
            await sock.sendMessage(senderJid, { 
                text: `Ah, my connection was a bit laggy just now. Could you please resend or repeat your last message? Thank you! 🙏` 
            });
        } catch (e) {
            console.error('❌ Failed to send failure notice to user:', e.message);
        }
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

const triggerDepartureNudge = async (sock, participant, groupName, adminName) => {
    try {
        // Humanized pacing delay (10 to 20 seconds before starting typing)
        const delayMs = Math.floor(Math.random() * (20 - 10 + 1) + 10) * 1000;
        console.log(`⏳ [Retention] Scheduling departure nudge to +${participant.replace(/[^0-9]/g, '')} in ${delayMs / 1000}s...`);
        await delay(delayMs);
        
        // Dynamic time-of-day greeting
        const hour = new Date().getHours();
        let greeting = "Hello";
        if (hour < 12) greeting = "Good morning";
        else if (hour < 17) greeting = "Good afternoon";
        else greeting = "Good evening";
        
        const messageText = `${greeting}, 😊\n\nI noticed you recently left our group *${groupName}*.\n\nWe completely understand that groups can sometimes get busy or that priorities change! We want to make sure we are continuously improving our community experience, so if you are comfortable sharing, could you let us know what prompted your decision to leave?\n\nYour feedback is highly valued and will be handled with absolute care. If there is anything we can do to support you better, please let us know! 🌸✨\n\nWarm regards,\n*${adminName}*`;
        
        // Typing status update (exactly 10 seconds)
        await sock.sendPresenceUpdate('composing', participant);
        await delay(10000);
        await sock.sendPresenceUpdate('paused', participant);
        
        // Send the message
        await sock.sendMessage(participant, { text: messageText });
        console.log(`✉️ [Retention] Departure follow-up DM sent successfully to +${participant.replace(/[^0-9]/g, '')}`);
    } catch (err) {
        console.error("❌ [Retention] Failed to send departure nudge:", err);
    }
};


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
        browser: ["Windows", "Chrome", "122.0.0.0"]
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
                setTimeout(() => initializeAdminSocket(adminName, cleanPhone, selectedGroups), 5000);
            }
        } else if (connection === 'open') {
            console.log(`🚀 [Admin: ${adminName}] Authenticated successfully!`);
            delete activeQRs[cleanPhone];
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

    // 🚪 RETENTION PROTOCOL: Capture left/removed group members
    sock.ev.on('group-participants.update', async (anu) => {
        const groupJid = anu.id;
        const action = anu.action;
        
        if (action === 'remove') {
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
                
                console.log(`🚶 Member +${participant.replace(/[^0-9]/g, '')} left group ${groupName} (${groupJid})`);
                
                // Clear their approved/pending logs from registry & Supabase so they can re-join cleanly!
                const registryKey = `${groupJid}_${participant.replace('@s.whatsapp.net', '').replace('@lid', '')}`;
                const registry = loadRegistry();
                if (registry[registryKey]) {
                    console.log(`🗑️ [Retention] Wiping registry entry for +${participant.replace(/[^0-9]/g, '')} to reset re-join approval status.`);
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

                // Trigger human-paced follow-up nudge in background
                triggerDepartureNudge(sock, participant, groupName, adminName);
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

        if (isBizHub) {
            // Business Hub: send professional Version B intro DM with admin name + role
            const adminRole = (loadSessionMeta()[cleanPhone] || {}).role || 'Admin';
            console.log(`🏢 [Admin: ${adminName}] Business Hub intro DM dispatched to +${cleanSender}`);
            await sock.sendMessage(participant, { text: BUSINESS_HUB_INTRO_MESSAGE(adminName, adminRole) });
        } else {
            // Standard groups: full screenshot verification flow
            console.log(`✉️ [Admin: ${adminName}] Requirement guidelines DM sent to +${cleanSender}`);
            await sock.sendMessage(participant, { text: GATEKEEPER_MESSAGE });
        }
    });

    // 🎯 SCREENSHOT VERIFICATION & TEXT TRIGGERS
    sock.ev.on('messages.upsert', async (m) => {
        if (!m.messages || m.messages.length === 0) return;

        // Helper: send reminder nudge if they sent only 1 screenshot
        const sendReminderNudge = async (jid) => {
            console.log(`⚠️ User +${jid.replace('@s.whatsapp.net', '')} only submitted 1 proof. Sending nudge.`);
            try {
                await sock.sendMessage(jid, {
                    text: `⚠️ *GATEKEEPER NOTICE* ⚠️\n\nWe received 1 screenshot, but we require at least **2 screenshots** to verify all tasks (TikTok follow, Facebook/Instagram follow, and WhatsApp Channel join).\n\nPlease send the remaining screenshot(s) so we can automatically approve you! 📸✨`
                });
            } catch (err) {
                console.error("❌ Failed to send reminder nudge:", err);
            }
        };

        // Helper: execute dynamic entry approval
        const executeApproval = async (jid, targetGroupJid, registryKey) => {
            console.log(`🔓 Criteria verified! Approving ${jid} into group ${targetGroupJid}`);
            
            await sock.sendPresenceUpdate('composing', jid);
            await delay(2000);
            await sock.sendPresenceUpdate('paused', jid);

            try {
                // Execute automatic cloud approval
                await sock.groupRequestParticipantsUpdate(targetGroupJid, [jid], 'approve');
                
                // Confirm entry via DM
                await sock.sendMessage(jid, { 
                    text: `🎉 AUTOMATED VERIFICATION SUCCESSFUL!\n\nYour screenshot evidence has been validated. You have been successfully approved into the group. Welcome elite! 👋✨` 
                });

                // Update registry status to approved
                const registry = loadRegistry();
                if (registry[registryKey]) {
                    registry[registryKey].status = 'approved';
                    await saveRegistryItem(registryKey, registry[registryKey]);
                }
            } catch (err) {
                console.error("❌ Action failed or user already approved:", err);
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


            // 🏢 BUSINESS HUB: Route to Gemini AI if sender has an active Business Hub intake
            if (geminiModel && textInput.trim().length > 0) {
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
                await sock.sendMessage(senderJid, {
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

                if (pendingApprovals.has(senderJid)) {
                    const pending = pendingApprovals.get(senderJid);
                    pending.screenshotCount += 1;
                    clearTimeout(pending.timer);

                    if (pending.screenshotCount >= 2) {
                        pending.timer = setTimeout(async () => {
                            pendingApprovals.delete(senderJid);
                            await executeApproval(senderJid, pendingRequest.groupJid, pendingRequest.key);
                        }, 2000); // 2 seconds safety buffer for additional files
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
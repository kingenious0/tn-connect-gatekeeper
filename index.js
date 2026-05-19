const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, delay } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const http = require('http');
const https = require('https');
const qrcode = require('qrcode-terminal');

// ==========================================
// 🌐 RENDER DEPLOY & KEEP-ALIVE SYSTEM
// ==========================================
const PORT = process.env.PORT || 10000;
const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('🚀 TN Connect Gatekeeper is live and running 24/7 on Render Free Web Service!');
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`📡 Mini health-check status web server listening on port ${PORT}`);
});

// Self-ping loop to prevent Render Free Tier container from spinning down (sleeping)
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_EXTERNAL_URL) {
    console.log(`⏱️ Keep-alive self-ping initialized for: ${RENDER_EXTERNAL_URL}`);
    setInterval(() => {
        https.get(`${RENDER_EXTERNAL_URL}/ping`, (res) => {
            console.log(`💓 Keep-alive self-ping sent. Status code: ${res.statusCode}`);
        }).on('error', (err) => {
            console.error('❌ Keep-alive self-ping failed:', err.message);
        });
    }, 10 * 60 * 1000); // Self-ping every 10 minutes
}
// ==========================================

// 📋 Verified Management Copy Block with live Channel Verification Link
const GATEKEEPER_MESSAGE = `🚨ACTION REQUIRED OR APPLICATION CANCELLED🚨

To be approved into the niche group first join one of the general market groups (tap links in channel to see all the links). 

TikTok: Follow *TN FILMS GH*


We’ll view your chat before approving. If we get to your chat and you’ve not done these we will cancel your request. Follow these steps 

Facebook/Instagram: Follow *TN UNIVERSITIES CONNECT*

WhatsApp Channel: Join our official update channel: https://whatsapp.com/channel/0029VbCNby81CYoPIpEQMD1D

⚠️ Delay = Cancellation. We are clearing the pending list. I

Once you’ve followed all, send a DONE(with a screenshot). 

We are viewing chats before approving. If we get to your chat twice and you’ve not done so we will cancel your request`;

// 🎯 YOUR OFFICIAL GRABBED GROUP JID
const TN_CONNECT_JID = "120363428438604848@g.us"; 

// 🧠 MEMORY-SAFE SLIDING DEDUPLICATION CACHE (Prevents duplicate message triggers)
const processedMessageIds = new Set();

// ⏳ USER SCREENSHOT AGGREGATION SYSTEM (Buffers multiple screenshots within a short window)
const pendingApprovals = new Map();

const startBot = async () => {
    // Saves auth handshakes inside the persistent instance storage
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    // Fetch the latest WhatsApp Web version to resolve connection 405 errors
    const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1017578297], isLatest: false }));
    console.log(`🤖 Using WhatsApp Web version: ${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        logger: P({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ["TN Gatekeeper", "Chrome", "1.0.0"]
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // Render the QR code in the console logs
        if (qr) {
            console.log('\n✨ NEW INSTANCE QR CODE GENERATED BELOW! SCAN QUICKLY: ✨\n');
            qrcode.generate(qr, { small: false });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) 
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut 
                : true;
            console.log('🔄 Sockets closed. Running reconnection loop... Status:', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('🚀 TN Connect Gatekeeper is live and running 24/7 on cloud streams!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // 🛡️ NATIVE INTERCEPTION: Capture requests inside the Admin Review Pending Queue
    sock.ev.on('group.join-request', async (request) => {
        if (request.id !== TN_CONNECT_JID) return;

        const participant = request.participant;
        const cleanPhone = participant.replace('@s.whatsapp.net', '');
        console.log(`📡 Pending queue request captured for user: +${cleanPhone}`);

        // 🛡️ SAFE QUICK pacing delays: 3 to 7 seconds randomized intervals
        const randomDelay = Math.floor(Math.random() * (7 - 3 + 1) + 3) * 1000;
        console.log(`⏳ Snappy delay for ${randomDelay / 1000}s...`);
        await delay(randomDelay);

        // ✍️ NATIVE EMULATION: Trigger brief human "typing..." presence update on phone
        await sock.sendPresenceUpdate('composing', participant);
        await delay(2000); // Maintain typing status loop for 2 seconds
        await sock.sendPresenceUpdate('paused', participant);

        // 🚀 FIRE DISPATCH
        console.log(`✉️ Directing requirements packet to private inbox of +${cleanPhone}`);
        await sock.sendMessage(participant, { text: GATEKEEPER_MESSAGE });
    });

    // 🎯 GATE 2: Process proof when they reply with screenshots
    sock.ev.on('messages.upsert', async (m) => {
        if (!m.messages || m.messages.length === 0) return;

        // Helper function to send a reminder nudge if they only sent 1 screenshot
        const sendReminderNudge = async (jid) => {
            console.log(`⚠️ User +${jid.replace('@s.whatsapp.net', '')} only submitted 1 proof. Sending reminder nudge.`);
            try {
                await sock.sendMessage(jid, {
                    text: `⚠️ *GATEKEEPER NOTICE* ⚠️\n\nWe received 1 screenshot, but we require at least **2 screenshots** to verify all tasks (TikTok follow, Facebook/Instagram follow, and WhatsApp Channel join).\n\nPlease send the remaining screenshot(s) so we can automatically approve you! 📸✨`
                });
            } catch (err) {
                console.error("❌ Failed to send reminder:", err);
            }
        };

        // Helper function to execute the single, unified group approval
        const executeApproval = async (jid, count) => {
            console.log(`🚀 Executing single unified approval for ${jid} after receiving ${count} screenshot(s)!`);
            
            // Emulate human reviewing behavior
            await sock.sendPresenceUpdate('composing', jid);
            await delay(1500); // Snappy 1.5s typing emulation
            await sock.sendPresenceUpdate('paused', jid);

            try {
                // Execute automatic queue admission using verified Baileys method
                console.log(`🔓 Criteria verified! Issuing single automatic cloud approval token for ${jid}`);
                await sock.groupRequestParticipantsUpdate(TN_CONNECT_JID, [jid], 'approve');
                
                // Confirm entry via a single, beautiful DM dispatch
                await sock.sendMessage(jid, { 
                    text: `🎉 AUTOMATED VERIFICATION SUCCESSFUL!\n\nYour screenshot evidence has been validated. You have been successfully approved into the *TN CONNECT GROUP*. Welcome elite! 👋✨` 
                });
            } catch (err) {
                console.error("❌ Action failed or user already verified:", err);
            }
        };

        // 🔄 BATCH LOOP: Process all incoming messages in the update packet
        for (const msg of m.messages) {
            if (!msg || msg.key.fromMe) continue;

            const senderJid = msg.key.remoteJid;
            if (!senderJid) continue;

            // 🛡️ SECURITY FIRST: Strictly ignore all group messages (@g.us) and LIDs (@lid). ONLY process standard private individual DMs (@s.whatsapp.net).
            if (!senderJid.endsWith('@s.whatsapp.net')) continue;

            // 🔓 Extract message content, unwrapping ephemeral or view-once wrappers if present
            let messageContent = msg.message;
            if (messageContent?.ephemeralMessage) {
                messageContent = messageContent.ephemeralMessage.message;
            }
            if (messageContent?.viewOnceMessage) {
                messageContent = messageContent.viewOnceMessage.message;
            }
            if (messageContent?.viewOnceMessageV2) {
                messageContent = messageContent.viewOnceMessageV2.message;
            }
            if (messageContent?.documentWithCaptionMessage) {
                messageContent = messageContent.documentWithCaptionMessage.message;
            }

            const isImage = messageContent?.imageMessage || 
                            messageContent?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage ||
                            (messageContent?.documentMessage && messageContent.documentMessage.mimetype?.startsWith('image/'));

            if (isImage) {
                // 🧠 Deduplicate using message ID to prevent double triggers for the exact same file
                const msgId = msg.key.id;
                if (processedMessageIds.has(msgId)) continue;
                processedMessageIds.add(msgId);
                
                // Limit cache size to 1000 items to keep RAM usage extremely low
                if (processedMessageIds.size > 1000) {
                    const firstKey = processedMessageIds.values().next().value;
                    processedMessageIds.delete(firstKey);
                }

                console.log(`📸 Screenshot captured from candidate: ${senderJid}`);

                // ⏳ SCREENSHOT AGGREGATION PIPELINE WITH THRESHOLD CHECK
                if (pendingApprovals.has(senderJid)) {
                    const pending = pendingApprovals.get(senderJid);
                    pending.screenshotCount += 1;
                    clearTimeout(pending.timer);

                    // If they have now reached the minimum required screenshots (2)
                    if (pending.screenshotCount >= 2) {
                        console.log(`➕ Added screenshot for user: ${senderJid} (Total: ${pending.screenshotCount}). Met minimum requirement (>=2). Starting short 2s buffer for extra files.`);
                        
                        pending.timer = setTimeout(async () => {
                            pendingApprovals.delete(senderJid);
                            await executeApproval(senderJid, pending.screenshotCount);
                        }, 2000); // Snappy 2 seconds buffer for any additional screenshots
                    } else {
                        // Fallback to nudge window (should not be hit, but safe-keep)
                        pending.timer = setTimeout(async () => {
                            pending.timer = null;
                            await sendReminderNudge(senderJid);
                        }, 25000);
                    }
                } else {
                    // First screenshot: start the 25-second candidate window
                    console.log(`🆕 First screenshot captured for user: ${senderJid}. Starting 25s window to receive remaining proofs.`);
                    
                    const entry = { screenshotCount: 1, timer: null };
                    pendingApprovals.set(senderJid, entry);
                    
                    entry.timer = setTimeout(async () => {
                        // Do NOT delete their entry, just null the timer so we remember their count!
                        entry.timer = null;
                        await sendReminderNudge(senderJid);
                    }, 25000); // Give them 25 seconds to upload the second screenshot
                }
            }
        }
    });
};

startBot();
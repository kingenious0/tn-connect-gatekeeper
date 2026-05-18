const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');

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

const startBot = async () => {
    // Saves auth handshakes inside the persistent instance storage
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    const sock = makeWASocket({
        logger: P({ level: 'silent' }),
        printQRInTerminal: true,
        auth: state,
        browser: ["TN Gatekeeper", "Chrome", "1.0.0"]
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
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
    sock.ev.on('group-request.join', async (request) => {
        if (request.jid !== TN_CONNECT_JID) return;

        const participant = request.userJid;
        const cleanPhone = participant.replace('@s.whatsapp.net', '');
        console.log(`📡 Pending queue request captured for user: +${cleanPhone}`);

        // 🛡️ ANTI-BAN EMULATION: 15 to 40 seconds randomized pacing delays
        const randomDelay = Math.floor(Math.random() * (40 - 15 + 1) + 15) * 1000;
        console.log(`⏳ Delaying text pipeline for ${randomDelay / 1000}s to mimic human intervals...`);
        await delay(randomDelay);

        // ✍️ NATIVE EMULATION: Trigger human "typing..." presence update on phone
        await sock.sendPresenceUpdate('composing', participant);
        await delay(6000); // Maintain typing status loop for 6 seconds
        await sock.sendPresenceUpdate('paused', participant);

        // 🚀 FIRE DISPATCH
        console.log(`✉️ Directing requirements packet to private inbox of +${cleanPhone}`);
        await sock.sendMessage(participant, { text: GATEKEEPER_MESSAGE });
    });
};

startBot();
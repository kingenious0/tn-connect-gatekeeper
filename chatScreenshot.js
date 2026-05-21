/**
 * 📸 WhatsApp-Style Chat Screenshot Generator
 * Renders conversation history into a dark-themed WhatsApp-style PNG image.
 * Uses @napi-rs/canvas (pre-built Rust binaries, no native compilation needed).
 * 
 * Falls back gracefully — if canvas fails, returns null (caller sends text instead).
 */

let createCanvas, GlobalFonts;
try {
    ({ createCanvas, GlobalFonts } = require('@napi-rs/canvas'));
} catch (e) {
    console.warn('⚠️ [Screenshot] @napi-rs/canvas not available. Chat screenshots disabled.');
    createCanvas = null;
}

// Register bundled Inter font (required for Render Linux which has no system fonts)
const path = require('path');
const fs = require('fs');

if (GlobalFonts) {
    const fontPaths = [
        path.join(__dirname, 'fonts', 'Inter.otf'),
        path.join(__dirname, 'fonts', 'Inter.ttf'),
    ];
    for (const fp of fontPaths) {
        if (fs.existsSync(fp)) {
            GlobalFonts.registerFromPath(fp, 'Inter');
            console.log(`🔤 [Screenshot] Registered font: ${fp}`);
            break;
        }
    }
}

// WhatsApp Dark Theme Colors
const COLORS = {
    bg: '#0b141a',           // Main background
    headerBg: '#1f2c34',     // Header bar
    headerText: '#e9edef',   // Header name
    headerSub: '#8696a0',    // Header subtitle
    bubbleOut: '#005c4b',    // Outgoing bubble (green — user/applicant)
    bubbleIn: '#1f2c34',     // Incoming bubble (dark — bot/assistant)
    textOut: '#e9edef',      // Outgoing text
    textIn: '#e9edef',       // Incoming text
    timestamp: '#8696a0',    // Timestamp text
    icon: '#00a884',         // WhatsApp green accent
};

// Font config — use Inter if registered, fallback to sans-serif
const FONT_FAMILY = 'Inter, sans-serif';
const FONT_MAIN = `14px ${FONT_FAMILY}`;
const FONT_HEADER = `bold 16px ${FONT_FAMILY}`;
const FONT_SUB = `12px ${FONT_FAMILY}`;
const FONT_TIME = `11px ${FONT_FAMILY}`;

/**
 * Wrap text to fit within a given pixel width, handling newlines
 */
function wrapText(ctx, text, maxWidth) {
    const lines = [];
    // Split by newlines first
    const paragraphs = text.split('\n');
    
    for (const paragraph of paragraphs) {
        if (paragraph.trim() === '') {
            lines.push('');
            continue;
        }
        const words = paragraph.split(' ');
        let currentLine = '';

        for (const word of words) {
            const testLine = currentLine ? `${currentLine} ${word}` : word;
            const metrics = ctx.measureText(testLine);
            if (metrics.width > maxWidth && currentLine) {
                lines.push(currentLine);
                currentLine = word;
            } else {
                currentLine = testLine;
            }
        }
        if (currentLine) lines.push(currentLine);
    }
    return lines;
}

/**
 * Generate a WhatsApp-style chat screenshot as a PNG buffer
 * @param {Array} history - Gemini conversation history [{role:'user'|'model', parts:[{text:'...'}]}]
 * @param {string} contactName - Display name at top (e.g. "+233XXXXXXXXX")
 * @param {string} subtitle - Subtitle text (e.g. "Business Hub Applicant")
 * @returns {Buffer|null} PNG buffer or null if generation fails
 */
function generateChatScreenshot(history, contactName, subtitle = 'Business Hub Applicant') {
    if (!createCanvas) return null;
    if (!history || history.length === 0) return null;

    try {
        const WIDTH = 420;
        const BUBBLE_MAX_WIDTH = 290;
        const PADDING = 14;
        const BUBBLE_PADDING_H = 12;
        const BUBBLE_PADDING_V = 8;
        const LINE_HEIGHT = 19;
        const BUBBLE_GAP = 6;
        const HEADER_HEIGHT = 60;
        const TIME_ROW_HEIGHT = 18;

        // Clean conversation entries — strip markers and deduplicate
        const cleanEntries = [];
        const seenTexts = new Set(); // Track unique messages to prevent duplicates
        for (const entry of history) {
            let text = (entry.parts?.[0]?.text || '')
                .replace(/\[INTAKE_COMPLETE\].*/s, '')
                .replace(/\[RESIDENT_DECLINED\]/g, '')
                .replace(/\[TRIGGER_HUMAN\]/g, '')
                .trim();
            if (!text) continue;
            // Cap individual messages to 500 chars for readability
            if (text.length > 500) text = text.substring(0, 497) + '...';
            
            // Skip duplicate messages (same role + same text)
            const uniqueKey = `${entry.role}::${text}`;
            if (seenTexts.has(uniqueKey)) continue;
            seenTexts.add(uniqueKey);
            
            cleanEntries.push({ role: entry.role, text });
        }

        if (cleanEntries.length === 0) return null;

        // =============================================
        // PASS 1: Measure all bubbles to calculate total height
        // =============================================
        const tempCanvas = createCanvas(WIDTH, 100);
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.font = FONT_MAIN;

        let totalHeight = HEADER_HEIGHT + 20; // header + top padding

        for (const entry of cleanEntries) {
            const lines = wrapText(tempCtx, entry.text, BUBBLE_MAX_WIDTH - BUBBLE_PADDING_H * 2);
            const bubbleHeight = lines.length * LINE_HEIGHT + BUBBLE_PADDING_V * 2 + TIME_ROW_HEIGHT;
            totalHeight += bubbleHeight + BUBBLE_GAP;
        }

        totalHeight += 20; // bottom padding
        totalHeight = Math.min(totalHeight, 5000); // cap image height

        // =============================================
        // PASS 2: Draw the actual image
        // =============================================
        const canvas = createCanvas(WIDTH, totalHeight);
        const ctx = canvas.getContext('2d');

        // Background
        ctx.fillStyle = COLORS.bg;
        ctx.fillRect(0, 0, WIDTH, totalHeight);

        // ---- Header Bar ----
        ctx.fillStyle = COLORS.headerBg;
        ctx.fillRect(0, 0, WIDTH, HEADER_HEIGHT);

        // Back arrow
        ctx.fillStyle = COLORS.headerSub;
        ctx.font = `18px ${FONT_FAMILY}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('←', 12, HEADER_HEIGHT / 2);

        // Profile circle
        ctx.beginPath();
        ctx.arc(52, HEADER_HEIGHT / 2, 19, 0, Math.PI * 2);
        ctx.fillStyle = '#2a3942';
        ctx.fill();

        // Profile icon (person silhouette placeholder)
        ctx.fillStyle = '#8696a0';
        ctx.font = `bold 16px ${FONT_FAMILY}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const initial = (contactName || '?').replace('+', '')[0];
        ctx.fillText(initial || '?', 52, HEADER_HEIGHT / 2);

        // Contact name
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = COLORS.headerText;
        ctx.font = FONT_HEADER;
        const displayName = contactName.length > 25 ? contactName.substring(0, 22) + '...' : contactName;
        ctx.fillText(displayName, 80, 13);

        // Subtitle
        ctx.fillStyle = COLORS.headerSub;
        ctx.font = FONT_SUB;
        ctx.fillText(subtitle, 80, 35);

        // ---- Chat Bubbles ----
        let y = HEADER_HEIGHT + 14;

        const now = new Date();
        let minuteOffset = cleanEntries.length * 3;

        for (const entry of cleanEntries) {
            const isUser = entry.role === 'user';

            ctx.font = FONT_MAIN;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';

            const lines = wrapText(ctx, entry.text, BUBBLE_MAX_WIDTH - BUBBLE_PADDING_H * 2);
            const bubbleContentHeight = lines.length * LINE_HEIGHT;
            const bubbleHeight = bubbleContentHeight + BUBBLE_PADDING_V * 2 + TIME_ROW_HEIGHT;

            // Calculate bubble width based on longest line (min 100px)
            let maxLineWidth = 0;
            for (const line of lines) {
                const w = ctx.measureText(line).width;
                if (w > maxLineWidth) maxLineWidth = w;
            }
            const bubbleWidth = Math.max(Math.min(maxLineWidth + BUBBLE_PADDING_H * 2 + 14, BUBBLE_MAX_WIDTH), 100);

            // Position: user (applicant) on right, bot on left
            const x = isUser ? WIDTH - bubbleWidth - PADDING : PADDING;

            // Draw bubble with rounded corners
            const r = 8;
            ctx.fillStyle = isUser ? COLORS.bubbleOut : COLORS.bubbleIn;
            ctx.beginPath();
            ctx.moveTo(x + r, y);
            ctx.lineTo(x + bubbleWidth - r, y);
            ctx.arcTo(x + bubbleWidth, y, x + bubbleWidth, y + r, r);
            ctx.lineTo(x + bubbleWidth, y + bubbleHeight - r);
            ctx.arcTo(x + bubbleWidth, y + bubbleHeight, x + bubbleWidth - r, y + bubbleHeight, r);
            ctx.lineTo(x + r, y + bubbleHeight);
            ctx.arcTo(x, y + bubbleHeight, x, y + bubbleHeight - r, r);
            ctx.lineTo(x, y + r);
            ctx.arcTo(x, y, x + r, y, r);
            ctx.closePath();
            ctx.fill();

            // Draw text lines
            ctx.fillStyle = isUser ? COLORS.textOut : COLORS.textIn;
            ctx.font = FONT_MAIN;
            for (let i = 0; i < lines.length; i++) {
                ctx.fillText(lines[i], x + BUBBLE_PADDING_H, y + BUBBLE_PADDING_V + i * LINE_HEIGHT);
            }

            // Timestamp row (bottom-right of bubble)
            minuteOffset -= 3;
            const msgTime = new Date(now.getTime() - Math.max(minuteOffset, 0) * 60000);
            const timeStr = msgTime.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
            
            ctx.fillStyle = COLORS.timestamp;
            ctx.font = FONT_TIME;
            
            // Check marks for user messages
            if (isUser) {
                const checkAndTime = `${timeStr}  ✓✓`;
                ctx.fillText(checkAndTime, x + bubbleWidth - ctx.measureText(checkAndTime).width - 8, y + bubbleHeight - TIME_ROW_HEIGHT + 2);
            } else {
                ctx.fillText(timeStr, x + bubbleWidth - ctx.measureText(timeStr).width - 8, y + bubbleHeight - TIME_ROW_HEIGHT + 2);
            }

            y += bubbleHeight + BUBBLE_GAP;

            // Safety: stop if we exceed image height
            if (y > totalHeight - 30) break;
        }

        // Return PNG buffer
        return canvas.toBuffer('image/png');

    } catch (err) {
        console.error('❌ [Screenshot] Failed to generate chat image:', err.message || err);
        return null;
    }
}

module.exports = { generateChatScreenshot };

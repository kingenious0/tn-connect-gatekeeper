/**
 * 📸 WhatsApp-Style Chat Screenshot Generator
 * Renders conversation history into a dark-themed WhatsApp-style PNG image.
 * Uses @napi-rs/canvas (pre-built Rust binaries, no native compilation needed).
 * 
 * Falls back gracefully — if canvas fails, returns null (caller sends text instead).
 */

let createCanvas;
try {
    ({ createCanvas } = require('@napi-rs/canvas'));
} catch (e) {
    console.warn('⚠️ [Screenshot] @napi-rs/canvas not available. Chat screenshots disabled.');
    createCanvas = null;
}

// WhatsApp Dark Theme Colors
const COLORS = {
    bg: '#0b141a',           // Main background
    headerBg: '#1f2c34',     // Header bar
    headerText: '#e9edef',   // Header name
    headerSub: '#8696a0',    // Header subtitle
    bubbleOut: '#005c4b',    // Outgoing bubble (green)
    bubbleIn: '#1f2c34',     // Incoming bubble (dark)
    textOut: '#e9edef',      // Outgoing text
    textIn: '#e9edef',       // Incoming text
    timestamp: '#8696a0',    // Timestamp text
    divider: '#182229',      // Divider lines
    icon: '#00a884',         // WhatsApp green accent
};

// Font config (system fonts that exist everywhere)
const FONT_MAIN = '14px sans-serif';
const FONT_HEADER = 'bold 16px sans-serif';
const FONT_SUB = '12px sans-serif';
const FONT_TIME = '11px sans-serif';

/**
 * Wrap text to fit within a given pixel width
 */
function wrapText(ctx, text, maxWidth) {
    const words = text.split(' ');
    const lines = [];
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

    try {
        const WIDTH = 420;
        const BUBBLE_MAX_WIDTH = 280;
        const PADDING = 14;
        const BUBBLE_PADDING = 10;
        const LINE_HEIGHT = 20;
        const BUBBLE_GAP = 6;
        const HEADER_HEIGHT = 60;

        // =============================================
        // PASS 1: Calculate total height needed
        // =============================================
        const tempCanvas = createCanvas(WIDTH, 100);
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.font = FONT_MAIN;

        let totalHeight = HEADER_HEIGHT + 20; // header + top padding

        for (const entry of history) {
            const text = (entry.parts?.[0]?.text || '')
                .replace(/\[INTAKE_COMPLETE\].*/s, '')
                .replace(/\[RESIDENT_DECLINED\]/g, '')
                .replace(/\[TRIGGER_HUMAN\]/g, '')
                .trim();
            if (!text) continue;

            const lines = wrapText(tempCtx, text, BUBBLE_MAX_WIDTH - BUBBLE_PADDING * 2);
            const bubbleHeight = lines.length * LINE_HEIGHT + BUBBLE_PADDING * 2 + 16; // +16 for timestamp
            totalHeight += bubbleHeight + BUBBLE_GAP;
        }

        totalHeight += 20; // bottom padding
        totalHeight = Math.min(totalHeight, 4000); // cap image height

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

        // Profile circle
        ctx.beginPath();
        ctx.arc(36, HEADER_HEIGHT / 2, 20, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.icon;
        ctx.fill();

        // Profile initial
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 18px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText((contactName || '?')[0].toUpperCase(), 36, HEADER_HEIGHT / 2);

        // Contact name
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = COLORS.headerText;
        ctx.font = FONT_HEADER;
        ctx.fillText(contactName || 'Unknown', 66, 14);

        // Subtitle
        ctx.fillStyle = COLORS.headerSub;
        ctx.font = FONT_SUB;
        ctx.fillText(subtitle, 66, 36);

        // ---- Chat Bubbles ----
        let y = HEADER_HEIGHT + 14;
        ctx.font = FONT_MAIN;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';

        const now = new Date();
        let minuteOffset = history.length * 2;

        for (const entry of history) {
            const isUser = entry.role === 'user';
            const text = (entry.parts?.[0]?.text || '')
                .replace(/\[INTAKE_COMPLETE\].*/s, '')
                .replace(/\[RESIDENT_DECLINED\]/g, '')
                .replace(/\[TRIGGER_HUMAN\]/g, '')
                .trim();
            if (!text) continue;

            const lines = wrapText(ctx, text, BUBBLE_MAX_WIDTH - BUBBLE_PADDING * 2);
            const bubbleHeight = lines.length * LINE_HEIGHT + BUBBLE_PADDING * 2 + 16;

            // Calculate bubble width based on longest line
            let maxLineWidth = 0;
            for (const line of lines) {
                const w = ctx.measureText(line).width;
                if (w > maxLineWidth) maxLineWidth = w;
            }
            const bubbleWidth = Math.min(maxLineWidth + BUBBLE_PADDING * 2 + 10, BUBBLE_MAX_WIDTH);

            // Position: user on right, bot on left
            const x = isUser ? WIDTH - bubbleWidth - PADDING : PADDING;

            // Draw bubble with rounded corners
            const radius = 10;
            ctx.fillStyle = isUser ? COLORS.bubbleOut : COLORS.bubbleIn;
            ctx.beginPath();
            ctx.moveTo(x + radius, y);
            ctx.lineTo(x + bubbleWidth - radius, y);
            ctx.quadraticCurveTo(x + bubbleWidth, y, x + bubbleWidth, y + radius);
            ctx.lineTo(x + bubbleWidth, y + bubbleHeight - radius);
            ctx.quadraticCurveTo(x + bubbleWidth, y + bubbleHeight, x + bubbleWidth - radius, y + bubbleHeight);
            ctx.lineTo(x + radius, y + bubbleHeight);
            ctx.quadraticCurveTo(x, y + bubbleHeight, x, y + bubbleHeight - radius);
            ctx.lineTo(x, y + radius);
            ctx.quadraticCurveTo(x, y, x + radius, y);
            ctx.closePath();
            ctx.fill();

            // Draw text lines
            ctx.fillStyle = isUser ? COLORS.textOut : COLORS.textIn;
            ctx.font = FONT_MAIN;
            for (let i = 0; i < lines.length; i++) {
                ctx.fillText(lines[i], x + BUBBLE_PADDING, y + BUBBLE_PADDING + i * LINE_HEIGHT);
            }

            // Timestamp
            minuteOffset -= 2;
            const msgTime = new Date(now.getTime() - minuteOffset * 60000);
            const timeStr = msgTime.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
            ctx.fillStyle = COLORS.timestamp;
            ctx.font = FONT_TIME;
            ctx.fillText(timeStr, x + bubbleWidth - 46, y + bubbleHeight - 16);

            // Double check mark for outgoing
            if (isUser) {
                ctx.fillStyle = '#53bdeb';
                ctx.font = '10px sans-serif';
                ctx.fillText('✓✓', x + bubbleWidth - 18, y + bubbleHeight - 16);
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

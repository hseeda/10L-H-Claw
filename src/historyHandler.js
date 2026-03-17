/**
 * historyHandler.js
 * Unifies chat history management for Telegram, WhatsApp, and Onboard platforms.
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const envBotPath = path.join(__dirname, '..', 'secrets', '.env_bot');
if (fs.existsSync(envBotPath)) {
    dotenv.config({ path: envBotPath });
}

// Stateful history storage for memory-based platforms
const historyStore = {
    telegram: {}, // { chatId: [] }
    onboard: []   // [ { role, text, timestamp } ]
};

/**
 * Gets formatted history for a given platform.
 * @param {string} platform - 'telegram', 'whatsapp', 'onboard'
 * @param {string|object} target - chatId (TG), msg object (WA), or limit (Onboard)
 * @returns {Promise<string>} - Formatted history string
 */
async function getHistory(platform, target) {
    if (platform === 'whatsapp') {
        const msg = target;
        try {
            const chat = await msg.getChat();
            const recentMessages = await chat.fetchMessages();
            const historyStrings = [];

            for (const entry of recentMessages) {
                if (entry.id._serialized === msg.id._serialized) continue;

                const isBot = entry.body.startsWith('🐾') || entry.body.startsWith('ℹ️') || entry.body.startsWith('❌');
                const prefix = isBot ? 'H-Claw' : 'User';
                const time = new Date(entry.timestamp * 1000).toLocaleString();
                historyStrings.push(`[${time}] ${prefix}: ${entry.body}`);
            }
            return historyStrings.join('\n');
        } catch (err) {
            console.error('Error fetching WhatsApp history:', err);
            return '';
        }
    }

    if (platform === 'telegram') {
        const chatId = target;
        if (!historyStore.telegram[chatId]) historyStore.telegram[chatId] = [];
        return historyStore.telegram[chatId].join('\n');
    }

    if (platform === 'onboard') {
        return historyStore.onboard
            .map(entry => {
                const speaker = entry.role === 'assistant' ? 'H-Claw' : 'User';
                return `[${entry.timestamp}] ${speaker}: ${entry.text}`;
            })
            .join('\n');
    }

    return '';
}

/**
 * Appends to history for stateful platforms.
 * @param {string} platform - 'telegram', 'onboard'
 * @param {string} target - chatId (TG) or null (Onboard)
 * @param {string} arg1 - userText (TG) or role (Onboard)
 * @param {string} arg2 - assistantText (TG) or text (Onboard)
 */
function appendHistory(platform, target, arg1, arg2) {
    const time = new Date().toLocaleString();

    if (platform === 'telegram') {
        const chatId = target;
        const userText = arg1;
        const assistantText = arg2;

        if (!historyStore.telegram[chatId]) historyStore.telegram[chatId] = [];

        if (userText) {
            historyStore.telegram[chatId].push(`[${time}] User: ${userText}`);
        }
        if (assistantText) {
            historyStore.telegram[chatId].push(`[${time}] H-Claw: ${assistantText}`);
        }
    } else if (platform === 'onboard') {
        const role = arg1;
        const text = arg2;
        const normalized = String(text || '').trim();
        if (!normalized) return;

        historyStore.onboard.push({
            role,
            text: normalized,
            timestamp: time
        });
    }
}

/**
 * Clears history for a specific chat or platform.
 */
function clearHistory(platform, target) {
    if (platform === 'telegram' && target) {
        delete historyStore.telegram[target];
    } else if (platform === 'onboard') {
        historyStore.onboard.length = 0;
    }
}

function getBotLogHistory() {
    const limit = parseInt(process.env.BOT_LOG_HISTORY_LIMIT || '10', 10);
    const logPath = path.join(__dirname, '..', 'logs', 'bot_log.txt');
    
    if (!fs.existsSync(logPath)) return '';

    try {
        const text = fs.readFileSync(logPath, 'utf8');
        const lines = text.split('\n').filter(l => l.trim().length > 0);
        const lastLines = lines.slice(-limit);
        return lastLines.join('\n');
    } catch (err) {
        console.error('Error reading bot_log.txt for history:', err);
        return '';
    }
}

module.exports = {
    getHistory,
    appendHistory,
    clearHistory,
    getBotLogHistory
};

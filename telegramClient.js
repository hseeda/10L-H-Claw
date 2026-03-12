const fs = require('fs');
const path = require('path');
require('dotenv').config();
// aiHandler is lazy-loaded in initializeTelegramBot to avoid circular dependency
const { getActiveModel, getAvailableModels, getCurrentModelInfo, getAvailableModelsList, resetToDefaultModel, switchModelByNumber } = require('./Models');

const telegramHistory = {}; // Store history per chat ID
let activeMessages = []; // Track { chatId, messageId, timestamp } for /wipe
let highestMessageId = 0;

/**
 * Clean Markdown V1 string for Telegram.
 * Telegram's Markdown parsing is very fragile. This helps prevent 'can\'t parse entities' errors.
 */
function cleanMarkdownV1(text) {
    if (!text) return text;

    // 1. Fix unmatched characters by counting them
    const counts = {
        '*': (text.match(/\*/g) || []).length,
        '_': (text.match(/_/g) || []).length,
        '`': (text.match(/`/g) || []).length
    };

    let cleaned = text;

    // If underscores are unmatched or look like they are in words (e.g. some_variable)
    // they often break Markdown V1. We'll escape them if they aren't clearly pairs.
    if (counts['_'] % 2 !== 0 || /\w_\w/.test(cleaned)) {
        cleaned = cleaned.replace(/_/g, '\\_');
    }

    // If asterisks are unmatched, escape them all
    if (counts['*'] % 2 !== 0) {
        cleaned = cleaned.replace(/\*/g, '\\*');
    }

    // If backticks are unmatched, escape them all
    if (counts['`'] % 2 !== 0) {
        cleaned = cleaned.replace(/`/g, '\\`');
    }

    return cleaned;
}

const tgClient = {
    /**
     * Sends a message to a Telegram chat using the Bot API.
     * Includes a fallback to plaintext if Markdown parsing fails.
     */
    async sendTelegramMessage(chatId, text, useMarkdown = true) {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing in .env');

        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        const body = { 
            chat_id: chatId, 
            text: useMarkdown ? cleanMarkdownV1(text) : text
        };
        
        // We use Markdown (V1) because it's simpler for basic formatting.
        if (useMarkdown) body.parse_mode = 'Markdown';

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await response.json();
            
            if (!data.ok) {
                // Telegram Markdown parser is picky. Fallback to plaintext if it fails.
                if (useMarkdown && (data.description || '').includes('can\'t parse entities')) {
                    console.warn('⚠️ Telegram Markdown parse error. Retrying as plaintext...');
                    return this.sendTelegramMessage(chatId, text, false);
                }
                throw new Error(data.description || 'Failed to send Telegram message');
            }

            // Track the sent message ID
            if (data.result && data.result.message_id) {
                const mId = data.result.message_id;
                if (mId > highestMessageId) highestMessageId = mId;
                
                activeMessages.push({
                    chatId: chatId,
                    messageId: mId,
                    timestamp: Math.floor(Date.now() / 1000)
                });
            }

            return data;
        } catch (error) {
            console.error('Error sending Telegram message:', error.message);
            throw error;
        }
    },

    /**
     * Fetches information about a file from Telegram.
     */
    async getTelegramFile(fileId) {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const url = `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`;
        const response = await fetch(url);
        const data = await response.json();
        if (!data.ok) throw new Error(data.description || 'Failed to get Telegram file info');
        return data.result;
    },

    /**
     * Downloads a file from Telegram.
     */
    async downloadTelegramFile(fileId, destPath) {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const file = await this.getTelegramFile(fileId);
        const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
        
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        fs.writeFileSync(destPath, Buffer.from(buffer));
        return destPath;
    },

    /**
     * Sends media (photo, audio, voice, document) to a Telegram chat.
     */
    async sendTelegramMedia(chatId, filePath, caption = '') {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing in .env');

        if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

        const ext = path.extname(filePath).toLowerCase();
        let method = 'sendDocument';
        let field = 'document';

        if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
            method = 'sendPhoto';
            field = 'photo';
        } else if (['.mp3', '.m4a', '.wav'].includes(ext)) {
            method = 'sendAudio';
            field = 'audio';
        } else if (['.ogg', '.oga'].includes(ext)) {
            method = 'sendVoice';
            field = 'voice';
        }

        const url = `https://api.telegram.org/bot${token}/${method}`;
        
        // We use Form Data for file uploads
        const formData = new FormData();
        formData.append('chat_id', chatId);
        
        const fileBuffer = fs.readFileSync(filePath);
        const blob = new Blob([fileBuffer]);
        formData.append(field, blob, path.basename(filePath));

        if (caption) {
            formData.append('caption', cleanMarkdownV1(caption));
            formData.append('parse_mode', 'Markdown');
        }

        try {
            const response = await fetch(url, {
                method: 'POST',
                body: formData
            });
            const data = await response.json();
            
            if (!data.ok) {
                // Fallback for caption parse error
                if (caption && (data.description || '').includes('can\'t parse entities')) {
                    console.warn('⚠️ Telegram Media Caption parse error. Retrying as plaintext...');
                    formData.delete('caption');
                    formData.delete('parse_mode');
                    formData.append('caption', caption);
                    const retryResponse = await fetch(url, { method: 'POST', body: formData });
                    return await retryResponse.json();
                }
                throw new Error(data.description || `Failed to send Telegram ${field}`);
            }

            // Track the sent message ID
            if (data.result && data.result.message_id) {
                const mId = data.result.message_id;
                if (mId > highestMessageId) highestMessageId = mId;
                activeMessages.push({
                    chatId: chatId,
                    messageId: mId,
                    timestamp: Math.floor(Date.now() / 1000)
                });
            }

            return data;
        } catch (error) {
            console.error(`Error sending Telegram ${field}:`, error.message);
            throw error;
        }
    },

    /**
     * Fetches recent updates (messages) from Telegram.
     */
    async getTelegramUpdates(offset = 0, limit = 10) {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing in .env');

        const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&limit=${limit}`;

        try {
            const response = await fetch(url);
            const data = await response.json();
            if (!data.ok) throw new Error(data.description || 'Failed to fetch Telegram updates');
            return data;
        } catch (error) {
            console.error('Error fetching Telegram updates:', error.message);
            throw error;
        }
    },

    /**
     * Deletes a message from a Telegram chat.
     */
    async deleteTelegramMessage(chatId, messageId) {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing in .env');

        const url = `https://api.telegram.org/bot${token}/deleteMessage`;

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, message_id: messageId })
            });
            const data = await response.json();
            if (!data.ok) return { ok: false, error: data.description };
            return data;
        } catch (error) {
            return { ok: false, error: error.message };
        }
    }
};

function logTelegramMessage(msg, mediaInfo = null) {
    const direction = "📩 TELEGRAM INCOMING";
    const dateStr = new Date(msg.date * 1000).toLocaleString();
    
    const fromName = msg.from?.first_name || 'Unknown';
    const fromId = msg.from?.id || 'Unknown';
    const chatId = msg.chat?.id || 'Unknown';
    const chatTitle = msg.chat?.title || 'Private';

    let bodyText = msg.text || '';
    if (mediaInfo) {
        bodyText += ` [MEDIA: ${mediaInfo.type.toUpperCase()}] ${mediaInfo.relativePath}`;
    }
    if (!bodyText) bodyText = '(No text content)';
    
    bodyText = bodyText.replace(/\n/g, '\n│          ');

    const output = `\n┌─ ${direction} ──────────────────────────────
│ From:    ${fromName} (${fromId})
│ Chat:    ${chatTitle} (${chatId})
│ Time:    ${dateStr}
│ Msg ID:  ${msg.message_id}
│ Body:    ${bodyText}
└──────────────────────────────────────────`;
    console.log(output);
}

async function listCommands(chatId) {
    const reply = `🐾 *Telegram Bot Commands:*\n\n` +
        `• \`/help\` - Show this help menu\n` +
        `• \`/list models\` - List all available AI models\n` +
        `• \`/current model\` - Show the currently active AI model\n` +
        `• \`/reset model\` - Reset to the default model\n` +
        `• \`/switch model <number>\` - Switch the active AI model\n` +
        `• \`/wipe\` - Delete tracked messages from the past 24 hours\n` +
        `• \`/wipe tmp\` - Delete all files in the ./tmp directory\n` +
        `• \`/stop\` - Safely shut down the H-Claw server`;
    await tgClient.sendTelegramMessage(chatId, reply);
}

async function deepWipe(chatId) {
    const startMsg = await tgClient.sendTelegramMessage(chatId, '🌀 *Starting deep wipe operation...*');
    const startId = startMsg.result.message_id;
    
    console.log(`🌀 Telegram Deep Wipe started for ${chatId} from ID ${startId}`);
    
    let deletedCount = 0;
    let failureStreak = 0;
    const MAX_FAILURE_STREAK = 50;
    const MAX_ATTEMPTS = 1000;
    
    // 1. First, delete tracked messages (these are guaranteed to exist/be deletable)
    const trackedToDelete = activeMessages.filter(m => String(m.chatId) === String(chatId));
    for (const m of trackedToDelete) {
        try {
            const res = await tgClient.deleteTelegramMessage(m.chatId, m.message_id || m.messageId);
            if (res && res.ok !== false) deletedCount++;
        } catch (err) {}
    }

    // 2. Perform brute-force backward deletion from the latest ID
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
        const targetId = startId - i;
        if (targetId <= 0) break;

        try {
            const res = await tgClient.deleteTelegramMessage(chatId, targetId);
            if (res && res.ok !== false) {
                deletedCount++;
                failureStreak = 0; // Reset streak on success
            } else {
                failureStreak++;
            }
        } catch (err) {
            failureStreak++;
        }

        if (failureStreak >= MAX_FAILURE_STREAK) {
            console.log(`ℹ️ Telegram Deep Wipe reached start of history/too many unknowns. Stopping.`);
            break;
        }

        // Small delay to avoid rate limits (30 msgs/sec is the limit, so 40ms is safe)
        if (i % 20 === 0) await new Promise(resolve => setTimeout(resolve, 500));
        else await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Clear local tracking and history for this chat
    activeMessages = activeMessages.filter(m => String(m.chatId) !== String(chatId));
    delete telegramHistory[chatId];

    await tgClient.sendTelegramMessage(chatId, `ℹ️ *Deep Wipe complete!* Cleared approx ${deletedCount} message positions.`);
    console.log(`ℹ️ Telegram Deep Wipe complete for ${chatId}! Total cleared: ${deletedCount}`);
}

async function builtInCommands(chatId, text) {
    const cmd = text.trim().toLowerCase();
    if (cmd === '/help' || cmd === '/list commands') { await listCommands(chatId); return true; }
    if (cmd === '/list models') {
        const reply = getAvailableModelsList();
        await tgClient.sendTelegramMessage(chatId, reply);
        return true;
    }
    if (cmd === '/current model') {
        const reply = getCurrentModelInfo();
        await tgClient.sendTelegramMessage(chatId, reply);
        return true;
    }
    if (cmd === '/reset model') { 
        const reply = resetToDefaultModel();
        await tgClient.sendTelegramMessage(chatId, reply);
        return true; 
    }
    if (cmd === '/wipe') { await deepWipe(chatId); return true; }
    if (cmd === '/wipe tmp') {
        const { wipeTmpDirectory } = require('./aiTools');
        const count = wipeTmpDirectory();
        await tgClient.sendTelegramMessage(chatId, `🐾 *Tmp Wipe complete!* Cleared ${count} files from \`./tmp\`.`);
        return true;
    }
    if (cmd.startsWith('/switch model ')) {
        const targetNum = parseInt(text.trim().toLowerCase().replace('/switch model ', ''));
        const reply = switchModelByNumber(targetNum);
        await tgClient.sendTelegramMessage(chatId, reply);
        return true;
    }
    if (cmd === '/stop') {
        const { stopServer } = require('./serverTools');
        await stopServer();
        return true;
    }
    return false;
}

let isPolling = false;

let botInstance = tgClient;

function getTelegramClient() {
    return botInstance;
}

async function initializeTelegramClient(whatsappClient = null) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || token === 'your_bot_token_here') {
        console.log('ℹ️ Telegram Bot Token not found. Skipping Telegram initialization.');
        return;
    }

    if (isPolling) {
        console.log('ℹ️ Telegram polling is already running.');
        return;
    }
    isPolling = true;

    console.log('📡 Telegram Polling started... 🚀');
    let lastUpdateId = 0;

    // Initial check to clear old messages or get starting point
    try {
        const initial = await tgClient.getTelegramUpdates(0, 1);
        if (initial.result.length > 0) {
            lastUpdateId = initial.result[initial.result.length - 1].update_id;
            console.log(`ℹ️ Telegram skipping old messages (last ID: ${lastUpdateId})`);
        }
    } catch (err) {
        console.error('Failed to initialize Telegram polling offset:', err.message);
    }

    const telegramHistory = {}; // Store history per chat ID

    async function poll() {
        try {
            const updates = await tgClient.getTelegramUpdates(lastUpdateId + 1);
            for (const update of updates.result) {
                lastUpdateId = update.update_id;
                
                const msg = update.message || update.edited_message || update.channel_post;
                if (!msg) continue;

                // Handle Media Reception
                let mediaInfo = null;
                if (msg.photo || msg.voice || msg.audio || msg.document) {
                    const tmpDir = path.join(__dirname, 'tmp');
                    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

                    let fileId = null;
                    let type = '';
                    let ext = '';

                    if (msg.photo) {
                        fileId = msg.photo[msg.photo.length - 1].file_id;
                        type = 'photo';
                        ext = '.jpg';
                    } else if (msg.voice) {
                        fileId = msg.voice.file_id;
                        type = 'voice';
                        ext = '.ogg';
                    } else if (msg.audio) {
                        fileId = msg.audio.file_id;
                        type = 'audio';
                        ext = '.mp3';
                    } else if (msg.document) {
                        fileId = msg.document.file_id;
                        type = 'document';
                        ext = path.extname(msg.document.file_name) || '.bin';
                    }

                    if (fileId) {
                        const filename = `tele_${type}_${Date.now()}${ext}`;
                        const dest = path.join(tmpDir, filename);
                        try {
                            await tgClient.downloadTelegramFile(fileId, dest);
                            mediaInfo = { type, path: dest, relativePath: `tmp/${filename}` };
                            console.log(`📩 Telegram Media Received (${type}): ${filename}`);
                        } catch (err) {
                            console.error(`Failed to download Telegram ${type}:`, err.message);
                        }
                    }
                }

                if (!msg.text && !mediaInfo) continue;

                // Track incoming message IDs for /wipe
                const mId = msg.message_id;
                if (mId > highestMessageId) highestMessageId = mId;

                activeMessages.push({
                    chatId: msg.chat.id,
                    messageId: mId,
                    timestamp: msg.date
                });

                logTelegramMessage(msg, mediaInfo);

                const chatId = msg.chat.id;
                
                // 1. Check built-in commands
                if (msg.text && await builtInCommands(chatId, msg.text)) continue;

                // 2. Process with AI
                try {
                    // Maintain simple history
                    if (!telegramHistory[chatId]) telegramHistory[chatId] = [];
                    const historyText = telegramHistory[chatId].join('\n');

                    // If media was received, construct an enriched prompt
                    let prompt = msg.text || '';
                    if (mediaInfo) {
                        prompt += `\n[MEDIA ATTACHED: ${mediaInfo.type} at ${mediaInfo.path}]`;
                    }

                    const { generateAIResponse } = require('./aiHandler');
                    const aiReply = await generateAIResponse(prompt, true, whatsappClient, historyText, 'telegram');
                    
                    let finalReply = aiReply;
                    if (!finalReply.startsWith('🐾')) finalReply = '🐾 ' + finalReply;
                    
                    await tgClient.sendTelegramMessage(chatId, finalReply);

                    // Update history
                    telegramHistory[chatId].push(`User: ${msg.text}`);
                    telegramHistory[chatId].push(`H-Claw: ${finalReply}`);
                    if (telegramHistory[chatId].length > 20) telegramHistory[chatId].splice(0, 2);
                    
                } catch (aiErr) {
                    console.error('Telegram AI Error:', aiErr);
                    await tgClient.sendTelegramMessage(chatId, '🐾 Oops, I encountered an internal error.');
                }
            }
        } catch (err) {
            if (err.message.includes('Conflict')) {
                console.error('\n~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~');
                console.error('⚠️  TELEGRAM POLLING CONFLICT: Another instance of this bot is already running!');
                console.error('Please close any other terminal windows running H-Claw.');
                console.error('~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~\n');
                setTimeout(poll, 10000);
                return;
            }
        }
        setTimeout(poll, 3000);
    }

    poll();
}

module.exports = {
    initializeTelegramClient,
    getTelegramClient
};


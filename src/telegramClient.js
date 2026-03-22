const fs = require('fs');
const path = require('path');
// aiHandler is lazy-loaded in initializeTelegramBot to avoid circular dependency
const { getActiveModel, getAvailableModels, getCurrentModelInfo, getAvailableModelsList, resetToDefaultModel, switchModelByNumber, switchImageModelByNumber } = require('./Models');

const historyHandler = require('./historyHandler');

let activeMessages = []; // Track { chatId, messageId, timestamp } for /wipe
let highestMessageId = 0;
let lastKnownUserName = "User";
let globalWhatsappClient = null;

function ensureBotPrefix(text) {
    const raw = String(text || '').trim();
    if (!raw) return '🐾';
    return raw.startsWith('🐾') ? raw : `🐾 ${raw}`;
}

function formatScheduleStatus(status) {
    const raw = String(status || '').trim().toLowerCase();
    if (!raw) return '-';
    return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function getLastKnownUserName() {
    return lastKnownUserName;
}

/**
 * Format AI markdown output for Telegram Markdown V1.
 * Converts headers, bold, bullets, dividers into compact Telegram-friendly text with emojis.
 */
function formatForTelegram(text) {
    if (!text) return text;

    let t = text;

    // Convert ```code blocks``` — preserve them as-is (Telegram V1 supports ```)
    const codeBlocks = [];
    t = t.replace(/```[\s\S]*?```/g, (match) => {
        codeBlocks.push(match);
        return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
    });

    // Convert **bold** → *bold* (Telegram V1 bold)
    t = t.replace(/\*\*(.+?)\*\*/g, '*$1*');

    // Convert ## Headers → emoji bold headers
    t = t.replace(/^#{1,3}\s+(.+)$/gm, '📌 *$1*');

    // Convert --- / === dividers → compact line
    t = t.replace(/^[-=]{3,}$/gm, '─────');

    // Convert bullet lists: - item → • item
    t = t.replace(/^[\t ]*[-•]\s+/gm, '• ');

    // Convert numbered sub-items with excessive indentation
    t = t.replace(/^[\t ]{2,}(\d+\.)/gm, '  $1');

    // Collapse 3+ blank lines → 1
    t = t.replace(/\n{3,}/g, '\n\n');

    // Restore code blocks
    t = t.replace(/__CODE_BLOCK_(\d+)__/g, (_, i) => codeBlocks[i]);

    // Trim trailing whitespace per line
    t = t.replace(/[ \t]+$/gm, '');

    return cleanMarkdownV1(t.trim());
}

/**
 * Fix unmatched Markdown V1 characters to prevent Telegram parse errors.
 */
function cleanMarkdownV1(text) {
    if (!text) return text;

    const counts = {
        '*': (text.match(/\*/g) || []).length,
        '_': (text.match(/_/g) || []).length,
        '`': (text.match(/`/g) || []).length
    };

    let cleaned = text;

    // Escape underscores in words (e.g. some_variable) or if unmatched
    if (counts['_'] % 2 !== 0 || /\w_\w/.test(cleaned)) {
        cleaned = cleaned.replace(/_/g, '\\_');
    }

    if (counts['*'] % 2 !== 0) {
        cleaned = cleaned.replace(/\*/g, '\\*');
    }

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
    async sendTelegramMessage(chatId, text, useMarkdown = true, logMessage = true, replyToMessageId = null) {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing in .env');

        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        const body = {
            chat_id: chatId,
            text: useMarkdown ? formatForTelegram(ensureBotPrefix(text)) : ensureBotPrefix(text)
        };
        if (replyToMessageId) body.reply_to_message_id = replyToMessageId;
        
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
                const description = data.description || 'Failed to send Telegram message';
                if (description.toLowerCase().includes('chat not found')) {
                    throw new Error(`Telegram chat not found for chat_id ${chatId}`);
                }
                throw new Error(description);
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

                if (logMessage) logTelegramMessage(data.result, null, true);
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
            formData.append('caption', formatForTelegram(ensureBotPrefix(caption)));
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
                    formData.append('caption', ensureBotPrefix(caption));
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

                logTelegramMessage(data.result, { type: field }, true);
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
            console.warn('⚠️  Telegram will not be used:', error.message);
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

function logTelegramMessage(msg, mediaInfo = null, isOut = false) {
    const time = new Date(msg.date * 1000).toLocaleTimeString();
    const who = isOut ? 'H-Claw' : (msg.from?.first_name || 'Unknown');
    const icon = isOut ? '📤' : '📩';
    const dir = isOut ? 'OUT' : 'IN';
    const media = mediaInfo ? ` 📎${mediaInfo.type}` : '';
    const text = msg.text || msg.caption || '(empty)';
    const body = text.split('\n')[0].substring(0, 120);
    const logLine = `${icon} TG ${dir}${media} │ ${who} │ ${time} │ #${msg.message_id} │ ${body}`;
    console.log(logLine);
    
    const lowerText = (text || '').trim().toLowerCase();
    if (lowerText.includes('h-claw started!') || lowerText.includes('h-claw stopped!') || lowerText === '/stop') {
         return;
    }

    if (!isOut && text.startsWith('/')) return; // Skip input command
    if (isHandlingCommand) return; // Skip reply

    // Log to bot_log.txt
    const { appendBotLog } = require('./loggerTool');
    let logText = text || '(empty)';
    if (!isOut) {
        logText = `👤 ${logText}`;
    }
    appendBotLog(logText);
}

async function listCommands(chatId) {
    const reply = `🐾 *Commands:*\n` +
        `📖 \`/help\` — This menu\n` +
        `📖 \`/get history\` — Show chat history\n` +
        `📋 \`/list models\` — All models\n` +
        `🎯 \`/current model\` — Active model\n` +
        `♻️ \`/reset model\` — Reset model\n` +
        `🔀 \`/switch model #\` — Switch chat model\n` +
        `🎨 \`/switch image model #\` — Switch image model\n` +
        `🌀 \`/wipe\` — Wipe messages\n` +
        `🗑️ \`/wipe tmp\` — Clear tmp files\n` +
        `📋 \`/list schedule\` — View schedules\n` +
        `🗑️ \`/delete schedule\` — Clear all\n` +
        `🗑️ \`/delete task <pid>\` — Delete specific\n` +
        `⏰ \`/schedule [start] [end] [step] [prompt]\` — Add task\n` +
        `🛑 \`/stop\` — Shut down`;
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
    historyHandler.clearHistory('telegram', chatId);

    await tgClient.sendTelegramMessage(chatId, `ℹ️ *Deep Wipe complete!* Cleared approx ${deletedCount} message positions.`);
    console.log(`ℹ️ Telegram Deep Wipe complete for ${chatId}! Total cleared: ${deletedCount}`);
}

let isHandlingCommand = false;

async function builtInCommands(chatId, text) {
    isHandlingCommand = true;
    try {
    const cmd = text.trim().toLowerCase();
    if (cmd === '/help' || cmd === '/list commands') { await listCommands(chatId); return true; }
    if (cmd === '/get history') {
        const historyText = await historyHandler.getHistory('telegram', chatId);
        await tgClient.sendTelegramMessage(chatId, historyText || '🐾 No history found.');
        return true;
    }
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
    
    if (cmd === '/list schedule') {
        const { getScheduledTasks } = require('./scheduleTool');
        const tasks = getScheduledTasks();
        if (!tasks || tasks.length === 0) {
            await tgClient.sendTelegramMessage(chatId, "🐾 *No tasks scheduled.*");
            return true;
        }
        let reply = "📋 *Scheduled Tasks:\n\n*";
        tasks.forEach(t => {
            reply += `*${t.pid}*\nStart: ${t.start}\nStop: ${t.stop}\nStep: ${t.step_time}\nStatus: ${formatScheduleStatus(t.status)}\nNext: ${t.next_run_time || '-'}\n\n`;
        });
        await tgClient.sendTelegramMessage(chatId, reply);
        return true;
    }

    if (cmd === '/delete schedule') {
        const { clearAllSchedules } = require('./scheduleTool');
        const reply = clearAllSchedules();
        await tgClient.sendTelegramMessage(chatId, reply);
        return true;
    }

    if (cmd.startsWith('/delete task ')) {
        const pid = text.trim().slice('/delete task '.length).trim();
        const { deleteSchedule } = require('./scheduleTool');
        const reply = deleteSchedule(pid);
        await tgClient.sendTelegramMessage(chatId, reply);
        return true;
    }

    if (cmd.startsWith('/schedule ')) {
        const parts = text.trim().split(' ');
        if (parts.length < 5) {
            await tgClient.sendTelegramMessage(chatId, "🐾 *Format: /schedule [start] [end] [step] [prompt]*\nExample: `/schedule 09:00 17:00 30m Check servers`");
            return true;
    }
        const start = parts[1];
        const end = parts[2];
        const step = parts[3];
        const promptText = parts.slice(4).join(' ');
        const timeExpr = step.toLowerCase() === 'once'
            ? `once ${start}`
            : `start ${start} end ${end} step ${step}`;
        const { scheduleTask } = require('./scheduleTool');
        const reply = scheduleTask(promptText, timeExpr, promptText, {
            issuer_client: 'telegram',
            issuer_target: String(chatId)
        });
        await tgClient.sendTelegramMessage(chatId, reply);
        return true;
    }
    if (cmd.startsWith('/switch image model ')) {
        const targetNum = parseInt(text.trim().toLowerCase().replace('/switch image model ', ''));
        const reply = switchImageModelByNumber(targetNum);
        await tgClient.sendTelegramMessage(chatId, reply);
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
    } finally {
        isHandlingCommand = false;
    }
}

let isPolling = false;

let botInstance = tgClient;

function getTelegramClient() {
    return botInstance;
}

function isTelegramActive() {
    return isPolling;
}

async function initializeTelegramClient(whatsappClient = null) {
    if (whatsappClient) globalWhatsappClient = whatsappClient;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || token === 'your_bot_token_here') {
        console.log('ℹ️ Telegram Bot Token not found. Skipping Telegram initialization.');
        return;
    }

    if (isPolling) {
        console.log('ℹ️ Telegram polling is already running.');
        return;
    }
    let lastUpdateId = 0;

    // Validate token with Telegram before starting to poll
    try {
        const initial = await tgClient.getTelegramUpdates(0, 1);
        if (initial.result.length > 0) {
            lastUpdateId = initial.result[initial.result.length - 1].update_id;
            console.log(`ℹ️ Telegram skipping old messages (last ID: ${lastUpdateId})`);
        }
    } catch (err) {
        if (err.message.includes('Not Found') || err.message.includes('Unauthorized')) {
            return;
        }
        console.error('Failed to initialize Telegram polling offset:', err.message);
    }

    isPolling = true;
    console.log('📡 Telegram Polling started... 🚀');


    async function poll() {
        try {
            const updates = await tgClient.getTelegramUpdates(lastUpdateId + 1);
            for (const update of updates.result) {
                lastUpdateId = update.update_id;
                
                const msg = update.message || update.edited_message || update.channel_post;
                if (!msg) continue;

                // Track last known admin name from user messages
                if (msg.from?.first_name) {
                    lastKnownUserName = msg.from.first_name;
                }

                // Handle Media Reception
                let mediaInfo = null;
                if (msg.photo || msg.voice || msg.audio || msg.document) {
                    const tmpDir = path.join(__dirname, '..', 'tmp');
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
                    // Inject the last 10 prior messages; current message is passed separately as prompt.
                    const historyText = await historyHandler.getHistory('telegram', chatId);

                    // If media was received, construct an enriched prompt
                    let prompt = msg.text || '';
                    if (mediaInfo) {
                        prompt += `\n[MEDIA ATTACHED: ${mediaInfo.type} at ${mediaInfo.path}]`;
                    }

                    const { generateAIResponse } = require('./aiHandler');
                    const aiReply = await generateAIResponse(prompt, true, whatsappClient, historyText, `telegram:${chatId}`);
                    
                    let finalReply = aiReply;
                    if (!finalReply.startsWith('🐾')) finalReply = '🐾 ' + finalReply;
                    
                    await tgClient.sendTelegramMessage(chatId, finalReply);

                    historyHandler.appendHistory('telegram', chatId, msg.text, finalReply);
                    
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
            if (err.message.includes('Not Found') || err.message.includes('Unauthorized')) {
                isPolling = false;
                return;
            }
        }
        setTimeout(poll, 3000);
    }

    poll();
}

/**
 * Processes a message for a specific chat as if it was received from Telegram.
 */
async function processIncomingTelegramMessage(chatId, text) {
    const { generateAIResponse } = require('./aiHandler');
    const { appendBotLog } = require('./loggerTool');
    
    const time = new Date().toLocaleTimeString();
    let who = getLastKnownUserName ? getLastKnownUserName() : "User";
    if (who === "User") who = chatId;

    console.log(`📩 TG IN │ Dashboard (${who}) │ ${time} │ #DASH │ ${text}`);

    const cleanedText = typeof text === 'string' ? text.trim() : '';
    const lowerText = cleanedText.toLowerCase();
    if (
        cleanedText &&
        !lowerText.includes('h-claw started!') &&
        !lowerText.includes('h-claw stopped!') &&
        lowerText !== '/stop' &&
        !cleanedText.startsWith('/')
    ) {
        appendBotLog(`👤 ${cleanedText}`);
    }

    // Also send the dashboard text to the Telegram chat conversation
    await tgClient.sendTelegramMessage(chatId, text, false, false);

    if (await builtInCommands(chatId, text)) return;

    try {
        // Inject the last 10 prior messages; current message is passed separately as prompt.
        const historyText = await historyHandler.getHistory('telegram', chatId);

        const aiReply = await generateAIResponse(text, true, globalWhatsappClient, historyText, `telegram:${chatId}`);
        
        let finalReply = aiReply;
        if (!finalReply.startsWith('🐾')) finalReply = '🐾 ' + finalReply;
        
        await tgClient.sendTelegramMessage(chatId, finalReply);
        appendBotLog(finalReply);

        historyHandler.appendHistory('telegram', chatId, text, finalReply);
    } catch (aiErr) {
        console.error('Telegram AI Error:', aiErr);
        await tgClient.sendTelegramMessage(chatId, '🐾 Oops, I encountered an internal error.');
    }
}

module.exports = {
    initializeTelegramClient,
    getTelegramClient,
    sendTelegramMedia: (...args) => tgClient.sendTelegramMedia(...args),
    isTelegramActive,
    getLastKnownUserName,
    processIncomingTelegramMessage
};


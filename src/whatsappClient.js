const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { generateAIResponse } = require('./aiHandler');
const { getActiveModel, getAvailableModels, getCurrentModelInfo, getAvailableModelsList, resetToDefaultModel, switchModelByNumber, switchImageModelByNumber, printModelVariables } = require('./Models');

let client = null;
let whatsappRuntimeStatus = 'initializing';
const historyHandler = require('./historyHandler');

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

function getWhatsappClient() {
    return client;
}

function getWhatsAppStatus() {
    const info = {
        status: whatsappRuntimeStatus,
        connected: whatsappRuntimeStatus === 'ready',
        hasClient: !!client,
        wid: client?.info?.wid?._serialized || null,
    };

    if (info.connected) {
        return `WhatsApp status: READY${info.wid ? ` (${info.wid})` : ''}.`;
    }

    if (info.status === 'qr') {
        return 'WhatsApp status: QR_PENDING. A QR code was generated and still needs to be scanned.';
    }

    if (info.status === 'authenticated') {
        return 'WhatsApp status: AUTHENTICATED. Session is authenticated and waiting to become ready.';
    }

    if (info.status === 'auth_failure') {
        return 'WhatsApp status: AUTH_FAILURE. The saved WhatsApp session failed authentication.';
    }

    if (info.status === 'disconnected') {
        return 'WhatsApp status: DISCONNECTED. The WhatsApp client is not currently connected.';
    }

    if (info.status === 'launch_failed') {
        return 'WhatsApp status: LAUNCH_FAILED. The WhatsApp browser session could not start. Another process may already be using .wwebjs_auth/session.';
    }

    return `WhatsApp status: ${String(info.status || 'unknown').toUpperCase()}.`;
}

function isWhatsAppReady() {
    return whatsappRuntimeStatus === 'ready' && !!client;
}

/**
 * Format AI markdown output for WhatsApp.
 * WhatsApp supports: *bold*, _italic_, ~strikethrough~, ```monospace```
 */
function formatForWhatsApp(text) {
    if (!text) return text;

    let t = text;

    // Preserve ```code blocks```
    const codeBlocks = [];
    t = t.replace(/```[\s\S]*?```/g, (match) => {
        codeBlocks.push(match);
        return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
    });

    // Convert **bold** → *bold* (WhatsApp bold)
    t = t.replace(/\*\*(.+?)\*\*/g, '*$1*');

    // Convert ## Headers → emoji bold
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

    return t.trim();
}

async function logMessageFormatted(msg) {
    const isSelf = msg.to === msg.from;
    const isBot = msg.body.startsWith('🐾') || msg.body.startsWith('ℹ️') || msg.body.startsWith('❌');

    // In self-chat: user messages = IN, bot replies = OUT
    const isOut = isSelf ? isBot : msg.id.fromMe;
    const icon = isOut ? '📤' : '📩';
    const dir = isOut ? 'OUT' : 'IN';
    const time = new Date(msg.timestamp * 1000).toLocaleTimeString();

    let who = msg.from;
    try {
        const c = await client.getContactById(msg.from);
        who = c?.name || c?.pushname || c?.number || who;
    } catch {}

    const tags = [];
    if (msg.from.includes('@g.us') || msg.to.includes('@g.us')) tags.push('👥');
    if (isSelf) tags.push('🔁');
    if (msg.hasMedia) tags.push('📎');
    const tagStr = tags.length ? ` ${tags.join('')}` : '';

    const body = (msg.body || '').split('\n')[0].substring(0, 120) || '(empty)';
    const logLine = `${icon} WA ${dir}${tagStr} │ ${who} │ ${time} │ ${body}`;
    console.log(logLine);
    
    // Log "from me to me" to bot_log.txt
    if (isSelf) {
        const bodyText = msg.body || '';
        const lowerText = bodyText.trim().toLowerCase();
        if (lowerText.includes('h-claw started!') || lowerText.includes('h-claw stopped!') || lowerText === '/stop') {
             return;
        }
        if (!isOut && bodyText.startsWith('/')) return; // Skip input command
        if (isHandlingCommand) return; // Skip reply

        const { appendBotLog } = require('./loggerTool');
        let logText = bodyText || '(empty)';
        if (!isOut) {
            logText = `👤 ${logText}`;
        }
        appendBotLog(logText);
    }
}

async function cleanUpMessages(msg) {
    try {
        const chat = await msg.getChat();
        const messages = await chat.fetchMessages({ limit: 1000 });
        const oneDayAgo = (Date.now() / 1000) - (24 * 60 * 60);
        
        let deletedCount = 0;
        for (const m of messages) {
            if (m.timestamp >= oneDayAgo) {
                try {
                    try {
                        await m.delete(true); 
                    } catch (err) {
                        await m.delete(false);
                    }
                    deletedCount++;
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (err) {
                    console.error(`Failed to delete message ${m.id?.id || m.id}:`, err.message);
                }
            }
        }
        await client.sendMessage(msg.to, ensureBotPrefix(`ℹ️ Cleanup complete! Deleted ${deletedCount} messages from the past 24 hours.`));
        console.log(`ℹ️ Cleanup complete! Deleted ${deletedCount} messages from the past 24 hours.`);
    } catch (error) {
        console.error('Error during cleanup:', error);
        await client.sendMessage(msg.to, ensureBotPrefix('ℹ️ Oops, an error occurred during cleanup.'));
        console.log('ℹ️ Oops, an error occurred during cleanup.');
    }
    return;
}

async function listContacts(msg) {
    try {
        let query = msg.body.trim().toLowerCase().replace('/list contacts ', '').replace('/list contacts', '').trim();
        // Remove surrounding quotes if any
        if (query.startsWith('"') && query.endsWith('"')) query = query.slice(1, -1).trim();

        const contacts = await client.getContacts();
        
        let filtered = contacts.filter(c => c && c.id && (c.isMyContact || c.isGroup));
        if (query) {
            filtered = filtered.filter(c => {
                const name = (c.name || '').toLowerCase();
                const pushname = (c.pushname || '').toLowerCase();
                const userId = (c.id && c.id.user ? c.id.user : '');
                return name.includes(query) || pushname.includes(query) || userId.includes(query);
            });
        }

        // Limit results to avoid massive messages
        const limit = 20;
        const results = filtered.slice(0, limit);
        
        if (results.length === 0) {
            await client.sendMessage(msg.to, ensureBotPrefix(`ℹ️ No contacts found matching "${query}".`));
            return;
        }

        let reply = `ℹ️ *WhatsApp Contacts${query ? ` matching "${query}"` : ''}:*\n\n`;
        results.forEach((c, idx) => {
            const type = c.isGroup ? '👥' : '👤';
            const name = c.name || c.pushname || 'Unknown';
            reply += `${idx + 1}. ${type} *${name}* (${c.id.user})\n`;
        });

        if (filtered.length > limit) {
            reply += `\n...and ${filtered.length - limit} more.`;
        }

        await client.sendMessage(msg.to, reply);
    } catch (error) {
        console.error('Error listing contacts:', error);
        await client.sendMessage(msg.to, ensureBotPrefix(`❌ Failed to list contacts: ${error.message}`));
    }
}

async function listCommands(msg) {
    const reply = `🐾 *Commands:*\n` +
        `📖 */help* — This menu\n` +
        `📖 */get history* — Show chat history\n` +
        `🌀 */wipe* — Wipe messages (24h)\n` +
        `🗑️ */wipe tmp* — Clear tmp files\n` +
        `📋 */list models* — All models\n` +
        `🎯 */current model* — Active model\n` +
        `🔀 */switch model #* — Switch chat model\n` +
        `🎨 */switch image model #* — Switch image model\n` +
        `♻️ */reset model* — Reset model\n` +
        `👥 */list contacts [q]* — Search contacts\n` +
        `🖨️ */print* — Debug model vars\n` +
        `📋 */list schedule* — View schedules\n` +
        `🗑️ */delete schedule* — Clear all\n` +
        `🗑️ */delete task <pid>* — Delete specific\n` +
        `⏰ */schedule [start] [end] [step] [prompt]* — Add task\n` +
        `🛑 */stop* — Shut down`;
    await client.sendMessage(msg.to, ensureBotPrefix(reply));
}

let isHandlingCommand = false;

async function builtInCommands(msg) {
    isHandlingCommand = true;
    try {
    const cmd = msg.body.trim().toLowerCase();
    if (cmd === '/help' || cmd === '/list commands') {
        await listCommands(msg);
        return true;
    }
    if (cmd === '/get history') {
        const historyText = await historyHandler.getHistory('whatsapp', msg);
        await client.sendMessage(msg.to, ensureBotPrefix(historyText || 'No history found.'));
        return true;
    }

    if (msg.body.trim().toLowerCase() === '/wipe') {
        await cleanUpMessages(msg);
        return true;
    }

    if (cmd === '/list models') {
        const reply = getAvailableModelsList();
        await client.sendMessage(msg.to, ensureBotPrefix(reply));
        return true;
    }

    if (cmd === '/current model') {
        const reply = getCurrentModelInfo();
        await client.sendMessage(msg.to, ensureBotPrefix(reply));
        return true;
    }

    if (cmd === '/reset model') {
        const reply = resetToDefaultModel();
        await client.sendMessage(msg.to, ensureBotPrefix(reply));
        return true;
    }

    if (cmd.startsWith('/switch image model ')) {
        const targetNum = parseInt(msg.body.trim().toLowerCase().replace('/switch image model ', ''));
        const reply = switchImageModelByNumber(targetNum);
        await client.sendMessage(msg.to, ensureBotPrefix(reply));
        return true;
    }

    if (cmd.startsWith('/switch model ')) {
        const targetNum = parseInt(msg.body.trim().toLowerCase().replace('/switch model ', ''));
        const reply = switchModelByNumber(targetNum);
        await client.sendMessage(msg.to, ensureBotPrefix(reply));
        return true;
    }

    if (cmd.startsWith('/list contacts')) {
        await listContacts(msg);
        return true;
    }

    if (cmd === '/list schedule') {
        const { getScheduledTasks } = require('./scheduleTool');
        const tasks = getScheduledTasks();
        if (!tasks || tasks.length === 0) {
            await client.sendMessage(msg.to, ensureBotPrefix("*No tasks scheduled.*"));
            return true;
        }
        let reply = "📋 *Scheduled Tasks:\n\n*";
        tasks.forEach(t => {
            reply += `*${t.pid}*\nStart: ${t.start}\nStop: ${t.stop}\nStep: ${t.step_time}\nStatus: ${formatScheduleStatus(t.status)}\nNext: ${t.next_run_time || '-'}\n\n`;
        });
        await client.sendMessage(msg.to, ensureBotPrefix(reply));
        return true;
    }

    if (cmd === '/delete schedule') {
        const { clearAllSchedules } = require('./scheduleTool');
        const reply = clearAllSchedules();
        await client.sendMessage(msg.to, ensureBotPrefix(reply));
        return true;
    }

    if (cmd.startsWith('/delete task ')) {
        const pid = msg.body.trim().slice('/delete task '.length).trim();
        const { deleteSchedule } = require('./scheduleTool');
        const reply = deleteSchedule(pid);
        await client.sendMessage(msg.to, ensureBotPrefix(reply));
        return true;
    }

    if (cmd.startsWith('/schedule ')) {
        const parts = msg.body.trim().split(' ');
        if (parts.length < 5) {
            await client.sendMessage(msg.to, ensureBotPrefix("*Format: /schedule [start] [end] [step] [prompt]*\nExample: `/schedule 09:00 17:00 30m Check servers`"));
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
            issuer_client: 'whatsapp',
            issuer_target: msg.to
        });
        await client.sendMessage(msg.to, ensureBotPrefix(reply));
        return true;
    }

    if (cmd.startsWith('/print')) {
        printModelVariables();
        return true;
    }

    if(msg.body.trim().toLowerCase().startsWith('/wipe tmp')) {
        const { wipeTmpDirectory } = require('./aiTools');
        const count = wipeTmpDirectory();
        await msg.reply(ensureBotPrefix(`*Tmp Wipe complete!* Cleared ${count} files from \`../tmp\`.`));
        return true;
    }

    if(cmd.startsWith('/stop')) {
        const { stopServer } = require('./serverTools');
        stopServer();
        return true;
    }
        return false;
    } finally {
        isHandlingCommand = false;
    }
}

function initializeWhatsAppClient() {
    client = null;
    whatsappRuntimeStatus = 'initializing';

    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            args: ['--no-sandbox']
        }
    });

    client.on('qr', (qr) => {
        whatsappRuntimeStatus = 'qr';
        // Generate and scan this code with your phone
        console.log('QR RECEIVED. Scan the code below:');
        qrcode.generate(qr, {small: true});
    });

    client.on('ready', async () => {
        whatsappRuntimeStatus = 'ready';
        console.log('✅ WhatsApp Client is ready! 🚀');
        try {
            const selfChatId = client.info.wid._serialized;
            await client.sendMessage(selfChatId, '🐾 *H-Claw started!* ✨');

            // Telegram Notification
            if (process.env.TELEGRAM_CHAT_ID) {
                try {
                    const { getTelegramClient, isTelegramActive } = require('./telegramClient');
                    if (isTelegramActive()) {
                        const tg = getTelegramClient();
                        if (tg) {
                            await tg.sendTelegramMessage(process.env.TELEGRAM_CHAT_ID, '🐾 *H-Claw started!* ✨');
                        }
                    }
                } catch (tErr) {
                    console.error('Failed to send Telegram start message:', tErr.message);
                }
            }
        } catch (err) {
            console.error('Failed to send startup message:', err);
        }
    });

    // WhatsApp Client authenticated successfully.
    client.on('authenticated', () => {
        whatsappRuntimeStatus = 'authenticated';
        console.log('🔐 WhatsApp Client authenticated successfully.');
    });

    client.on('auth_failure', msg => {
        whatsappRuntimeStatus = 'auth_failure';
        console.error('🔐 WhatsApp Client authentication failure:', msg);
    });

    client.on('disconnected', (reason) => {
        whatsappRuntimeStatus = 'disconnected';
        console.warn('⚠️ WhatsApp Client disconnected:', reason);
    });

    // Listen to all created messages (incoming AND outgoing)
    client.on('message_create', async (msg) => {
        await logMessageFormatted(msg);

        // Don't reply to broadcast messages
        if (msg.from === 'status@broadcast') return;

        const isSelf = msg.to === msg.from;

        // BOT POLICY: Never send info messages or replies to any one but the user.
        // We only process messages in the self-chat ("Note to Self").
        if (!isSelf) return;

        // If it's a message from bot to user, we don't want the bot to reply
        // to its own replies and cause an infinite loop. 
        if (msg.body.startsWith('🐾')) return;
        if (msg.body.startsWith('ℹ️')) return;
        if (msg.body.startsWith('❌')) return;
        if (msg.body.startsWith('🔄')) return;

        if (isSelf && await builtInCommands(msg)) return;
        let model = getActiveModel();
        try {
            const chatHistory = await historyHandler.getHistory('whatsapp', msg);

            // Only take commands/replies if isSelf is true (already filtered above)
            let prompt = msg.body;
            if (msg.hasMedia) {
                prompt += `\n[MEDIA: whatsapp_read_media("${msg.id._serialized}")]`;
            }
            const aiReply = await generateAIResponse(prompt, isSelf, client, chatHistory, 'whatsapp');
            
            let finalReply = formatForWhatsApp(aiReply);
            if (!finalReply.startsWith('🐾')) {
                finalReply = '🐾 ' + finalReply;
            }
            await msg.reply(finalReply);
        } catch (error) {
            console.error('Error handling message:', error);
            await msg.reply("🐾 Oops, I encountered an internal error.");
        }
    });

    client.initialize().catch((error) => {
        whatsappRuntimeStatus = 'launch_failed';

        const message = String(error && error.message ? error.message : error);
        if (message.includes('The browser is already running for')) {
            console.error('⚠️ WhatsApp launch blocked: another browser process is already using the saved session directory (.wwebjs_auth/session). Stop the other H-Claw/Chromium process or remove the stale lock, then try again.');
            return;
        }

        console.error('❌ WhatsApp client failed to initialize:', message);
    });
    return client;
}

module.exports = { 
    initializeWhatsAppClient,
    getWhatsappClient,
    getWhatsAppStatus,
    isWhatsAppReady,
    MessageMedia,
};

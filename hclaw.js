const path = require('path');
const fs = require('fs');
require('./src/loggerTool');

const envPath = path.join(__dirname, 'secrets', '.env');
if (!fs.existsSync(envPath)) {
    console.error('\n╔══════════════════════════════════════════════════════╗');
    console.error('║  ❌  .env file not found!                            ║');
    console.error('╠══════════════════════════════════════════════════════╣');
    console.error('║                                                      ║');
    console.error(`║  Expected path:                                      ║`);
    console.error(`║    ${envPath.padEnd(50)}║`);
    console.error('║                                                      ║');
    console.error('║  To fix this:                                        ║');
    console.error('║    1. Copy .env.example to secrets/.env              ║');
    console.error('║    2. Fill in your API keys and tokens               ║');
    console.error('║    3. Restart the application                        ║');
    console.error('║                                                      ║');
    console.error('║  Required (at least one):                            ║');
    console.error('║    - OPENAI_API_KEY                                  ║');
    console.error('║    - GEMINI_API_KEY                                  ║');
    console.error('║                                                      ║');
    console.error('║  Optional:                                           ║');

    console.error('║    - TELEGRAM_BOT_TOKEN                              ║');
    console.error('║                                                      ║');
    console.error('╚══════════════════════════════════════════════════════╝\n');
    process.exit(1);
}

const oldLog = console.log;
console.log = () => {}; // Suppress dotenv tip/verbose output
require('dotenv').config({ path: envPath, quiet: true });

const envBotPath = path.join(__dirname, 'secrets', '.env_bot');
if (fs.existsSync(envBotPath)) {
    require('dotenv').config({ path: envBotPath, override: true });
}
console.log = oldLog;
const { initializeWhatsAppClient } = require('./src/whatsappClient');
const { initializeTelegramClient } = require('./src/telegramClient');
const queueFile = path.join(__dirname, 'tmp', 'onboard_ui_queue.jsonl');
const pidFile = path.join(__dirname, 'public', 'hclaw.pid');
let queueReadOffset = 0;
console.log(`🐾 WhatsApp AI Assistant initializing 🐾`);

// --- Startup warnings for missing API keys ---
if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY.toUpperCase().includes('YOUR_')) {
    console.warn('⚠️  GEMINI_API_KEY is not set. Gemini models will not be available.');
} else {
    console.log('💎 Gemini API key loaded.');
}
if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.toUpperCase().includes('YOUR_')) {
    console.warn('⚠️  OPENAI_API_KEY is not set. OpenAI models will not be available.');
} else {
    console.log('🤖 OpenAI API key loaded.');
}

const { initializeOnboardClient, handleOnboardDashboardMessage } = require('./src/onboardClient');

// Switch to default bot model from .env_bot on startup
const defaultModel = process.env.DEFAULT_BOT_MODEL;
if (defaultModel) {
    try {
        const { switchModelByNumber } = require('./src/Models');
        switchModelByNumber(parseInt(defaultModel, 10));
        console.log(`🎯 Initial model set from .env_bot to #${defaultModel}`);
    } catch(e) {}
}

const defaultImageModel = process.env.DEFAULT_IMAGE_MODEL;
if (defaultImageModel) {
    try {
        const { switchImageModelByNumber } = require('./src/Models');
        switchImageModelByNumber(parseInt(defaultImageModel, 10));
        console.log(`🎨 Initial Image model set from .env_bot to #${defaultImageModel}`);
    } catch(e) {}
}

const whatsappClient = initializeWhatsAppClient();
initializeTelegramClient(whatsappClient);
initializeOnboardClient(whatsappClient);

try {
    fs.mkdirSync(path.dirname(queueFile), { recursive: true });
    if (!fs.existsSync(queueFile)) fs.writeFileSync(queueFile, '', 'utf8');
    queueReadOffset = fs.statSync(queueFile).size;
} catch (error) {
    queueReadOffset = 0;
}

function writePidFile() {
    try {
        fs.mkdirSync(path.dirname(pidFile), { recursive: true });
        fs.writeFileSync(pidFile, String(process.pid), 'utf8');
    } catch (error) {
    }
}

function clearPidFile() {
    try {
        if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    } catch (error) {
    }
}

function validatePidFileOnStartup() {
    try {
        if (!fs.existsSync(pidFile)) return;
        const raw = fs.readFileSync(pidFile, 'utf8').trim();
        const pid = parseInt(raw, 10);
        if (!Number.isInteger(pid) || pid <= 0) {
            clearPidFile();
            return;
        }
        try {
            process.kill(pid, 0);
        } catch (error) {
            clearPidFile();
        }
    } catch (error) {
        clearPidFile();
    }
}

validatePidFileOnStartup();
writePidFile();

async function handleSettingsUpdate(settings) {
    const s = settings || {};
    if (s.historyLimit !== undefined) {
        process.env.BOT_LOG_HISTORY_LIMIT = s.historyLimit;
    }
    if (s.defaultBotModel !== undefined) {
        try {
            const { switchModelByNumber } = require('./src/Models');
            switchModelByNumber(parseInt(s.defaultBotModel, 10));
        } catch (e) {
        }
    }
    if (s.defaultImageModel !== undefined) {
        try {
            const { switchImageModelByNumber } = require('./src/Models');
            switchImageModelByNumber(parseInt(s.defaultImageModel, 10));
        } catch (e) {
        }
    }
}

async function handleSendMessage(msg) {
    const { getWhatsappClient, MessageMedia } = require('./src/whatsappClient');
    const { isTelegramActive, sendTelegramMedia } = require('./src/telegramClient');
    const { appendBotLog } = require('./src/loggerTool');
    const { platform, target, text, image_path: imagePath, history_limit: historyLimit } = msg;
    const cleanedText = typeof text === 'string' ? text.trim() : '';
    const lowerText = cleanedText.toLowerCase();

    try {
        if (platform === 'onboard') {
            await handleOnboardDashboardMessage({
                type: 'send_msg',
                platform,
                text,
                image_path: imagePath,
                history_limit: historyLimit
            }, whatsappClient);
            return;
        }

        if (platform === 'whatsapp') {
            const client = getWhatsappClient();
            if (client) {
                let waId = target;
                if (!waId) {
                    waId = client.info && client.info.wid && client.info.wid._serialized;
                }
                if (waId) {
                    const selfChatId = client.info && client.info.wid && client.info.wid._serialized;
                    if (!waId.includes('@')) {
                        waId = waId.includes('-') ? `${waId}@g.us` : `${waId}@c.us`;
                    }
                    if (imagePath) {
                        const media = MessageMedia.fromFilePath(imagePath);
                        await client.sendMessage(waId, media, cleanedText ? { caption: text } : undefined);
                    } else {
                        await client.sendMessage(waId, text);
                    }
                    if (
                        (cleanedText || imagePath) &&
                        waId !== selfChatId &&
                        !lowerText.includes('h-claw started!') &&
                        !lowerText.includes('h-claw stopped!') &&
                        lowerText !== '/stop' &&
                        !cleanedText.startsWith('/')
                    ) {
                        appendBotLog(`👤 ${cleanedText || '(image only)'}`);
                    }
                    console.log(`📤 [IPC] Sent WA to ${waId}`);
                } else {
                    console.error('❌ [IPC] Failed to send WA: Client not ready or target missing');
                }
            }
            return;
        }

        if (platform === 'telegram') {
            const tgId = target || process.env.TELEGRAM_CHAT_ID;
            if (!tgId) {
                console.error('❌ [IPC] Failed to send TG: No target or TELEGRAM_CHAT_ID provided');
                return;
            }
            if (isTelegramActive()) {
                if (imagePath) {
                    await sendTelegramMedia(tgId, imagePath, cleanedText);
                    if (
                        (cleanedText || imagePath) &&
                        !lowerText.includes('h-claw started!') &&
                        !lowerText.includes('h-claw stopped!') &&
                        lowerText !== '/stop' &&
                        !cleanedText.startsWith('/')
                    ) {
                        appendBotLog(`👤 ${cleanedText || '(image only)'}`);
                    }
                    console.log(`📤 [IPC] Sent TG media to ${tgId}`);
                } else {
                    const { processIncomingTelegramMessage } = require('./src/telegramClient');
                    await processIncomingTelegramMessage(tgId, text);
                    console.log(`📤 [IPC] Processed TG trigger for ${tgId}`);
                }
            }
        }
    } catch (e) {
        console.error(`❌ [IPC] Failed to send message:`, e.message);
    } finally {
        if (imagePath && platform !== 'onboard' && fs.existsSync(imagePath)) {
            try {
                fs.unlinkSync(imagePath);
            } catch (cleanupError) {
            }
        }
    }
}

async function processQueuedCommands() {
    try {
        if (!fs.existsSync(queueFile)) return;
        const stats = fs.statSync(queueFile);
        if (stats.size <= queueReadOffset) return;

        const handle = await fs.promises.open(queueFile, 'r');
        try {
            const length = stats.size - queueReadOffset;
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, queueReadOffset);
            queueReadOffset = stats.size;

            const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
            for (const line of lines) {
                try {
                    const payload = JSON.parse(line);
                    if (payload.type === 'send_msg') {
                        await handleSendMessage(payload);
                    } else if (payload.type === 'update_settings') {
                        await handleSettingsUpdate(payload.settings);
                    }
                } catch (error) {
                    console.error('Queue payload error:', error.message);
                }
            }
        } finally {
            await handle.close();
        }
    } catch (error) {
        console.error('Queue processing error:', error.message);
    }
}

setInterval(() => {
    processQueuedCommands();
}, 700);

// Handle graceful shutdown globally
process.on('SIGINT', async () => {
    clearPidFile();
    const { stopServer } = require('./src/serverTools');
    await stopServer();
});

process.on('SIGTERM', async () => {
    clearPidFile();
    const { stopServer } = require('./src/serverTools');
    await stopServer();
});

process.on('exit', () => {
    clearPidFile();
});

// Handle IPC messages from Admin Server
process.on('message', async (msg) => {
    if (msg === 'stop' || msg.type === 'stop') {
        const { stopServer } = require('./src/serverTools');
        await stopServer();
    } else if (msg.type === 'update_settings') {
        await handleSettingsUpdate(msg.settings);
    } else if (msg.type === 'send_msg') {
        await handleSendMessage(msg);
    }
});

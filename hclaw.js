require("dns").setDefaultResultOrder("ipv4first");
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
    require('dotenv').config({ path: envBotPath, override: true, quiet: true });
}
console.log = oldLog;
const { initializeWhatsAppClient, isWhatsAppReady, getWhatsAppStatus } = require('./src/whatsappClient');
const { initializeTelegramClient } = require('./src/telegramClient');
const { loadScheduledTasks, getSchedulableTasks, getStoredScheduledTasks, markTaskExecuted, updateSchedule, computeFutureOccurrence } = require('./src/scheduleTool');
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
    } catch(e) {}
}

const defaultImageModel = process.env.DEFAULT_IMAGE_MODEL;
if (defaultImageModel) {
    try {
        const { switchImageModelByNumber } = require('./src/Models');
        switchImageModelByNumber(parseInt(defaultImageModel, 10));
    } catch(e) {}
}

const whatsappClient = initializeWhatsAppClient();
initializeTelegramClient(whatsappClient);
initializeOnboardClient(whatsappClient);

// On startup, immediately refresh persisted next_run_time/status from the current time.
loadScheduledTasks(new Date());

let schedulerInFlight = false;

async function deliverScheduledReply(task, response) {
    const platform = String(task.issuer_client || 'onboard').toLowerCase();
    const target = String(task.issuer_target || '').trim();
    const finalReply = response && response.startsWith('🐾') ? response : `🐾 ${response}`;

    if (platform === 'whatsapp') {
        const selfRecipient = whatsappClient?.info?.wid?._serialized || '';
        const normalizedTarget = target && target.includes('@')
            ? target
            : (/^\d+$/.test(target) ? `${target}@c.us` : '');
        const recipient = normalizedTarget || selfRecipient;
        if (!isWhatsAppReady()) {
            throw new Error(`WhatsApp client is not ready. ${getWhatsAppStatus()}`);
        }
        if (whatsappClient && recipient) {
            await whatsappClient.sendMessage(recipient, finalReply);
        }
        return;
    }

    if (platform === 'telegram') {
        const { getTelegramClient, isTelegramActive } = require('./src/telegramClient');
        const telegramClient = getTelegramClient();
        const recipient = /^-?\d+$/.test(target) ? target : process.env.TELEGRAM_CHAT_ID;
        if (!recipient || !/^-?\d+$/.test(String(recipient))) {
            throw new Error(`Telegram recipient is invalid. issuer_target="${target}" TELEGRAM_CHAT_ID="${process.env.TELEGRAM_CHAT_ID || ''}"`);
        }
        if (telegramClient && isTelegramActive() && recipient) {
            await telegramClient.sendTelegramMessage(recipient, finalReply);
        }
        return;
    }

    const { appendBotLog } = require('./src/loggerTool');
    const historyHandler = require('./src/historyHandler');
    appendBotLog(finalReply);
    historyHandler.appendHistory('onboard', null, 'assistant', finalReply);
    console.log(`📤 [OB][SCHED] Reply: ${finalReply}`);
}

async function executeScheduledTask(task) {
    const { appendBotLog, appendBotLogSeparator } = require('./src/loggerTool');
    const historyHandler = require('./src/historyHandler');
    const { generateAIResponse } = require('./src/aiHandler');
    const issuer = String(task.issuer_client || 'onboard').toUpperCase();
    const issuerIcon = task.issuer_client === 'whatsapp'
        ? '💬'
        : task.issuer_client === 'telegram'
            ? '📨'
            : '🖥️';
    const prompt = String(task.prompt || '').trim();
    if (!prompt) return;

    appendBotLogSeparator();
    appendBotLog(`⏰ ${issuerIcon} [Task ${task.pid}] ${prompt}`);
    console.log(`⏰ [SCHED] Executing task ${task.pid} for ${issuer}`);

    if (task.issuer_client === 'onboard') {
        historyHandler.appendHistory('onboard', null, 'user', `[Scheduled ${task.pid}] ${prompt}`);
    } else if (task.issuer_client === 'telegram' && task.issuer_target) {
        historyHandler.appendHistory('telegram', String(task.issuer_target), `[Scheduled ${task.pid}] ${prompt}`, null);
    }

    const injectedHistory = task.issuer_client === 'telegram'
        ? await historyHandler.getHistory('telegram', String(task.issuer_target || ''))
        : task.issuer_client === 'onboard'
            ? await historyHandler.getHistory('onboard')
            : '';

    const response = await generateAIResponse(prompt, false, whatsappClient, injectedHistory, task.issuer_client || 'onboard');
    await deliverScheduledReply(task, response || 'Scheduled task completed.');
}

async function triggerScheduledTaskByPid(pid) {
    const taskId = String(pid || '').trim();
    if (!taskId) {
        throw new Error('Task pid is required.');
    }

    loadScheduledTasks(new Date());
    const tasks = getStoredScheduledTasks();
    const task = tasks.find((entry) => String(entry.pid) === taskId);
    if (!task) {
        throw new Error(`Task ${taskId} not found.`);
    }

    await executeScheduledTask(task);
    return task;
}

async function runSchedulerTick() {
    if (schedulerInFlight) return;
    schedulerInFlight = true;
    try {
        loadScheduledTasks(new Date());
        const dueTasks = getSchedulableTasks(new Date());
        for (const task of dueTasks) {
            const updatedTask = markTaskExecuted(task.pid, new Date());
            try {
                await executeScheduledTask({ ...task, next_run_time: updatedTask.next_run_time, status: updatedTask.status });
                updateSchedule(task.pid, {
                    next_run_time: computeFutureOccurrence(updatedTask, new Date())
                });
            } catch (taskError) {
                updateSchedule(task.pid, {
                    next_run_time: task.next_run_time,
                    status: task.status
                });
                throw taskError;
            }
        }
    } catch (error) {
        console.error('Scheduler tick failed:', error && error.stack ? error.stack : error);
    } finally {
        schedulerInFlight = false;
    }
}

function getSchedulerDelayMs(now = new Date()) {
    const currentSecond = now.getSeconds();
    const currentMs = now.getMilliseconds();
    const targetSecond = 2;
    const secondsUntilTarget = currentSecond < targetSecond
        ? (targetSecond - currentSecond)
        : (62 - currentSecond);
    return (secondsUntilTarget * 1000) - currentMs;
}

function startSchedulerPolling() {
    const scheduleNextTick = () => {
        const delayMs = getSchedulerDelayMs();
        setTimeout(async () => {
            await runSchedulerTick();
            scheduleNextTick();
        }, delayMs);
    };

    scheduleNextTick();
}

try {
    fs.mkdirSync(path.dirname(queueFile), { recursive: true });
    if (!fs.existsSync(queueFile)) fs.writeFileSync(queueFile, '', 'utf8');
    queueReadOffset = fs.statSync(queueFile).size;
} catch (error) {
    queueReadOffset = 0;
}

async function compactConsumedQueue(currentSize) {
    const consumedSize = Number(currentSize);
    if (!Number.isFinite(consumedSize) || consumedSize <= 0) return false;

    try {
        const latestStats = await fs.promises.stat(queueFile);
        if (latestStats.size !== consumedSize || queueReadOffset !== consumedSize) {
            return false;
        }

        await fs.promises.truncate(queueFile, 0);
        queueReadOffset = 0;
        return true;
    } catch (error) {
        return false;
    }
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
    if (s.maxToolCalls !== undefined) {
        process.env.MAX_TOOL_CALLS = s.maxToolCalls;
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
    const {
        platform,
        target,
        text,
        image_path: imagePath,
        media_path: mediaPath,
        history_limit: historyLimit
    } = msg;
    const attachedMediaPath = mediaPath || imagePath;
    const cleanedText = typeof text === 'string' ? text.trim() : '';
    const lowerText = cleanedText.toLowerCase();

    try {
        if (platform === 'onboard') {
            await handleOnboardDashboardMessage({
                type: 'send_msg',
                platform,
                text,
                image_path: attachedMediaPath,
                media_path: attachedMediaPath,
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
                    if (attachedMediaPath) {
                        const media = MessageMedia.fromFilePath(attachedMediaPath);
                        await client.sendMessage(waId, media, cleanedText ? { caption: text } : undefined);
                    } else {
                        await client.sendMessage(waId, text);
                    }
                    if (
                        (cleanedText || attachedMediaPath) &&
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
                if (attachedMediaPath) {
                    await sendTelegramMedia(tgId, attachedMediaPath, cleanedText);
                    if (
                        (cleanedText || attachedMediaPath) &&
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
        if (attachedMediaPath && platform !== 'onboard' && fs.existsSync(attachedMediaPath)) {
            try {
                fs.unlinkSync(attachedMediaPath);
            } catch (cleanupError) {
            }
        }
    }
}

async function processQueuedCommands() {
    try {
        if (!fs.existsSync(queueFile)) return false;
        const stats = fs.statSync(queueFile);
        if (stats.size === 0) {
            queueReadOffset = 0;
            return false;
        }
        if (stats.size === queueReadOffset) {
            await compactConsumedQueue(stats.size);
            return false;
        }
        if (stats.size < queueReadOffset) {
            queueReadOffset = 0;
            return false;
        }

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
                    } else if (payload.type === 'trigger_schedule') {
                        await triggerScheduledTaskByPid(payload.pid);
                    }
                } catch (error) {
                    console.error('Queue payload error:', error.message);
                }
            }
            await compactConsumedQueue(stats.size);
            return lines.length > 0;
        } finally {
            await handle.close();
        }
    } catch (error) {
        console.error('Queue processing error:', error.message);
        return false;
    }
}

const QUEUE_POLL_MIN = 150;
const QUEUE_POLL_MAX = 5000;
let queuePollDelay = QUEUE_POLL_MIN;

function scheduleQueuePoll() {
    setTimeout(async () => {
        const hadWork = await processQueuedCommands();
        queuePollDelay = hadWork
            ? QUEUE_POLL_MIN
            : Math.min(queuePollDelay * 2, QUEUE_POLL_MAX);
        scheduleQueuePoll();
    }, queuePollDelay);
}

scheduleQueuePoll();

startSchedulerPolling();

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
    } else if (msg.type === 'trigger_schedule') {
        await triggerScheduledTaskByPid(msg.pid);
    }
});

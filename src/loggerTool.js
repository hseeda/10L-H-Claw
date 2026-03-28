const fs = require('fs');
const path = require('path');
const util = require('util');

const originalExistsSync = fs.existsSync.bind(fs);

function isValidExistsSyncPath(value) {
    if (typeof value === 'string') return true;
    if (Buffer.isBuffer(value)) return true;
    if (typeof URL !== 'undefined' && value instanceof URL) return true;
    return false;
}

// Guard against deprecated invalid-path calls anywhere in the process.
fs.existsSync = (value) => {
    if (!isValidExistsSyncPath(value)) {
        return false;
    }
    return originalExistsSync(value);
};

// Define log path relative to this file (which is in src/)
const logFile = path.resolve(__dirname, '..', 'logs', 'log.txt');
const botLogFile = path.resolve(__dirname, '..', 'logs', 'bot_log.txt');

// Ensure logs directory exists
const logsDir = path.dirname(logFile);
try {
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }
} catch (err) {
    // Fallback or ignore if cannot create
}

// Create append streams
const logStream = fs.createWriteStream(logFile, { flags: 'a' });
const botLogStream = fs.createWriteStream(botLogFile, { flags: 'a' });

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
const LOG_SEPARATOR = '──────────────────────────────────────';
const MAX_LOG_LINES = 200;
const trimState = new Map();

function getTimestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${d.toTimeString().split(' ')[0]}`;
}

function isBotResponseLogLine(text) {
    const formatted = String(text || '').trim();
    if (!formatted) return false;
    return formatted.includes(' Reply: ');
}

async function trimLogFile(filePath, stream) {
    try {
        if (stream && !stream.closed) {
            await new Promise((resolve) => stream.write('', resolve));
        }
        const raw = await fs.promises.readFile(filePath, 'utf8');
        const lines = raw.split(/\r?\n/);
        const endsWithNewline = /\r?\n$/.test(raw);
        const normalizedLines = endsWithNewline ? lines.slice(0, -1) : lines;
        if (normalizedLines.length <= MAX_LOG_LINES) {
            return;
        }
        const trimmed = normalizedLines.slice(-MAX_LOG_LINES).join('\n');
        await fs.promises.writeFile(filePath, `${trimmed}\n`, 'utf8');
    } catch (error) {
        // Ignore trimming failures so logging never breaks the app.
    }
}

function scheduleTrim(filePath, stream) {
    const current = trimState.get(filePath) || { running: false, pending: false, scheduled: false };
    if (current.running) {
        current.pending = true;
        trimState.set(filePath, current);
        return;
    }
    if (current.scheduled) {
        trimState.set(filePath, current);
        return;
    }

    current.scheduled = true;
    trimState.set(filePath, current);

    setTimeout(async () => {
        const state = trimState.get(filePath) || { running: false, pending: false, scheduled: false };
        state.scheduled = false;
        state.running = true;
        trimState.set(filePath, state);

        await trimLogFile(filePath, stream);

        const nextState = trimState.get(filePath) || { running: false, pending: false, scheduled: false };
        const shouldRunAgain = nextState.pending;
        nextState.running = false;
        nextState.pending = false;
        trimState.set(filePath, nextState);

        if (shouldRunAgain) {
            scheduleTrim(filePath, stream);
        }
    }, 25);
}

console.log = (...args) => {
    const formatted = util.format(...args);
    originalLog(...args); // Print to CLI
    if (isBotResponseLogLine(formatted)) {
        logStream.write(`${LOG_SEPARATOR}\n`);
        logStream.write(`[${getTimestamp()}] ${formatted}\n`);
        logStream.write(`${LOG_SEPARATOR}\n`);
        scheduleTrim(logFile, logStream);
        return;
    }
    logStream.write(`[${getTimestamp()}] ${formatted}\n`);
    scheduleTrim(logFile, logStream);
};

console.warn = (...args) => {
    const formatted = util.format(...args);
    originalWarn(...args);
    logStream.write(`[${getTimestamp()}] [WARN] ${formatted}\n`);
    scheduleTrim(logFile, logStream);
};

console.error = (...args) => {
    const formatted = util.format(...args);
    originalError(...args);
    logStream.write(`[${getTimestamp()}] [ERROR] ${formatted}\n`);
    scheduleTrim(logFile, logStream);
};

function appendBotLog(text) {
    if (typeof text === 'string' && text.trim().startsWith('ℹ️')) {
        return;
    }
    if (typeof text === 'string' && /heartbeat/i.test(text)) {
        return;
    }
    if (typeof text === 'string' && text.startsWith('👤')) {
        botLogStream.write(`${LOG_SEPARATOR}\n`);
    }
    botLogStream.write(`${text}\n`);
    scheduleTrim(botLogFile, botLogStream);
}

function appendBotLogSeparator() {
    botLogStream.write(`${LOG_SEPARATOR}\n`);
    scheduleTrim(botLogFile, botLogStream);
}

scheduleTrim(logFile, logStream);
scheduleTrim(botLogFile, botLogStream);

// Handle graceful close on exit to flush streams if needed
process.on('exit', () => {
    logStream.end();
    botLogStream.end();
});

module.exports = { appendBotLog, appendBotLogSeparator };

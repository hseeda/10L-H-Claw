const fs = require('fs');
const path = require('path');
const util = require('util');

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

function getTimestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${d.toTimeString().split(' ')[0]}`;
}

console.log = (...args) => {
    const formatted = util.format(...args);
    originalLog(...args); // Print to CLI
    logStream.write(`[${getTimestamp()}] ${formatted}\n`);
};

console.warn = (...args) => {
    const formatted = util.format(...args);
    originalWarn(...args);
    logStream.write(`[${getTimestamp()}] [WARN] ${formatted}\n`);
};

console.error = (...args) => {
    const formatted = util.format(...args);
    originalError(...args);
    logStream.write(`[${getTimestamp()}] [ERROR] ${formatted}\n`);
};

function appendBotLog(text) {
    if (typeof text === 'string' && text.startsWith('👤')) {
        botLogStream.write('──────────────────────────────────────────────────\n');
    }
    botLogStream.write(`${text}\n`);
}

// Handle graceful close on exit to flush streams if needed
process.on('exit', () => {
    logStream.end();
    botLogStream.end();
});

module.exports = { appendBotLog };

const http = require('http');
const fs = require('fs');
const { fork, exec, execFile } = require('child_process');
const path = require('path');
const { getScheduledTasks, getStoredScheduledTasks, createSchedule, updateSchedule, deleteSchedule } = require('./src/scheduleTool');
const oldLog = console.log;
console.log = () => {}; // Suppress dotenv tip/verbose output
require('dotenv').config({ path: path.join('secrets', '.env'), quiet: true });
require('dotenv').config({ path: path.join('secrets', '.env_bot'), override: true, quiet: true });
console.log = oldLog;

const PORT = Number(process.env.PORT) || 3000;
const logFile = path.join('logs', 'log.txt');
const botLogFile = path.join('logs', 'bot_log.txt');

function resolveIssuerTargetForClient(clientName) {
    const normalized = String(clientName || '').trim().toLowerCase();
    if (normalized === 'whatsapp') return '';
    if (normalized === 'telegram') return '';
    return 'dashboard';
}
const waLogFile = path.join('logs', 'wa_log.txt');
const tgLogFile = path.join('logs', 'tg_log.txt');
const obLogFile = path.join('logs', 'ob_log.txt');
const queueFile = path.join('tmp', 'onboard_ui_queue.jsonl');
const tempDir = 'tmp';
const botScriptPath = path.resolve(__dirname, 'hclaw.js');
const isWindows = process.platform === 'win32';
const LOG_FILEPATH_REGEX = String.raw`(?:[a-zA-Z]:\\[^\n\)\`\'\"]*?\.[a-zA-Z0-9]{1,10})|(?:(?<=^)|(?<=[^a-zA-Z0-9]))(\./[^ \n\)\`\'\"]*?\.[a-zA-Z0-9]{1,10})|(?:(?<=^)|(?<=[^a-zA-Z0-9]))(/[^ \n\)\`\'\"]*?\.[a-zA-Z0-9]{1,10})\b|(?:\b|(?<=\s))([\w.-]+(?:[ ][\w.-]+)*(?:[\/\\][\w.-]+(?:[ ][\w.-]+)*)*\.[a-zA-Z0-9]{1,10})\b`;
const MAX_LOG_VIEW_LINES = 400;
const MAX_LOG_VIEW_CHARS = 120000;
let botProcess = null;
let botPid = null;
let startInFlight = false;

function isPidAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

function runExecFile(file, args) {
    return new Promise((resolve) => {
        execFile(file, args, { encoding: 'utf-8', timeout: 3000, windowsHide: true }, (err, stdout = '', stderr = '') => {
            resolve({ err, stdout, stderr });
        });
    });
}

function runExec(command) {
    return new Promise((resolve) => {
        exec(command, { encoding: 'utf-8', timeout: 3000, windowsHide: true }, (err, stdout = '', stderr = '') => {
            resolve({ err, stdout, stderr });
        });
    });
}

function parsePidList(output) {
    return String(output || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => parseInt(line, 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function parsePsProcessList(output) {
    return String(output || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const match = line.match(/^(\d+)\s+(.+)$/);
            if (!match) return null;
            return { pid: parseInt(match[1], 10), command: match[2] };
        })
        .filter((entry) => entry && Number.isInteger(entry.pid) && entry.pid > 0)
        .filter((entry) => entry.command.includes('hclaw.js'))
        .map((entry) => entry.pid);
}

function parseWmicProcessList(output) {
    return String(output || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => line.includes('hclaw.js'))
        .map((line) => {
            const parts = line.split(',');
            const pidText = parts[parts.length - 1];
            return parseInt(String(pidText || '').trim(), 10);
        })
        .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function waitForPidExit(pid, timeoutMs = 3000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (!isPidAlive(pid)) return true;
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return !isPidAlive(pid);
}

async function terminatePid(pid, force = false) {
    if (!pid || !isPidAlive(pid)) return true;

    if (isWindows) {
        const args = force ? ['/F', '/T', '/PID', String(pid)] : ['/T', '/PID', String(pid)];
        const result = await runExecFile('taskkill.exe', args);
        if (!result.err) return true;
        if (result.err && result.err.code === 'ENOENT') {
            try {
                process.kill(pid);
                return true;
            } catch (error) {
                return !isPidAlive(pid);
            }
        }
        return !isPidAlive(pid);
    }

    try {
        process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch (error) {
        return !isPidAlive(pid);
    }

    if (force) return !isPidAlive(pid);
    return waitForPidExit(pid, 3000);
}

async function findBotPids() {
    if (isWindows) {
        const ps = await runExecFile('powershell.exe', [
            '-NoProfile',
            '-Command',
            "Get-CimInstance Win32_Process | Where-Object { ($_.Name -match '^node(\\.exe)?$') -and $_.CommandLine -like '*hclaw.js*' } | Select-Object -ExpandProperty ProcessId"
        ]);
        if (!ps.err) return parsePidList(ps.stdout);

        const wmic = await runExecFile('wmic.exe', [
            'process',
            'where',
            "name='node.exe' or name='node'",
            'get',
            'CommandLine,ProcessId',
            '/FORMAT:CSV'
        ]);
        if (wmic.err) return [];
        return parseWmicProcessList(wmic.stdout);
    }

    const result = await runExec('pgrep -f "node.*hclaw\\.js"');
    if (!result.err) {
        return String(result.stdout || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => parseInt(line.split(/\s+/, 1)[0], 10))
            .filter((pid) => Number.isInteger(pid) && pid > 0);
    }

    const ps = await runExec('ps -ax -o pid= -o command=');
    if (ps.err) return [];
    return parsePsProcessList(ps.stdout);
}

async function isBotRunning() {
    if (botProcess && botProcess.connected) return true;
    if (botPid && isPidAlive(botPid)) return true;
    botPid = null;

    const externalPids = await findBotPids();
    if (externalPids.length > 0) {
        botPid = externalPids[0];
        return true;
    }

    return false;
}

async function startBot() {
    if (startInFlight) return;
    startInFlight = true;
    try {
        if (await isBotRunning()) return;
        botProcess = fork(botScriptPath, [], {
            cwd: __dirname,
            detached: true,
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'ignore', 'ipc']
        });
        botPid = botProcess.pid;
        botProcess.on('error', () => {
            botProcess = null;
        });
        botProcess.on('exit', () => {
            botProcess = null;
            botPid = null;
        });
        botProcess.unref();
    } catch (e) {
    } finally {
        startInFlight = false;
    }
}

async function stopBot() {
    const pidsToStop = new Set();
    if (botPid && isPidAlive(botPid)) {
        pidsToStop.add(botPid);
    }

    if (botProcess && botProcess.connected) {
        botProcess.send({ type: 'stop' });
        if (botPid) {
            const exited = await waitForPidExit(botPid, 3000);
            if (!exited) {
                await terminatePid(botPid, true);
            }
        }
    } else {
        try {
            const externalPids = await findBotPids();
            externalPids.forEach((pid) => pidsToStop.add(pid));
        } catch (e) {
        }
    }

    for (const pid of pidsToStop) {
        const exited = await terminatePid(pid, false);
        if (!exited) {
            await terminatePid(pid, true);
        }
    }

    botPid = null;
    if (botProcess && !botProcess.connected) {
        botProcess = null;
    }
}

async function restartBot() {
    await stopBot();
    await startBot();
}

async function readSystemLog() {
    try {
        return await fs.promises.readFile(logFile, 'utf8');
    } catch (error) {
        if (error && error.code === 'ENOENT') return '';
        throw error;
    }
}

async function readBotLog() {
    try {
        return await fs.promises.readFile(botLogFile, 'utf8');
    } catch (error) {
        if (error && error.code === 'ENOENT') return '';
        throw error;
    }
}

async function clearFile(filePath) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, '', 'utf8');
}

async function enqueueBridgeCommand(payload) {
    await fs.promises.mkdir(path.dirname(queueFile), { recursive: true });
    await fs.promises.appendFile(queueFile, `${JSON.stringify(payload)}\n`, 'utf8');
}

function parseModelEntries(rawValue, separator) {
    return String(rawValue || '')
        .split(separator)
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function getSettingsModelLists() {
    let models = [];
    let imageModels = [];

    try {
        const { getAvailableModels, getAvailableImageModels } = require('./src/Models');
        models = getAvailableModels();
        imageModels = getAvailableImageModels();
    } catch (error) {
    }

    if (!models.length) {
        models = parseModelEntries(process.env.AI_FALLBACK_ORDER, ',');
    }

    if (!imageModels.length) {
        imageModels = parseModelEntries(process.env.IMAGE_GENERATION_ORDER, ';');
    }

    return { models, imageModels };
}

function sanitizeUploadName(filename) {
    const ext = path.extname(String(filename || '')).toLowerCase();
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext) ? ext : '.png';
    const base = path.basename(String(filename || 'image'), ext).replace(/[^a-z0-9_-]/gi, '-').slice(0, 48) || 'image';
    return `${Date.now()}-${base}${safeExt}`;
}

async function saveUploadedImage(imageName, imageData) {
    const data = String(imageData || '');
    const marker = 'base64,';
    const index = data.indexOf(marker);
    const base64 = index === -1 ? data : data.slice(index + marker.length);
    if (!base64.trim()) {
        throw new Error('Image data is empty.');
    }

    await fs.promises.mkdir(tempDir, { recursive: true });
    const filePath = path.join(tempDir, sanitizeUploadName(imageName));
    await fs.promises.writeFile(filePath, Buffer.from(base64, 'base64'));
    return filePath;
}

function readEnvBotSettings() {
    const envBotPath = path.join('secrets', '.env_bot');
    let historyLimit = 10;
    let defaultBotModel = 1;
    let defaultImageModel = 1;

    if (fs.existsSync(envBotPath)) {
        const content = fs.readFileSync(envBotPath, 'utf8');
        const matchLimit = content.match(/^BOT_LOG_HISTORY_LIMIT=(\d+)/m);
        const matchModel = content.match(/^DEFAULT_BOT_MODEL=(\d+)/m);
        const matchImageModel = content.match(/^DEFAULT_IMAGE_MODEL=(\d+)/m);
        if (matchLimit) historyLimit = parseInt(matchLimit[1], 10);
        if (matchModel) defaultBotModel = parseInt(matchModel[1], 10);
        if (matchImageModel) defaultImageModel = parseInt(matchImageModel[1], 10);
    }

    return { historyLimit, defaultBotModel, defaultImageModel };
}

async function buildFilteredLog(source) {
    const rawContent = await readSystemLog();
    if (!rawContent) {
        if (source === 'wa') await clearFile(waLogFile);
        if (source === 'tg') await clearFile(tgLogFile);
        if (source === 'ob') await clearFile(obLogFile);
        return '';
    }

    const lines = rawContent.split(/\r?\n/);
    let filteredLines = [];
    let targetFile = null;

    if (source === 'wa') {
        filteredLines = lines.filter((line) => line.includes(' WA '));
        targetFile = waLogFile;
    } else if (source === 'tg') {
        filteredLines = lines.filter((line) => line.includes(' TG '));
        targetFile = tgLogFile;
    } else if (source === 'ob') {
        filteredLines = lines.filter((line) => line.includes('[OB]') || line.includes('[OnBoard]'));
        targetFile = obLogFile;
    } else {
        return rawContent;
    }

    const filteredContent = filteredLines.join('\n');
    await fs.promises.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.promises.writeFile(targetFile, filteredContent, 'utf8');
    return filteredContent;
}

function trimLogForUi(content) {
    const text = String(content || '');
    if (!text) return '';

    let trimmed = text;
    let wasTrimmed = false;

    if (trimmed.length > MAX_LOG_VIEW_CHARS) {
        trimmed = trimmed.slice(-MAX_LOG_VIEW_CHARS);
        const firstNewline = trimmed.indexOf('\n');
        if (firstNewline !== -1) {
            trimmed = trimmed.slice(firstNewline + 1);
        }
        wasTrimmed = true;
    }

    const lines = trimmed.split(/\r?\n/);
    if (lines.length > MAX_LOG_VIEW_LINES) {
        trimmed = lines.slice(-MAX_LOG_VIEW_LINES).join('\n');
        wasTrimmed = true;
    }

    if (!wasTrimmed) return trimmed;
    return `[UI] Showing the most recent ${MAX_LOG_VIEW_LINES} lines / ${MAX_LOG_VIEW_CHARS} characters.\n${trimmed}`;
}

function resolveWorkspaceFilePath(fileParam) {
    const rawPath = String(fileParam || '').trim();
    if (!rawPath) return null;

    const candidatePaths = [];
    if (path.isAbsolute(rawPath)) {
        candidatePaths.push(path.normalize(rawPath));
    } else {
        candidatePaths.push(path.normalize(path.join(__dirname, rawPath)));

        const basename = path.basename(rawPath);
        if (basename === rawPath) {
            ['secrets', 'logs', 'tmp', 'MD', 'src', 'assets', 'utils'].forEach((dir) => {
                candidatePaths.push(path.normalize(path.join(__dirname, dir, rawPath)));
            });
        }
    }

    const normDirname = path.normalize(__dirname + path.sep);
    for (const candidate of candidatePaths) {
        const normalizedCandidate = path.normalize(candidate);
        if (!normalizedCandidate.startsWith(normDirname) && normalizedCandidate !== path.normalize(__dirname)) {
            continue;
        }
        if (fs.existsSync(normalizedCandidate)) {
            return normalizedCandidate;
        }
    }

    return candidatePaths[0] || null;
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>H-Claw OnBoard</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
    <style>
        :root {
            --bg: #f4f6f7;
            --panel: rgba(255, 255, 255, 0.96);
            --sidebar: linear-gradient(180deg, #fcfcfc 0%, #f6f8fa 100%);
            --line: #d9dfe3;
            --line-strong: #cfd6db;
            --text: #12161c;
            --muted: #6f7e8c;
            --brand: #51475e;
            --success: #2ea57f;
            --danger: #e3392a;
            --status: #98938e;
            --soft-active: #dfeeea;
            --soft-active-text: #0d5b48;
            --send: #1e1e21;
            --shadow: 0 18px 40px rgba(18, 22, 28, 0.06);
        }

        * {
            box-sizing: border-box;
        }

        html,
        body {
            min-height: 100%;
            overflow: hidden;
        }

        body {
            margin: 0;
            background:
                radial-gradient(circle at top left, rgba(255, 255, 255, 0.85) 0, rgba(255, 255, 255, 0) 32%),
                linear-gradient(180deg, #fbfbfa 0%, var(--bg) 100%);
            color: var(--text);
            font-family: "Plus Jakarta Sans", "Segoe UI", sans-serif;
            overflow: hidden;
        }

        button,
        input,
        select {
            font: inherit;
        }

        .filepath-link {
            text-decoration: underline;
            color: #2563eb;
            cursor: pointer;
            transition: opacity 0.2s ease;
        }
        .filepath-link:hover {
            opacity: 0.8;
        }

        .app-shell {
            min-height: 100vh;
            height: 100vh;
            display: flex;
            overflow: hidden;
        }

        .sidebar {
            width: clamp(250px, 22vw, 320px);
            background: var(--sidebar);
            border-right: 1px solid var(--line);
            padding: 18px 10px 20px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            min-height: 0;
            overflow-x: hidden;
            overflow-y: auto;
            scrollbar-gutter: stable;
        }

        .brand {
            display: flex;
            align-items: center;
            gap: 18px;
            padding: 8px 16px 16px;
        }

        .brand-mark {
            position: relative;
            width: 30px;
            height: 28px;
            flex: 0 0 auto;
            color: var(--brand);
        }

        .paw {
            position: absolute;
            line-height: 1;
        }

        .paw-1 {
            top: 0;
            left: 1px;
            font-size: 11px;
        }

        .paw-2 {
            top: 8px;
            left: 10px;
            font-size: 14px;
        }

        .paw-3 {
            top: 15px;
            left: 0;
            font-size: 12px;
        }

        .brand-title {
            margin: 0;
            font-size: 19px;
            font-weight: 700;
            letter-spacing: -0.03em;
        }

        .sidebar-section {
            padding: 2px 0 0;
        }

        .section-heading {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 16px;
            width: 100%;
            border: 0;
            background: transparent;
            color: var(--muted);
            font-size: 15px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.07em;
            cursor: pointer;
            transition: color 160ms ease;
        }

        .section-heading:hover {
            color: var(--text);
        }

        .section-heading i {
            transition: transform 160ms ease;
        }

        .sidebar-section.collapsed .section-heading i {
            transform: rotate(-90deg);
        }

        .section-items {
            display: flex;
            flex-direction: column;
            gap: 6px;
            overflow: hidden;
            max-height: 500px;
            transition: max-height 180ms ease, opacity 180ms ease, margin-top 180ms ease;
        }

        .sidebar-section.collapsed .section-items {
            max-height: 0;
            opacity: 0;
            margin-top: 0;
        }

        .nav-item {
            width: 100%;
            border: 0;
            background: transparent;
            color: var(--text);
            text-align: left;
            display: flex;
            align-items: center;
            gap: 18px;
            padding: 14px 16px;
            border-radius: 14px;
            cursor: pointer;
            transition: background 160ms ease, color 160ms ease, transform 160ms ease;
        }

        .nav-item:hover {
            background: rgba(223, 238, 234, 0.45);
        }

        .nav-item:focus-visible {
            outline: 2px solid rgba(13, 91, 72, 0.22);
            outline-offset: 2px;
        }

        .nav-item i {
            width: 26px;
            text-align: center;
            font-size: 23px;
            color: #48505e;
        }

        .nav-item span {
            font-size: 18px;
            font-weight: 500;
        }

        .nav-item.active {
            background: var(--soft-active);
            color: var(--soft-active-text);
            transform: translateX(1px);
        }

        .nav-item.active i {
            color: var(--soft-active-text);
        }

        .main-shell {
            flex: 1;
            min-width: 0;
            min-height: 0;
            display: flex;
            flex-direction: column;
            background: linear-gradient(180deg, rgba(255, 255, 255, 0.84) 0%, rgba(250, 251, 252, 0.96) 100%);
            overflow: hidden;
        }

        .topbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 18px;
            padding: 18px 24px 16px 28px;
            border-bottom: 1px solid var(--line);
            background: rgba(255, 255, 255, 0.9);
            backdrop-filter: blur(10px);
        }

        .topbar-title {
            display: flex;
            align-items: center;
            gap: 16px;
            min-width: 0;
        }

        .topbar-title h2 {
            margin: 0;
            font-size: 26px;
            font-weight: 500;
            letter-spacing: -0.045em;
        }

        .topbar-controls {
            display: flex;
            align-items: center;
            gap: 12px;
            flex-wrap: wrap;
            justify-content: flex-end;
        }

        .action-pill {
            height: 46px;
            border: 0;
            border-radius: 11px;
            padding: 0 18px;
            display: inline-flex;
            align-items: center;
            gap: 10px;
            color: #fff;
            font-size: 17px;
            font-weight: 700;
            box-shadow: var(--shadow);
        }

        .action-pill.start {
            background: #22c55e;
        }

        .action-pill.stop {
            background: #ef4444;
        }

        .action-pill.restart {
            background: #0ea5b7;
        }

        .action-pill:disabled,
        .nav-item:disabled {
            cursor: not-allowed;
            box-shadow: none;
            transform: none;
        }

        .action-pill:disabled {
            opacity: 0.82;
        }

        .nav-item:disabled {
            opacity: 0.52;
        }

        .action-pill.start:disabled {
            background: #4ade80;
            opacity: 0.45;
            color: #fff;
        }

        .action-pill.stop:disabled {
            background: #fca5a5;
            opacity: 0.45;
            color: #fff;
        }

        .action-pill.restart:disabled {
            background: #67e8f9;
            opacity: 0.45;
            color: #fff;
        }

        .action-pill:disabled:hover {
            background: unset;
        }

        .action-pill.start:disabled:hover {
            background: #2ea57f;
        }

        .action-pill.stop:disabled:hover {
            background: #e3392a;
        }

        .action-pill.restart:disabled:hover {
            background: #15b7cc;
        }

        .nav-item:disabled:hover {
            background: transparent;
        }

        .status-pill {
            height: 38px;
            border: 0;
            border-radius: 999px;
            padding: 0 16px;
            background: var(--status);
            color: #fff;
            font-size: 16px;
            font-weight: 700;
        }

        .workspace {
            flex: 1;
            min-height: 0;
            display: flex;
            flex-direction: column;
            position: relative;
        }

        .workspace.hidden {
            display: none;
        }

        .workspace-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            padding: 20px 24px 12px;
            border-bottom: 1px solid #e7ecef;
        }

        .workspace-label {
            display: flex;
            align-items: center;
            gap: 14px;
            font-size: 17px;
            font-weight: 700;
        }

        .workspace-label i {
            font-size: 22px;
        }

        .clean-btn {
            min-height: 40px;
            padding: 0 16px;
            border: 1px solid var(--line-strong);
            border-radius: 12px;
            background: var(--panel);
            color: var(--text);
            display: inline-flex;
            align-items: center;
            gap: 9px;
            font-size: 16px;
            font-weight: 500;
            box-shadow: 0 4px 10px rgba(18, 22, 28, 0.03);
        }

        .chat-stage {
            flex: 1;
            min-height: 0;
            padding: 12px 24px 16px;
            display: flex;
        }

        .log-container {
            flex: 1;
            display: flex;
            min-height: 0;
            background: rgba(255, 255, 255, 0.92);
            border: 1px solid var(--line);
            border-radius: 16px;
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9);
            overflow: hidden;
            padding-right: 6px;
        }

        .gutter {
            padding: 16px 8px;
            background: #f1f5f9;
            color: #64748b;
            text-align: right;
            font-family: "Cascadia Code", "Consolas", monospace;
            font-size: 15px;
            line-height: 1.45;
            user-select: none;
            border-right: 1px solid var(--line);
            overflow-y: hidden;
            min-width: 60px;
        }

        .gutter-line {
            box-sizing: border-box;
            min-height: 1.45em;
        }

        .log-line {
            min-height: 1.45em;
        }

        .chat-board {
            flex: 1 1 auto;
            min-width: 0;
            min-height: 0;
            background: transparent;
            border: none;
            border-radius: 0;
            overflow-y: scroll;
            width: auto;
            margin-right: 4px;
            padding: 16px 20px 16px 18px;
            box-sizing: border-box;
            color: #1c2733;
            font-family: "Cascadia Code", "Consolas", monospace;
            font-size: 15px;
            line-height: 1.45;
            resize: none;
            cursor: text;
            user-select: text;
            white-space: pre;
            overflow-x: auto;
            scrollbar-gutter: stable;
        }

        div.chat-board {
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            overflow-x: hidden;
        }

        .chat-board:focus {
            outline: 2px solid rgba(13, 91, 72, 0.18);
            border-color: #b8c9c4;
        }

        .log-pane {
            flex: 1;
            min-height: 0;
            display: none;
        }

        .log-pane.visible {
            display: flex;
        }

        .settings-pane {
            flex: 1 1 auto;
            min-width: 0;
            min-height: 0;
            display: none;
            flex-direction: column;
            gap: 16px;
            padding: 20px 28px 16px 24px;
            overflow-y: auto;
            box-sizing: border-box;
            scrollbar-gutter: stable;
        }

        .settings-pane.visible {
            display: flex;
        }

        .settings-card {
            max-width: 560px;
            border: 1px solid var(--line);
            border-radius: 18px;
            background: rgba(255, 255, 255, 0.94);
            padding: 18px 20px;
            display: flex;
            flex-direction: column;
            gap: 12px;
            box-shadow: 0 14px 32px rgba(18, 22, 28, 0.04);
        }

        .settings-card h3 {
            margin: 0;
            font-size: 21px;
        }

        .settings-card p {
            margin: 0;
            color: #66707b;
            font-size: 16px;
            line-height: 1.45;
        }

        .settings-field {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .settings-field label {
            font-size: 16px;
            font-weight: 600;
            color: #2b3440;
        }

        .settings-input {
            max-width: 260px;
            height: 46px;
            border: 1px solid var(--line-strong);
            border-radius: 12px;
            background: #fff;
            padding: 0 14px;
            outline: none;
        }

        .settings-note {
            font-size: 15px;
            color: var(--muted);
        }

        .chat-board::-webkit-scrollbar {
            width: 16px;
            height: 16px;
        }

        .chat-board::-webkit-scrollbar-track {
            background: #eef2f6;
            border-left: 1px solid #dde4ea;
        }

        .chat-board::-webkit-scrollbar-thumb {
            border: 3px solid #eef2f6;
            border-radius: 999px;
            background: #8b96a5;
            background-clip: padding-box;
            min-height: 36px;
        }

        .chat-board {
            scrollbar-color: #8b96a5 #eef2f6;
            scrollbar-width: auto;
        }

        .settings-pane::-webkit-scrollbar {
            width: 16px;
        }

        .settings-pane::-webkit-scrollbar-track {
            background: #eef2f6;
            border-left: 1px solid #dde4ea;
        }

        .settings-pane::-webkit-scrollbar-thumb {
            border: 3px solid #eef2f6;
            border-radius: 999px;
            background: #8b96a5;
            background-clip: padding-box;
            min-height: 36px;
        }

        .settings-pane {
            scrollbar-color: #8b96a5 #eef2f6;
            scrollbar-width: auto;
        }

        .composer-wrap {
            padding: 8px 0 0;
        }

        .composer-card {
            margin: 0 0 0;
            border-top: 1px solid transparent;
            border-radius: 20px 20px 0 0;
            background: transparent;
            padding: 10px 24px 0;
        }

        .composer-panel {
            border: 1px solid var(--line);
            border-radius: 18px;
            background: rgba(255, 255, 255, 0.94);
            padding: 18px 20px 20px;
            box-shadow: 0 14px 32px rgba(18, 22, 28, 0.04);
        }

        .composer-row {
            display: flex;
            align-items: center;
            gap: 14px;
        }

        .composer-select,
        .composer-input {
            height: 50px;
            border: 1px solid var(--line-strong);
            border-radius: 14px;
            background: #fff;
            color: var(--text);
            padding: 0 18px;
            outline: none;
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9);
        }

        .composer-select {
            width: 170px;
            appearance: auto;
        }

        .composer-target {
            width: 185px;
        }

        .composer-message {
            flex: 1;
            min-width: 0;
        }

        .send-btn {
            width: 50px;
            height: 50px;
            border: 0;
            border-radius: 50%;
            background: var(--send);
            color: #fff;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 21px;
            box-shadow: var(--shadow);
        }

        .attach-btn {
            width: 50px;
            height: 50px;
            border: 1px solid var(--line-strong);
            border-radius: 14px;
            background: #fff;
            color: var(--brand);
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 19px;
            cursor: pointer;
        }

        .attach-btn.has-file {
            background: var(--soft-active);
            color: var(--soft-active-text);
            border-color: #bcd8d0;
        }

        .composer-file {
            display: none;
        }

        .composer-hint {
            margin: 12px 0 0;
            color: var(--muted);
            font-size: 16px;
            line-height: 1.45;
        }

        .composer-meta {
            margin-top: 10px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
        }

        .composer-attachment {
            font-size: 15px;
            color: var(--muted);
            min-width: 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .composer-attachment.hidden {
            display: none;
        }

        @media (max-width: 1160px) {
            .sidebar {
                width: 280px;
            }

            .composer-row {
                flex-wrap: wrap;
            }

            .composer-select,
            .composer-target {
                flex: 1 1 220px;
                width: auto;
            }

            .composer-message {
                flex-basis: 100%;
            }
        }

        @media (max-width: 900px) {
            .app-shell {
                flex-direction: column;
                height: auto;
                min-height: 100vh;
                overflow: auto;
            }

            .sidebar {
                width: 100%;
                max-height: 42vh;
                flex: 0 0 auto;
                border-right: 0;
                border-bottom: 1px solid var(--line);
            }

            .main-shell {
                min-height: 0;
                flex: 1 1 auto;
            }

            .topbar,
            .workspace-header,
            .chat-stage,
            .composer-card {
                padding-left: 16px;
                padding-right: 16px;
            }
        }

        @media (max-width: 640px) {
            .topbar {
                align-items: flex-start;
                padding-top: 20px;
                padding-bottom: 18px;
            }

            .topbar,
            .workspace-header {
                flex-direction: column;
            }

            .topbar-controls {
                width: 100%;
                justify-content: flex-start;
            }

            .action-pill {
                min-width: 120px;
                justify-content: center;
            }

            .composer-panel {
                padding: 18px;
            }

            .composer-row {
                align-items: stretch;
            }

            .composer-select,
            .composer-target,
            .composer-message,
            .attach-btn,
            .send-btn {
                width: 100%;
            }

            .composer-meta {
                flex-direction: column;
                align-items: flex-start;
            }

            .send-btn {
                border-radius: 16px;
                height: 50px;
            }

            .filepath-link {
                color: #2ea57f;
                text-decoration: underline;
                cursor: pointer;
                font-weight: 500;
            }
            .filepath-link:hover {
                color: #248566;
            }
        }
    </style>
</head>
<body>
    <div class="app-shell">
        <aside class="sidebar" aria-label="Sidebar">
            <div class="brand">
                <div class="brand-mark" aria-hidden="true">
                    <i class="fa-solid fa-paw paw paw-1"></i>
                    <i class="fa-solid fa-paw paw paw-2"></i>
                    <i class="fa-solid fa-paw paw paw-3"></i>
                </div>
                <h1 class="brand-title">H-Claw OnBoard</h1>
            </div>

            <section class="sidebar-section collapsed" aria-label="Actions">
                <button class="section-heading" type="button" data-section-toggle aria-expanded="false">
                    <span>Actions</span>
                    <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
                </button>
                <div class="section-items">
                    <button class="nav-item" id="sidebar-start-btn" type="button" data-sidebar-item>
                        <i class="fa-solid fa-play" aria-hidden="true"></i>
                        <span>Start Bot</span>
                    </button>
                    <button class="nav-item" id="sidebar-stop-btn" type="button" data-sidebar-item>
                        <i class="fa-solid fa-stop" aria-hidden="true" style="color: var(--danger);"></i>
                        <span>Stop Bot</span>
                    </button>
                    <button class="nav-item" id="sidebar-clear-tmp-btn" type="button" data-sidebar-item>
                        <i class="fa-solid fa-eraser" aria-hidden="true" style="color: var(--danger);"></i>
                        <span>Clear Tmp</span>
                    </button>
                </div>
            </section>



            <section class="sidebar-section collapsed" aria-label="Documents">
                <button class="section-heading" type="button" data-section-toggle aria-expanded="false">
                    <span>Documents</span>
                    <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
                </button>
                <div class="section-items" id="md-file-list">
                    <!-- filled dynamically -->
                </div>
            </section>

            <section class="sidebar-section" aria-label="Views">
                <button class="section-heading" type="button" data-section-toggle aria-expanded="true">
                    <span>Views</span>
                    <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
                </button>
                <div class="section-items">
                    <button class="nav-item" id="nav-wa-log" type="button" data-sidebar-item>
                        <i class="fa-brands fa-whatsapp" aria-hidden="true"></i>
                        <span>WhatsApp</span>
                    </button>
                    <button class="nav-item" id="nav-tg-log" type="button" data-sidebar-item>
                        <i class="fa-brands fa-telegram" aria-hidden="true"></i>
                        <span>Telegram</span>
                    </button>
                    <button class="nav-item" id="nav-ob-log" type="button" data-sidebar-item>
                        <i class="fa-solid fa-display" aria-hidden="true"></i>
                        <span>OnBoard</span>
                    </button>
                    <button class="nav-item active" id="nav-system-chat" type="button" aria-current="page" data-sidebar-item>
                        <i class="fa-regular fa-rectangle-list" aria-hidden="true"></i>
                        <span>System Chat</span>
                    </button>
                    <button class="nav-item" id="nav-bot-logs" type="button" data-sidebar-item>
                        <i class="fa-solid fa-file-invoice" aria-hidden="true"></i>
                        <span>Bot Logs</span>
                    </button>
                    <button class="nav-item" id="nav-settings" type="button" data-sidebar-item>
                        <i class="fa-solid fa-sliders" aria-hidden="true"></i>
                        <span>Settings</span>
                    </button>
                    <button class="nav-item" id="nav-schedule" type="button" data-sidebar-item>
                        <i class="fa-solid fa-calendar-check" aria-hidden="true"></i>
                        <span>Manage Tasks</span>
                    </button>
                </div>
            </section>
        </aside>

        <main class="main-shell">
            <header class="topbar">
                <div class="topbar-title">
                    <div class="brand-mark" aria-hidden="true">
                        <i class="fa-solid fa-paw paw paw-1"></i>
                        <i class="fa-solid fa-paw paw paw-2"></i>
                        <i class="fa-solid fa-paw paw paw-3"></i>
                    </div>
                    <h2>H-Claw Admin</h2>
                </div>

                <div class="topbar-controls">
                    <button class="action-pill start" id="start-btn" type="button">
                        <i class="fa-solid fa-play" aria-hidden="true"></i>
                        <span>Start</span>
                    </button>
                    <button class="action-pill stop" id="stop-btn" type="button">
                        <i class="fa-solid fa-stop" aria-hidden="true"></i>
                        <span>Stop</span>
                    </button>
                    <button class="action-pill restart" id="restart-btn" type="button">
                        <i class="fa-solid fa-rotate-right" aria-hidden="true"></i>
                        <span>Restart</span>
                    </button>
                    <button class="status-pill" id="status-pill" type="button">Checking...</button>
                </div>
            </header>

            <section class="workspace" aria-label="System chat workspace">
                <div class="workspace-header">
                    <div class="workspace-label">
                        <i class="fa-regular fa-rectangle-list" id="workspace-icon" aria-hidden="true"></i>
                        <span id="workspace-title">System Chat</span>
                    </div>
                    <button class="clean-btn" id="clean-system-log-btn" type="button">
                        <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
                        <span>Clean</span>
                    </button>
                    <button class="clean-btn" id="clean-bot-log-btn" type="button" style="display: none;">
                        <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
                        <span>Clean</span>
                    </button>
                    <button class="clean-btn" id="save-md-btn" type="button" style="display: none;">
                        <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i>
                        <span>Save</span>
                    </button>
                </div>

                <div class="chat-stage">
                    <div class="log-pane visible" id="system-log-pane">
                        <div class="log-container">
                            <div class="gutter" id="system-gutter"></div>
                            <div class="chat-board" id="system-chat-log" onscroll="syncGutter('system')"></div>
                        </div>
                    </div>
                    <div class="log-pane" id="bot-log-pane" aria-hidden="true">
                        <div class="log-container">
                            <div class="gutter" id="bot-gutter"></div>
                            <div class="chat-board" id="bot-log-viewer" onscroll="syncGutter('bot')"></div>
                        </div>
                    </div>
                    <div class="log-pane" id="editor-pane" aria-hidden="true">
                        <div class="log-container">
                            <div class="gutter" id="editor-gutter"></div>
                            <textarea class="chat-board" id="editor-textarea" spellcheck="false" placeholder="Loading file..." onscroll="syncGutter('editor')"></textarea>
                        </div>
                    </div>
                </div>

                <div class="composer-wrap">
                    <div class="composer-card">
                        <div class="composer-panel">
                            <div class="composer-row">
                                <select class="composer-select" id="composer-platform" aria-label="Platform">
                                    <option value="onboard" selected>OnBoard</option>
                                    <option value="whatsapp">WhatsApp</option>
                                    <option value="telegram">Telegram</option>
                                </select>
                                <input class="composer-input composer-target" id="composer-target" type="text" placeholder="Recipient ID" aria-label="Recipient ID">
                                <input class="composer-input composer-message" id="composer-text" type="text" placeholder="Message H-Claw..." aria-label="Message" list="composer-history-list" autocomplete="off">
                                <datalist id="composer-history-list"></datalist>
                                <label class="attach-btn" for="composer-image" id="composer-image-btn" aria-label="Attach image">
                                    <i class="fa-regular fa-image" aria-hidden="true"></i>
                                </label>
                                <input class="composer-file" id="composer-image" type="file" accept="image/*">
                                <button class="send-btn" id="composer-send-btn" type="button" aria-label="Send message">
                                    <i class="fa-solid fa-arrow-up" aria-hidden="true"></i>
                                </button>
                            </div>
                            <div class="composer-meta">
                                <p class="composer-hint" id="composer-hint">Send a message through OnBoard, WhatsApp, or Telegram.</p>
                                <span class="composer-attachment hidden" id="composer-attachment-name"></span>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <section class="settings-pane" id="settings-pane" aria-label="Settings">
                <div class="settings-card">
                    <h3>Bot Context</h3>
                    <p>Control how much recent OnBoard conversation is injected into the next bot prompt.</p>
                    <div class="settings-field">
                        <label for="history-limit">Injected History Messages</label>
                        <input class="settings-input" id="history-limit" type="number" min="0" max="50" step="1">
                        <div class="settings-note">Set to 0 for no injected history. Higher values add more prior OnBoard turns to prompt context.</div>
                    </div>
                </div>

                <div class="settings-card">
                    <h3>Bot Model</h3>
                    <p>Select the default AI model to use for bot operations.</p>
                    <div class="settings-field">
                        <label for="default-bot-model">Default Bot Model</label>
                        <select class="settings-input" id="default-bot-model"></select>
                    </div>
                </div>

                <div class="settings-card">
                    <h3>Image Model</h3>
                    <p>Select the default AI model to use for image generation operations.</p>
                    <div class="settings-field">
                        <label for="default-image-model">Default Image Model</label>
                        <select class="settings-input" id="default-image-model"></select>
                    </div>
                </div>
            </section>

            <section class="settings-pane" id="schedule-pane" aria-label="Scheduled Tasks">
                <div class="settings-card" style="max-width:100%;">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
                        <h3 style="margin:0;">Scheduled Tasks</h3>
                        <button id="add-task-btn" class="action-pill start" type="button">
                            <i class="fa-solid fa-plus" aria-hidden="true"></i>
                            <span>Add Task</span>
                        </button>
                    </div>
                    <div id="schedule-table-wrap"><p style="color:var(--muted);margin:0;">Loading...</p></div>
                </div>
            </section>
        </main>
    </div>

    <div id="schedule-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.48);z-index:2000;align-items:center;justify-content:center;">
        <div id="schedule-modal-panel" style="background:var(--panel);border-radius:16px;padding:28px 32px;min-width:360px;max-width:520px;width:90%;box-shadow:0 8px 40px rgba(0,0,0,0.22);">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
                <h3 id="sched-modal-title" style="margin:0;font-size:17px;font-weight:700;">Add Scheduled Task</h3>
            </div>
            <div style="display:flex;flex-direction:column;gap:14px;">
                <div>
                    <label style="font-size:14px;font-weight:600;display:block;margin-bottom:4px;">Start</label>
                    <input id="sched-start" type="datetime-local" step="60" style="width:100%;height:40px;border:1px solid var(--line-strong);border-radius:8px;padding:0 12px;font-size:14px;background:var(--bg);color:var(--text);box-sizing:border-box;">
                </div>
                <div>
                    <label style="font-size:14px;font-weight:600;display:block;margin-bottom:4px;">Stop</label>
                    <input id="sched-stop" type="datetime-local" step="60" style="width:100%;height:40px;border:1px solid var(--line-strong);border-radius:8px;padding:0 12px;font-size:14px;background:var(--bg);color:var(--text);box-sizing:border-box;">
                </div>
                <div>
                    <label style="font-size:14px;font-weight:600;display:block;margin-bottom:4px;">Step Time</label>
                    <input id="sched-step" type="text" inputmode="text" placeholder="30m, 30 m, 1h, or 1 h" style="width:100%;height:40px;border:1px solid var(--line-strong);border-radius:8px;padding:0 12px;font-size:14px;background:var(--bg);color:var(--text);box-sizing:border-box;">
                </div>
                <label style="display:flex;align-items:center;gap:10px;font-size:14px;font-weight:600;cursor:pointer;">
                    <input id="sched-run-once" type="checkbox">
                    <span>Run Once</span>
                </label>
                <div>
                    <label style="font-size:14px;font-weight:600;display:block;margin-bottom:4px;">Status</label>
                    <select id="sched-status" style="width:100%;height:40px;border:1px solid var(--line-strong);border-radius:8px;padding:0 12px;font-size:14px;background:var(--bg);color:var(--text);box-sizing:border-box;">
                        <option value="enabled">Enabled</option>
                        <option value="disabled">Disabled</option>
                    </select>
                </div>
                <div>
                    <label style="font-size:14px;font-weight:600;display:block;margin-bottom:4px;">Target Client</label>
                    <select id="sched-issuer-client" style="width:100%;height:40px;border:1px solid var(--line-strong);border-radius:8px;padding:0 12px;font-size:14px;background:var(--bg);color:var(--text);box-sizing:border-box;">
                        <option value="onboard">OnBoard</option>
                        <option value="whatsapp">WhatsApp</option>
                        <option value="telegram">Telegram</option>
                    </select>
                </div>
                <div>
                    <label style="font-size:14px;font-weight:600;display:block;margin-bottom:4px;">Next Run Time</label>
                    <input id="sched-next-run" type="text" readonly style="width:100%;height:40px;border:1px solid var(--line-strong);border-radius:8px;padding:0 12px;font-size:14px;background:#f8fafc;color:var(--muted);box-sizing:border-box;">
                </div>
                <div>
                    <label style="font-size:14px;font-weight:600;display:block;margin-bottom:4px;">Prompt</label>
                    <textarea id="sched-prompt" rows="4" placeholder="What should the bot do at this time?" style="width:100%;border:1px solid var(--line-strong);border-radius:8px;padding:10px 12px;font-size:14px;background:var(--bg);color:var(--text);resize:vertical;box-sizing:border-box;font-family:inherit;"></textarea>
                </div>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:22px;">
                <button id="sched-cancel-btn" type="button" style="padding:9px 20px;border-radius:10px;border:1px solid var(--line-strong);background:var(--bg);color:var(--text);font-size:14px;cursor:pointer;">Cancel</button>
                <button id="sched-save-btn" class="action-pill start" type="button" style="font-size:14px;padding:9px 22px;">Save Task</button>
            </div>
        </div>
    </div>

    <div id="filepath-tooltip" style="display: none; position: absolute; background: #1e1e24; border: 1px solid #333; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); padding: 10px; z-index: 1000; max-width: 400px; max-height: 300px; overflow: auto; pointer-events: auto;" onmouseenter="clearTimeout(window.hideTooltipTimeout)" onmouseleave="window.hideFileTooltip && window.hideFileTooltip()"></div>
    <script>
        const sidebarItems = document.querySelectorAll('[data-sidebar-item]');
        const startBtn = document.getElementById('start-btn');
        const stopBtn = document.getElementById('stop-btn');
        const restartBtn = document.getElementById('restart-btn');
        const sidebarStartBtn = document.getElementById('sidebar-start-btn');
        const sidebarStopBtn = document.getElementById('sidebar-stop-btn');
        const navWaLog = document.getElementById('nav-wa-log');
        const navTgLog = document.getElementById('nav-tg-log');
        const navObLog = document.getElementById('nav-ob-log');
        const navSystemChat = document.getElementById('nav-system-chat');
        const navBotLogs = document.getElementById('nav-bot-logs');
        const navSettings = document.getElementById('nav-settings');
        const statusPill = document.getElementById('status-pill');
        const workspaceIcon = document.getElementById('workspace-icon');
        const workspaceTitle = document.getElementById('workspace-title');
        const workspace = document.querySelector('.workspace');
        const settingsPane = document.getElementById('settings-pane');
        const schedulePane = document.getElementById('schedule-pane');
        const systemLogPane = document.getElementById('system-log-pane');
        const botLogPane = document.getElementById('bot-log-pane');
        const systemChatLog = document.getElementById('system-chat-log');
        const botLogViewer = document.getElementById('bot-log-viewer');
        const composerPlatform = document.getElementById('composer-platform');
        const composerTarget = document.getElementById('composer-target');
        const composerText = document.getElementById('composer-text');
        const composerHistoryList = document.getElementById('composer-history-list');
        const composerImageInput = document.getElementById('composer-image');
        const composerImageBtn = document.getElementById('composer-image-btn');
        const composerAttachmentName = document.getElementById('composer-attachment-name');
        const composerSendBtn = document.getElementById('composer-send-btn');
        const composerHint = document.getElementById('composer-hint');
        const cleanSystemLogBtn = document.getElementById('clean-system-log-btn');
        const cleanBotLogBtn = document.getElementById('clean-bot-log-btn');
        const sidebarClearTmpBtn = document.getElementById('sidebar-clear-tmp-btn');
        const mdFileList = document.getElementById('md-file-list');
        const saveMdBtn = document.getElementById('save-md-btn');
        const editorPane = document.getElementById('editor-pane');
        const editorTextarea = document.getElementById('editor-textarea');
        const historyLimitInput = document.getElementById('history-limit');
        let activeMdFile = '';
        const defaultBotModelSelect = document.getElementById('default-bot-model');
        const defaultImageModelSelect = document.getElementById('default-image-model');
        const sectionToggles = document.querySelectorAll('[data-section-toggle]');
        let actionInFlight = false;
        let lastLogText = '';
        let lastBotLogText = '';
        let activeView = 'system';
        let activeConversationSource = 'system';
        let sendInFlight = false;
        let settingsLoaded = false;
        const composerHistoryStorageKey = 'hclaw-onboard-composer-history';
        const composerHistory = [];
        let composerHistoryIndex = -1;
        let composerDraft = '';
        let composerImagePayload = null;
        const logPathRegex = new RegExp('${LOG_FILEPATH_REGEX.replace(/\\/g, "\\\\").replace(/\'/g, () => "\\\'")}', 'g');

        function escapeHtml(text) {
            if (!text) return '';
            const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
            return text.replace(/[&<>"']/g, m => map[m]);
        }

        function isLikelyWorkspaceFilePath(value) {
            const candidate = String(value || '').trim();
            if (!candidate) return false;
            if (candidate === '.' || candidate === '..') return false;

            const normalized = candidate.split('\\\\').join('/');
            const hasDirectory = normalized.includes('/');
            const basename = normalized.split('/').pop() || normalized;
            const extensionMatch = basename.match(/[.]([a-zA-Z0-9]{1,10})$/);
            const extension = extensionMatch ? extensionMatch[1].toLowerCase() : '';
            const allowedExtensions = new Set([
                'env', 'example', 'json', 'jsonl', 'js', 'cjs', 'mjs', 'ts', 'tsx', 'jsx',
                'md', 'txt', 'log', 'css', 'html', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg',
                'mp3', 'wav', 'ogg', 'm4a', 'yml', 'yaml', 'csv', 'pdf', 'lock'
            ]);

            if (hasDirectory) return Boolean(extension);
            if (basename.startsWith('.env')) return true;
            return allowedExtensions.has(extension);
        }

        function splitWrappedFilePath(rawMatch) {
            const text = String(rawMatch || '');
            const tick = String.fromCharCode(96);
            const wrapperRegex = new RegExp("^(['\\\"" + tick + "])(.*)\\\\1$");
            const wrapperMatch = text.match(wrapperRegex);
            if (wrapperMatch) {
                const candidate = wrapperMatch[2];
                if (isLikelyWorkspaceFilePath(candidate.split('\\\\').join('/'))) {
                    return {
                        prefix: wrapperMatch[1],
                        path: candidate,
                        suffix: wrapperMatch[1]
                    };
                }
            }

            let start = 0;
            let end = text.length;
            const leadingChars = "([{";
            const trailingChars = ".,:;!?)]}";

            while (start < end && leadingChars.includes(text[start])) start += 1;
            while (end > start && trailingChars.includes(text[end - 1])) end -= 1;

            const candidate = text.slice(start, end);
            if (!isLikelyWorkspaceFilePath(candidate.split('\\\\').join('/'))) {
                return { prefix: '', path: text, suffix: '' };
            }

            return {
                prefix: text.slice(0, start),
                path: candidate,
                suffix: text.slice(end)
            };
        }

        function formatTextAsHtml(text) {
            if (!text) return '';
            return text.split('\\n').map(function(line) {
                const escaped = escapeHtml(line.replace(/\\r/g, ''));
                const processed = escaped.replace(logPathRegex, (match) => {
                    const parts = splitWrappedFilePath(match);
                    const norm = parts.path.split('\\\\').join('/');
                    if (!isLikelyWorkspaceFilePath(norm)) return match;
                    return \`<span class="filepath-link" onclick="openFileInEditor('\${norm}')" onmouseenter="showFileTooltip(event, '\${norm}')" onmouseleave="hideFileTooltip()">\${parts.prefix}\${parts.path}\${parts.suffix}</span>\`;
                });
                return '<div class="log-line">' + processed + '</div>';
            }).join('');
        }

        let tooltipTimeout = null;
        window.hideTooltipTimeout = null;

        function showFileTooltip(event, filePath) {
            if (!isLikelyWorkspaceFilePath(filePath)) return;
            if (window.hideTooltipTimeout) clearTimeout(window.hideTooltipTimeout);
            const tooltip = document.getElementById('filepath-tooltip');
            if (!tooltip) return;
            
            tooltip.innerHTML = '<div style="color: #888; font-style: italic; font-size: 12px;">Loading preview...</div>';
            tooltip.style.display = 'block';
            
            const rect = event.target.getBoundingClientRect();
            tooltip.style.left = (rect.left + window.scrollX) + 'px';
            tooltip.style.top = (rect.bottom + window.scrollY + 5) + 'px';
            
            clearTimeout(tooltipTimeout);
            tooltipTimeout = setTimeout(async () => {
                try {
                    const res = await fetch('/api/get-any-file?path=' + encodeURIComponent(filePath));
                    const data = await res.json();
                    if (!data.success) {
                        tooltip.innerHTML = \`<div style="color: #ff4d4f; font-size: 12px;">Error: \${data.error}</div>\`;
                        return;
                    }
                    if (data.isDirectory) {
                        tooltip.innerHTML = \`<div style="font-size: 11px; color: #e4e4e7;"><strong style="display: block; margin-bottom: 6px;">Directory</strong><pre style="margin: 0; white-space: pre-wrap; color: #e4e4e7; font-family: Consolas, monospace;">\${escapeHtml(data.content)}</pre></div>\`;
                    } else if (data.isImage) {
                        tooltip.innerHTML = \`<img src="\${data.content}" style="max-width: 100%; max-height: 250px; border-radius: 4px; object-fit: contain;" />\`;
                    } else if (data.isAudio) {
                        tooltip.innerHTML = \`<audio src="\${data.content}" controls style="width: 100%; min-width: 280px; margin-top: 5px;"></audio>\`;
                    } else {
                        const previewText = data.wholePreview
                            ? String(data.content || '')
                            : String(data.content || '').substring(0, 500);
                        const previewSuffix = !data.wholePreview && String(data.content || '').length > 500 ? '...' : '';
                        tooltip.innerHTML = \`<pre style="margin: 0; font-size: 11px; white-space: pre-wrap; color: #e4e4e7; font-family: Consolas, monospace;">\${escapeHtml(previewText)}\${previewSuffix}</pre>\`;
                    }
                } catch (e) {
                    tooltip.innerHTML = \`<div style="color: #ff4d4f; font-size: 12px;">Failed to load</div>\`;
                }
            }, 300);
        }
        
        window.hideFileTooltip = function() {
            clearTimeout(tooltipTimeout);
            if (window.hideTooltipTimeout) clearTimeout(window.hideTooltipTimeout);
            window.hideTooltipTimeout = setTimeout(() => {
                const tooltip = document.getElementById('filepath-tooltip');
                if (tooltip) tooltip.style.display = 'none';
            }, 300);
        }

        async function openFileInEditor(filePath) {
            if (!isLikelyWorkspaceFilePath(filePath)) return;
            if (!filePath) return alert('No path provided');
            const res = await fetch('/api/get-any-file?path=' + encodeURIComponent(filePath));
            if (!res.ok) return alert('Failed to read file from workspace nodes.');
            const data = await res.json();
            if (!data.success) return alert(data.error || 'Access Denied');
            if (data.isDirectory) return alert('This path is a directory, not a file.');
            
            let imgEl = document.getElementById('editor-image-preview');
            const saveBtn = document.getElementById('save-md-btn'); // For reference if it exists
            
            const editorGutter = document.getElementById('editor-gutter');
            if (data.isImage) {
                editorTextarea.style.display = 'none';
                if (editorGutter) editorGutter.style.display = 'none';
                if (saveBtn) saveBtn.style.display = 'none'; // Hide save button for images
                if (!imgEl) {
                    imgEl = document.createElement('img');
                    imgEl.id = 'editor-image-preview';
                    imgEl.style.maxWidth = '100%';
                    imgEl.style.maxHeight = '80vh';
                    imgEl.style.objectFit = 'contain';
                    imgEl.style.display = 'block';
                    imgEl.style.margin = '0 auto';
                    editorTextarea.parentNode.insertBefore(imgEl, editorTextarea);
                }
                imgEl.src = data.content;
                imgEl.style.display = 'block';
            } else {
                if (imgEl) imgEl.style.display = 'none';
                editorTextarea.style.display = 'block';
                if (editorGutter) editorGutter.style.display = '';
                if (saveBtn) saveBtn.style.display = 'inline-block'; // Restore save button for text
                editorTextarea.value = data.content;
                updateGutter('editor', data.content);
                syncGutter('editor');
            }
            activeMdFile = data.path;
            setActiveView('editor');
        }

        function loadComposerHistory() {
            try {
                const savedHistory = window.localStorage.getItem(composerHistoryStorageKey);
                const parsedHistory = JSON.parse(savedHistory || '[]');
                if (!Array.isArray(parsedHistory)) return;
                parsedHistory
                    .map((entry) => String(entry || '').trim())
                    .filter(Boolean)
                    .slice(-50)
                    .forEach((entry) => composerHistory.push(entry));
            } catch (error) {
            }
        }

        function saveComposerHistory() {
            try {
                window.localStorage.setItem(
                    composerHistoryStorageKey,
                    JSON.stringify(composerHistory.slice(-50))
                );
            } catch (error) {
            }
        }

        function renderComposerHistoryList() {
            composerHistoryList.innerHTML = '';
            composerHistory
                .slice()
                .reverse()
                .forEach((entry) => {
                    const option = document.createElement('option');
                    option.value = entry;
                    composerHistoryList.appendChild(option);
                });
        }

        function pushComposerHistoryEntry(text) {
            const value = String(text || '').trim();
            if (!value) return;

            const existingIndex = composerHistory.indexOf(value);
            if (existingIndex !== -1) {
                composerHistory.splice(existingIndex, 1);
            }

            composerHistory.push(value);

            while (composerHistory.length > 50) {
                composerHistory.shift();
            }

            saveComposerHistory();
            renderComposerHistoryList();
        }

        function updateComposerAttachmentUi() {
            const hasImage = Boolean(composerImagePayload);
            composerImageBtn.classList.toggle('has-file', hasImage);
            composerAttachmentName.classList.toggle('hidden', !hasImage);
            composerAttachmentName.textContent = hasImage ? 'Attached: ' + composerImagePayload.name : '';
        }

        function clearComposerAttachment() {
            composerImagePayload = null;
            composerImageInput.value = '';
            updateComposerAttachmentUi();
        }

        function readSelectedImage(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = () => reject(new Error('Failed to read image.'));
                reader.readAsDataURL(file);
            });
        }

        async function attachComposerImageFile(file) {
            if (!file) {
                clearComposerAttachment();
                return false;
            }

            if (!String(file.type || '').startsWith('image/')) {
                clearComposerAttachment();
                setComposerStatus('Only image files are supported here.', 'error');
                return false;
            }

            try {
                const data = await readSelectedImage(file);
                composerImagePayload = {
                    name: file.name || 'clipboard-image.png',
                    type: file.type || 'image/png',
                    data
                };
                updateComposerAttachmentUi();
                setComposerStatus('Image attached and ready to send.', 'neutral');
                return true;
            } catch (error) {
                clearComposerAttachment();
                setComposerStatus('Failed to read the selected image.', 'error');
                return false;
            }
        }

        function setButtonsDisabled(running) {
            const disableStart = actionInFlight || running;
            const disableStop = actionInFlight || !running;
            const disableRestart = actionInFlight || !running;

            startBtn.disabled = disableStart;
            stopBtn.disabled = disableStop;
            restartBtn.disabled = disableRestart;
            sidebarStartBtn.disabled = disableStart;
            sidebarStopBtn.disabled = disableStop;
        }

        function setStatusPill(running) {
            statusPill.textContent = running ? 'Running' : 'Stopped';
            statusPill.style.background = running ? '#1b5e20' : '#b71c1c';
        }

        function setComposerStatus(message, tone) {
            composerHint.textContent = message;
            composerHint.style.color = tone === 'error'
                ? '#b42318'
                : tone === 'success'
                    ? '#0d5b48'
                    : 'var(--muted)';
        }

        let _botIsRunning = false;

        async function loadStatus() {
            try {
                const response = await fetch('/api/status');
                const data = await response.json();
                _botIsRunning = Boolean(data.running);
                setStatusPill(Boolean(data.running));
                setButtonsDisabled(Boolean(data.running));
                if (activeView === 'schedule') loadSchedules();
                if (!sendInFlight) {
                    if (Boolean(data.running) && Boolean(data.connected)) {
                        setComposerStatus('H-Claw is running and attached to this UI session.', 'success');
                    } else if (Boolean(data.running) && !Boolean(data.connected)) {
                        setComposerStatus('H-Claw is running in bridge mode. Messages will send without restarting.', 'neutral');
                    }
                }
            } catch (error) {
                _botIsRunning = false;
                statusPill.textContent = 'Unreachable';
                statusPill.style.background = '#92400e';
                if (activeView === 'schedule') loadSchedules();
            }
        }

        async function requestBotAction(action) {
            if (actionInFlight) return;
            actionInFlight = true;
            setButtonsDisabled(_botIsRunning);
            try {
                await fetch('/api/' + action);
            } finally {
                window.setTimeout(async () => {
                    actionInFlight = false;
                    await loadStatus();
                }, 200);
            }
        }

        function isNearBottom(element) {
            return element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }

        function getConversationMeta(source) {
            if (source === 'wa') {
                return { title: 'WhatsApp', icon: 'fa-brands fa-whatsapp' };
            }

            if (source === 'tg') {
                return { title: 'Telegram', icon: 'fa-brands fa-telegram' };
            }

            if (source === 'ob') {
                return { title: 'OnBoard', icon: 'fa-solid fa-display' };
            }

            return { title: 'System Chat', icon: 'fa-regular fa-rectangle-list' };
        }

        function formatModelLabel(modelName) {
            const raw = String(modelName || '').trim();
            if (!raw) return '';

            const parts = raw.split(':');
            if (parts.length < 2) return raw;

            const provider = parts.shift().trim();
            const model = parts.join(':').trim();
            const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);
            return providerLabel + ' - ' + model;
        }

        function syncWorkspaceHeader() {
            if (activeView === 'settings') {
                workspaceTitle.textContent = 'Settings';
                workspaceIcon.className = 'fa-solid fa-sliders';
                cleanSystemLogBtn.style.display = 'none';
                cleanBotLogBtn.style.display = 'none';
                saveMdBtn.style.display = 'none';
                return;
            }

            if (activeView === 'bot') {
                workspaceTitle.textContent = 'Bot Logs';
                workspaceIcon.className = 'fa-solid fa-file-invoice';
                cleanSystemLogBtn.style.display = 'none';
                cleanBotLogBtn.style.display = 'inline-flex';
                saveMdBtn.style.display = 'none';
                return;
            }

            if (activeView === 'editor') {
                workspaceTitle.textContent = activeMdFile;
                workspaceIcon.className = 'fa-regular fa-file-lines';
                cleanSystemLogBtn.style.display = 'none';
                cleanBotLogBtn.style.display = 'none';
                saveMdBtn.style.display = 'inline-flex';
                return;
            }

            if (activeView === 'schedule') {
                workspaceTitle.textContent = 'Scheduled Tasks';
                workspaceIcon.className = 'fa-solid fa-calendar-check';
                cleanSystemLogBtn.style.display = 'none';
                cleanBotLogBtn.style.display = 'none';
                saveMdBtn.style.display = 'none';
                return;
            }

            const meta = getConversationMeta(activeConversationSource);
            workspaceTitle.textContent = meta.title;
            workspaceIcon.className = meta.icon;
            cleanSystemLogBtn.style.display = 'inline-flex';
            cleanBotLogBtn.style.display = 'none';
            saveMdBtn.style.display = 'none';
        }

        function updateGutter(paneId, text) {
            const gutter = document.getElementById(paneId + '-gutter');
            if (!gutter) return;
            const lineCount = text ? text.split('\\n').length : 0;
            let linesHtml = '';
            for (let i = 1; i <= lineCount; i++) {
                linesHtml += \`<div class="gutter-line">\${i}</div>\`;
            }
            gutter.innerHTML = linesHtml;
        }

        function syncGutterHeights(paneId) {
            const logId = paneId === 'system' ? 'system-chat-log' : 'bot-log-viewer';
            const logEl = document.getElementById(logId);
            const gutter = document.getElementById(paneId + '-gutter');
            if (!logEl || !gutter) return;
            const logLines = logEl.querySelectorAll('.log-line');
            const gutterLines = gutter.querySelectorAll('.gutter-line');
            logLines.forEach(function(logLine, i) {
                if (gutterLines[i]) {
                    gutterLines[i].style.height = logLine.getBoundingClientRect().height + 'px';
                }
            });
        }

        function syncGutter(paneId) {
            const ids = { system: 'system-chat-log', bot: 'bot-log-viewer', editor: 'editor-textarea' };
            const logElement = document.getElementById(ids[paneId] || 'system-chat-log');
            const gutterElement = document.getElementById(paneId + '-gutter');
            if (logElement && gutterElement) {
                gutterElement.scrollTop = logElement.scrollTop;
            }
        }

        async function loadSystemLog() {
            if (activeView !== 'system') return;
            if (document.activeElement === systemChatLog) return;

            try {
                const response = await fetch('/api/system-log?source=' + encodeURIComponent(activeConversationSource), { cache: 'no-store' });
                const text = await response.text();
                if (text === lastLogText) return;

                const stickToBottom = isNearBottom(systemChatLog) || !lastLogText;
                lastLogText = text;
                systemChatLog.innerHTML = formatTextAsHtml(text);
                updateGutter('system', text);
                syncGutterHeights('system');

                if (stickToBottom) {
                    systemChatLog.scrollTop = systemChatLog.scrollHeight;
                }
                syncGutter('system');
            } catch (error) {
            }
        }

        function setActiveView(view) {
            activeView = view;
            const showBot = view === 'bot';
            const showSettings = view === 'settings';
            const showEditor = view === 'editor';
            const showSchedule = view === 'schedule';
            workspace.classList.toggle('hidden', showSettings || showSchedule);
            settingsPane.classList.toggle('visible', showSettings);
            schedulePane.classList.toggle('visible', showSchedule);
            systemLogPane.classList.toggle('visible', !showBot && !showEditor);
            botLogPane.classList.toggle('visible', showBot);
            editorPane.classList.toggle('visible', showEditor);
            botLogPane.setAttribute('aria-hidden', String(!showBot));
            editorPane.setAttribute('aria-hidden', String(!showEditor));
            syncWorkspaceHeader();
            if (showSchedule) { loadSchedules(); _schedRefreshStart(); } else { _schedRefreshStop(); }
        }

        let _schedRefreshTimer = null;
        function _schedRefreshStart() {
            _schedRefreshStop();
            _schedRefreshTimer = setInterval(loadSchedules, 5000);
        }
        function _schedRefreshStop() {
            if (_schedRefreshTimer) { clearInterval(_schedRefreshTimer); _schedRefreshTimer = null; }
        }

        async function loadMdFileList() {
            try {
                const response = await fetch('/api/md-files');
                const files = await response.json();
                mdFileList.innerHTML = '';
                files.forEach(file => {
                    const btn = document.createElement('button');
                    btn.className = 'nav-item';
                    btn.type = 'button';
                    btn.setAttribute('data-sidebar-item', '');
                    btn.innerHTML = '<i class="fa-regular fa-file" aria-hidden="true"></i><span>' + file.label + '</span>';
                    btn.addEventListener('click', () => {
                        mdFileList.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
                        sidebarItems.forEach(b => b.classList.remove('active'));
                        btn.classList.add('active');
                        activeMdFile = file.path;
                        setActiveView('editor');
                        loadMdFile(file.path);
                    });
                    mdFileList.appendChild(btn);
                });
            } catch (e) {}
        }

        async function loadMdFile(filePath) {
            editorTextarea.value = 'Loading...';
            try {
                const response = await fetch('/api/md-file?path=' + encodeURIComponent(filePath));
                if (!response.ok) throw new Error('Failed');
                const text = await response.text();
                editorTextarea.value = text;
                updateGutter('editor', text);
                syncGutter('editor');
            } catch (e) {
                editorTextarea.value = 'Failed to load file.';
            }
        }

        async function saveMdFile() {
            if (!activeMdFile) return;
            const content = editorTextarea.value;
            saveMdBtn.disabled = true;
            try {
                const response = await fetch('/api/md-file', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                    body: JSON.stringify({ path: activeMdFile, content })
                });
                const result = await response.json();
                if (result.success) {
                    alert('Saved successfully');
                } else {
                    alert('Save failed');
                }
            } catch (e) {
                alert('Save failed');
            }
            saveMdBtn.disabled = false;
        }

        async function loadSettings() {
            try {
                const response = await fetch('/api/settings', { cache: 'no-store' });
                const data = await response.json();

                historyLimitInput.value = data.historyLimit;

                defaultBotModelSelect.innerHTML = '';
                (data.models || []).forEach((modelName, index) => {
                    const option = document.createElement('option');
                    option.value = String(index + 1);
                    option.textContent = formatModelLabel(modelName);
                    if (parseInt(data.defaultBotModel, 10) === index + 1) option.selected = true;
                    defaultBotModelSelect.appendChild(option);
                });

                defaultImageModelSelect.innerHTML = '';
                (data.imageModels || []).forEach((modelName, index) => {
                    const option = document.createElement('option');
                    option.value = String(index + 1);
                    option.textContent = formatModelLabel(modelName);
                    if (parseInt(data.defaultImageModel, 10) === index + 1) option.selected = true;
                    defaultImageModelSelect.appendChild(option);
                });

                settingsLoaded = true;
            } catch (error) {
            }
        }

        async function saveSettings() {
            const historyLimit = parseInt(historyLimitInput.value || '0', 10);
            const defaultBotModel = parseInt(defaultBotModelSelect.value || '1', 10);
            const defaultImageModel = parseInt(defaultImageModelSelect.value || '1', 10);

            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                body: JSON.stringify({ historyLimit, defaultBotModel, defaultImageModel })
            });
        }

        async function loadBotLog() {
            if (activeView !== 'bot') return;
            if (document.activeElement === botLogViewer) return;

            try {
                const response = await fetch('/api/bot-log', { cache: 'no-store' });
                const text = await response.text();
                if (text === lastBotLogText) return;

                const stickToBottom = isNearBottom(botLogViewer) || !lastBotLogText;
                lastBotLogText = text;
                botLogViewer.innerHTML = formatTextAsHtml(text);
                updateGutter('bot', text);
                syncGutterHeights('bot');

                if (stickToBottom) {
                    botLogViewer.scrollTop = botLogViewer.scrollHeight;
                }
                syncGutter('bot');
            } catch (error) {
            }
        }

        async function cleanLog(kind) {
            const response = await fetch('/api/clean-log?kind=' + encodeURIComponent(kind));
            if (!response.ok) return;

            if (kind === 'system') {
                lastLogText = '';
                systemChatLog.innerHTML = '';
                updateGutter('system', '');
                await loadSystemLog();
                return;
            }

            lastBotLogText = '';
            botLogViewer.innerHTML = '';
            updateGutter('bot', '');
            await loadBotLog();
        }

        async function sendComposerMessage() {
            if (sendInFlight) return;

            const platform = composerPlatform.value;
            const target = composerTarget.value.trim();
            const text = composerText.value.trim();
            const hasImage = Boolean(composerImagePayload);

            if (!text && !hasImage) {
                setComposerStatus('Type a message or attach an image before sending.', 'error');
                composerText.focus();
                return;
            }

            sendInFlight = true;
            composerSendBtn.disabled = true;
            setComposerStatus('Sending message...', 'neutral');

            try {
                const response = await fetch('/api/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                    body: JSON.stringify({
                        platform,
                        target,
                        text,
                        imageName: composerImagePayload ? composerImagePayload.name : '',
                        imageMime: composerImagePayload ? composerImagePayload.type : '',
                        imageData: composerImagePayload ? composerImagePayload.data : ''
                    })
                });

                const result = await response.json();
                if (!result.success) {
                    setComposerStatus(result.error || 'Failed to send message.', 'error');
                    return;
                }

                pushComposerHistoryEntry(text);
                composerHistoryIndex = -1;
                composerDraft = '';
                composerText.value = '';
                clearComposerAttachment();
                setComposerStatus('Message sent.', 'success');
                if (platform === 'onboard') {
                    lastLogText = '';
                    await loadSystemLog();
                }
            } catch (error) {
                setComposerStatus('Failed to send message.', 'error');
            } finally {
                sendInFlight = false;
                composerSendBtn.disabled = false;
            }
        }

        function setComposerPlatform(platform) {
            composerPlatform.value = platform;
            composerPlatform.dispatchEvent(new Event('change'));
        }

        sidebarItems.forEach((item) => {
            item.addEventListener('click', () => {
                if (item.disabled) return;
                sidebarItems.forEach((button) => {
                    button.classList.remove('active');
                    button.removeAttribute('aria-current');
                });

                item.classList.add('active');
                item.setAttribute('aria-current', 'page');
            });
        });

        sectionToggles.forEach((toggle) => {
            toggle.addEventListener('click', () => {
                const section = toggle.closest('.sidebar-section');
                const isCollapsed = section.classList.toggle('collapsed');
                toggle.setAttribute('aria-expanded', String(!isCollapsed));
            });
        });

        startBtn.addEventListener('click', () => requestBotAction('start'));
        stopBtn.addEventListener('click', () => requestBotAction('stop'));
        restartBtn.addEventListener('click', () => requestBotAction('restart'));
        sidebarStartBtn.addEventListener('click', () => requestBotAction('start'));
        sidebarStopBtn.addEventListener('click', () => requestBotAction('stop'));
        navSystemChat.addEventListener('click', async () => {
            activeConversationSource = 'system';
            setActiveView('system');
            lastLogText = '';
            await loadSystemLog();
        });
        navWaLog.addEventListener('click', async () => {
            activeConversationSource = 'wa';
            setComposerPlatform('whatsapp');
            setActiveView('system');
            lastLogText = '';
            await loadSystemLog();
        });
        navTgLog.addEventListener('click', async () => {
            activeConversationSource = 'tg';
            setComposerPlatform('telegram');
            setActiveView('system');
            lastLogText = '';
            await loadSystemLog();
        });
        navObLog.addEventListener('click', async () => {
            activeConversationSource = 'ob';
            setComposerPlatform('onboard');
            setActiveView('system');
            lastLogText = '';
            await loadSystemLog();
        });
        navBotLogs.addEventListener('click', async () => {
            setActiveView('bot');
            await loadBotLog();
        });
        navSettings.addEventListener('click', async () => {
            setActiveView('settings');
            if (!settingsLoaded) {
                await loadSettings();
            }
        });

        // ── Schedule ─────────────────────────────────────────────────────────
        const navSchedule = document.getElementById('nav-schedule');
        const schedModal = document.getElementById('schedule-modal');
        const schedModalPanel = document.getElementById('schedule-modal-panel');
        const schedStartInput = document.getElementById('sched-start');
        const schedStopInput = document.getElementById('sched-stop');
        const schedStepInput = document.getElementById('sched-step');
        const schedRunOnceInput = document.getElementById('sched-run-once');
        const schedStatusInput = document.getElementById('sched-status');
        const schedIssuerClientInput = document.getElementById('sched-issuer-client');
        const schedNextRunInput = document.getElementById('sched-next-run');
        const schedPromptInput = document.getElementById('sched-prompt');

        navSchedule.addEventListener('click', () => {
            sidebarItems.forEach(b => b.classList.remove('active'));
            navSchedule.classList.add('active');
            setActiveView('schedule');
        });

        let _editingTaskPid = null;
        let _currentTasks = [];

        function formatScheduleTimestamp(value) {
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return '—';
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const hour = String(date.getHours()).padStart(2, '0');
            const minute = String(date.getMinutes()).padStart(2, '0');
            return year + '-' + month + '-' + day + ' ' + hour + ':' + minute;
        }

        function toDatetimeLocalValue(value) {
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return '';
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const hour = String(date.getHours()).padStart(2, '0');
            const minute = String(date.getMinutes()).padStart(2, '0');
            return year + '-' + month + '-' + day + 'T' + hour + ':' + minute;
        }

        function computeNextRunDisplay(task) {
            return formatScheduleTimestamp(task && task.next_run_time);
        }

        function formatScheduleStatus(status) {
            const raw = String(status || '').trim().toLowerCase();
            if (!raw) return '-';
            return raw.charAt(0).toUpperCase() + raw.slice(1);
        }

        function getDisplayScheduleStatus(status) {
            const raw = String(status || '').trim().toLowerCase();
            if (!_botIsRunning && raw !== 'disabled' && raw !== 'expired') {
                return 'paused';
            }
            return raw;
        }

        function getScheduleStatusColor(status) {
            const display = getDisplayScheduleStatus(status);
            if (display === 'enabled') return '#22c55e';
            if (display === 'running') return '#f59e0b';
            if (display === 'paused') return '#64748b';
            return '#94a3b8';
        }

        function formatIssuerClient(value) {
            const raw = String(value || '').trim().toLowerCase();
            if (raw === 'whatsapp') return 'WhatsApp';
            if (raw === 'telegram') return 'Telegram';
            return 'OnBoard';
        }

        function normalizeScheduleStep(value) {
            const raw = String(value || '')
                .toLowerCase()
                .replace(/[٠-٩]/g, (char) => String(char.charCodeAt(0) - 1632))
                .replace(/[۰-۹]/g, (char) => String(char.charCodeAt(0) - 1776));
            const compact = raw.replace(/[^0-9a-z]/g, '');
            const match = compact.match(/^(\d+)(m|h)$/);
            return match ? (match[1] + match[2]) : '';
        }

        function isRunOnceTask(task) {
            return Boolean(task) && String(task.step_time || '').trim().toLowerCase() === '0m';
        }

        function syncRunOnceUi() {
            const runOnce = Boolean(schedRunOnceInput.checked);
            if (runOnce) {
                if (schedStartInput.value) {
                    schedStopInput.value = schedStartInput.value;
                }
                schedStepInput.value = '0m';
            }
            schedStopInput.disabled = runOnce;
            schedStepInput.disabled = runOnce;
            schedStopInput.style.opacity = runOnce ? '0.7' : '1';
            schedStepInput.style.opacity = runOnce ? '0.7' : '1';
        }

        function openScheduleModal(task) {
            _editingTaskPid = task ? task.pid : null;
            document.getElementById('sched-modal-title').textContent = task ? 'Edit Scheduled Task' : 'Add Scheduled Task';
            schedStartInput.value = task ? toDatetimeLocalValue(task.start) : '';
            schedStopInput.value = task ? toDatetimeLocalValue(task.stop) : '';
            schedStepInput.value = task ? String(task.step_time || '') : '';
            schedRunOnceInput.checked = isRunOnceTask(task);
            schedStatusInput.value = task && task.status === 'disabled' ? 'disabled' : 'enabled';
            schedIssuerClientInput.value = task ? String(task.issuer_client || 'onboard') : 'onboard';
            schedNextRunInput.value = task ? formatScheduleTimestamp(task.next_run_time) : '';
            schedPromptInput.value = task ? String(task.prompt || '') : '';
            syncRunOnceUi();
            schedModal.style.display = 'flex';
        }

        function buildSchedulePayload() {
            const normalizedStep = normalizeScheduleStep(schedStepInput.value);
            const rawStep = String(schedStepInput.value || '').trim();
            const runOnce = Boolean(schedRunOnceInput.checked);
            schedStepInput.value = runOnce ? '0m' : (normalizedStep || rawStep);
            if (runOnce && schedStartInput.value) {
                schedStopInput.value = schedStartInput.value;
            }
            return {
                start: schedStartInput.value.trim(),
                stop: runOnce ? schedStartInput.value.trim() : schedStopInput.value.trim(),
                step_time: runOnce ? '0m' : (normalizedStep || rawStep),
                status: schedStatusInput.value,
                issuer_client: schedIssuerClientInput.value,
                prompt: schedPromptInput.value.trim()
            };
        }

        async function loadSchedules() {
            const wrap = document.getElementById('schedule-table-wrap');
            try {
                const res = await fetch('/api/schedules');
                const tasks = await res.json();
                _currentTasks = tasks;
                if (!tasks.length) {
                    wrap.innerHTML = '<p style="color:var(--muted);margin:0;">No tasks scheduled.</p>';
                    return;
                }
                wrap.innerHTML = \`<table style="width:100%;border-collapse:collapse;font-size:13px;">
                    <thead><tr style="background:var(--bg);text-align:left;">
                        <th style="padding:8px 10px;border-bottom:1px solid var(--line);">PID</th>
                        <th style="padding:8px 10px;border-bottom:1px solid var(--line);">Start</th>
                        <th style="padding:8px 10px;border-bottom:1px solid var(--line);">Stop</th>
                        <th style="padding:8px 10px;border-bottom:1px solid var(--line);">Step</th>
                        <th style="padding:8px 10px;border-bottom:1px solid var(--line);">Next Run</th>
                        <th style="padding:8px 10px;border-bottom:1px solid var(--line);">Target Client</th>
                        <th style="padding:8px 10px;border-bottom:1px solid var(--line);">Status</th>
                        <th style="padding:8px 10px;border-bottom:1px solid var(--line);">Actions</th>
                    </tr></thead>
                    <tbody>\${tasks.map(t => \`<tr>
                        <td style="padding:8px 10px 2px;font-family:monospace;font-size:12px;">\${escapeHtml(String(t.pid || ''))}</td>
                        <td style="padding:8px 10px 2px;font-family:monospace;font-size:12px;">\${computeNextRunDisplay({ next_run_time: t.start })}</td>
                        <td style="padding:8px 10px 2px;font-family:monospace;font-size:12px;">\${computeNextRunDisplay({ next_run_time: t.stop })}</td>
                        <td style="padding:8px 10px 2px;font-family:monospace;font-size:12px;">\${escapeHtml(String(t.step_time || '') === '0m' ? 'Run Once' : String(t.step_time || ''))}</td>
                        <td style="padding:8px 10px 2px;font-family:monospace;font-size:12px;">\${computeNextRunDisplay(t)}</td>
                        <td style="padding:8px 10px 2px;">\${escapeHtml(formatIssuerClient(t.issuer_client))}</td>
                        <td style="padding:8px 10px 2px;">
                            <span style="color:\${getScheduleStatusColor(t.status)};">\${escapeHtml(formatScheduleStatus(getDisplayScheduleStatus(t.status)))}</span>
                        </td>
                        <td style="padding:8px 10px 2px;white-space:nowrap;">
                            <button onclick="editSchedTask('\${escapeHtml(String(t.pid || ''))}')" style="margin-right:6px;padding:3px 10px;border-radius:6px;border:1px solid var(--line-strong);cursor:pointer;font-size:12px;background:var(--bg);color:var(--text);">Edit</button>
                            <button onclick="toggleSchedTask('\${escapeHtml(String(t.pid || ''))}','\${(t.status==='enabled' || t.status==='running')?'disabled':'enabled'}')" style="margin-right:6px;padding:3px 10px;border-radius:6px;border:1px solid var(--line-strong);cursor:pointer;font-size:12px;background:var(--bg);color:var(--text);">\${(t.status==='enabled' || t.status==='running')?'Disable':'Enable'}</button>
                            <button onclick="deleteSchedTask('\${escapeHtml(String(t.pid || ''))}')" style="padding:3px 10px;border-radius:6px;border:1px solid #f87171;cursor:pointer;font-size:12px;background:#fff5f5;color:#dc2626;">Delete</button>
                        </td>
                    </tr>
                    <tr>
                        <td colspan="8" style="padding:2px 10px 10px;border-bottom:1px solid var(--line);font-size:12px;color:var(--muted);"><b>prompt:</b> \${escapeHtml(t.prompt)}</td>
                    </tr>\`).join('')}</tbody>
                </table>\`;
            } catch (e) {
                wrap.innerHTML = '<p style="color:#ef4444;margin:0;">Failed to load schedules.</p>';
            }
        }

        window.editSchedTask = function(pid) {
            const t = _currentTasks.find(x => String(x.pid) === String(pid));
            if (!t) return;
            openScheduleModal(t);
        };

        window.deleteSchedTask = async function(pid) {
            if (!confirm('Delete task ' + pid + '?')) return;
            await fetch('/api/schedules/' + encodeURIComponent(pid), { method: 'DELETE' });
            loadSchedules();
        };

        window.toggleSchedTask = async function(pid, newStatus) {
            await fetch('/api/schedules/' + encodeURIComponent(pid), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: newStatus })
            });
            loadSchedules();
        };

        document.getElementById('add-task-btn').addEventListener('click', () => {
            openScheduleModal(null);
        });

        document.getElementById('sched-cancel-btn').addEventListener('click', () => {
            schedModal.style.display = 'none';
        });

        ['mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup'].forEach((eventName) => {
            schedModalPanel.addEventListener(eventName, (event) => {
                event.stopPropagation();
            });
        });

        [schedStartInput, schedStopInput, schedStepInput, schedPromptInput, schedStatusInput, schedIssuerClientInput].forEach((field) => {
            ['copy', 'cut', 'paste'].forEach((eventName) => {
                field.addEventListener(eventName, (event) => {
                    event.stopPropagation();
                });
            });
        });

        schedRunOnceInput.addEventListener('change', () => syncRunOnceUi());
        schedStartInput.addEventListener('input', () => {
            if (!schedRunOnceInput.checked) return;
            schedStopInput.value = schedStartInput.value;
        });

        document.getElementById('sched-save-btn').addEventListener('click', async () => {
            const payload = buildSchedulePayload();
            if (!payload.start || !payload.stop || !payload.prompt || !String(payload.step_time || '').trim()) {
                return alert('Start, stop, step time, and prompt are required.');
            }
            if (payload.step_time !== '0m' && new Date(payload.stop) <= new Date(payload.start)) {
                return alert('Stop must be later than start.');
            }
            const url = _editingTaskPid !== null ? '/api/schedules/' + encodeURIComponent(_editingTaskPid) : '/api/schedules';
            const method = _editingTaskPid !== null ? 'PUT' : 'POST';
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (data.success) {
                _editingTaskPid = null;
                schedModal.style.display = 'none';
                loadSchedules();
            } else {
                alert(data.error || 'Failed to save task.');
            }
        });
        // ── End Schedule ──────────────────────────────────────────────────────

        cleanSystemLogBtn.addEventListener('click', () => cleanLog('system'));
        cleanBotLogBtn.addEventListener('click', () => cleanLog('bot'));
        composerSendBtn.addEventListener('click', () => sendComposerMessage());
        composerImageInput.addEventListener('change', async () => {
            const file = composerImageInput.files && composerImageInput.files[0];
            await attachComposerImageFile(file);
        });
        composerImageBtn.addEventListener('contextmenu', (event) => {
            if (!composerImagePayload) return;
            event.preventDefault();
            clearComposerAttachment();
            setComposerStatus('Image attachment cleared.', 'neutral');
        });
        composerText.addEventListener('paste', async (event) => {
            const clipboardItems = Array.from((event.clipboardData && event.clipboardData.items) || []);
            const imageItem = clipboardItems.find((item) => String(item.type || '').startsWith('image/'));
            if (!imageItem) return;

            event.preventDefault();
            await attachComposerImageFile(imageItem.getAsFile());
        });
        composerText.addEventListener('keydown', (event) => {
            if (event.key === 'ArrowUp') {
                if (composerText.selectionStart !== 0 || composerText.selectionEnd !== 0) return;
                if (!composerHistory.length) return;
                event.preventDefault();

                if (composerHistoryIndex === -1) {
                    composerDraft = composerText.value;
                    composerHistoryIndex = composerHistory.length - 1;
                } else if (composerHistoryIndex > 0) {
                    composerHistoryIndex -= 1;
                }

                composerText.value = composerHistory[composerHistoryIndex];
                composerText.setSelectionRange(composerText.value.length, composerText.value.length);
                return;
            }

            if (event.key === 'ArrowDown' && composerHistoryIndex !== -1) {
                if (
                    composerText.selectionStart !== composerText.value.length ||
                    composerText.selectionEnd !== composerText.value.length
                ) return;
                event.preventDefault();

                if (composerHistoryIndex < composerHistory.length - 1) {
                    composerHistoryIndex += 1;
                    composerText.value = composerHistory[composerHistoryIndex];
                } else {
                    composerHistoryIndex = -1;
                    composerText.value = composerDraft;
                }

                composerText.setSelectionRange(composerText.value.length, composerText.value.length);
                return;
            }

            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendComposerMessage();
            }
        });
        composerText.addEventListener('focus', () => {
            renderComposerHistoryList();
        });
        composerText.addEventListener('input', () => {
            if (composerHistoryIndex === -1) {
                composerDraft = composerText.value;
            }
        });
        composerPlatform.addEventListener('change', () => {
            if (composerPlatform.value === 'onboard') {
                composerTarget.value = '';
                composerTarget.placeholder = 'Recipient ID';
                setComposerStatus('Send a message through OnBoard, WhatsApp, or Telegram.', 'neutral');
                return;
            }

            if (composerPlatform.value === 'whatsapp') {
                composerTarget.placeholder = 'WhatsApp ID or number (blank = me)';
                setComposerStatus('Blank recipient defaults to your own WhatsApp chat.', 'neutral');
                return;
            }

            composerTarget.placeholder = 'Telegram chat ID (blank = TELEGRAM_CHAT_ID)';
            setComposerStatus('Blank recipient defaults to TELEGRAM_CHAT_ID.', 'neutral');
        });
        historyLimitInput.addEventListener('change', () => saveSettings());
        defaultBotModelSelect.addEventListener('change', () => saveSettings());
        defaultImageModelSelect.addEventListener('change', () => saveSettings());

        sidebarClearTmpBtn.addEventListener('click', async () => {
            const ok = confirm('Clear all files in tmp directory?');
            if (!ok) return;
            try {
                const response = await fetch('/api/clear-tmp');
                const result = await response.json();
                if (result.success) alert('Tmp cleared');
                else alert('Failed to clear tmp');
            } catch (e) {
                alert('Failed to clear tmp');
            }
        });

        saveMdBtn.addEventListener('click', () => saveMdFile());
        editorTextarea.addEventListener('input', function() {
            updateGutter('editor', editorTextarea.value);
        });

        window.addEventListener('resize', function() {
            syncGutterHeights('system');
            syncGutterHeights('bot');
        });
        window.setInterval(loadStatus, 2000);
        window.setInterval(loadSystemLog, 1500);
        window.setInterval(loadBotLog, 1500);
        loadComposerHistory();
        renderComposerHistoryList();
        updateComposerAttachmentUi();
        loadStatus();
        loadMdFileList();
        setActiveView('system');
        loadSystemLog();
        loadBotLog();
    </script>
</body>
</html>
`;

const server = http.createServer((req, res) => {
    const { url, method } = req;
    const requestUrl = new URL(url, 'http://127.0.0.1');
    const pathname = requestUrl.pathname;

    if (pathname === '/' && method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            Pragma: 'no-cache',
            Expires: '0'
        });
        res.end(html);
        return;
    }

    if (pathname === '/api/status' && method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store, no-cache, must-revalidate'
        });
        isBotRunning().then((running) => {
            res.end(JSON.stringify({
                running,
                connected: Boolean(botProcess && botProcess.connected),
            }));
        }).catch(() => {
            res.end(JSON.stringify({ running: false, connected: false }));
        });
        return;
    }

    if (pathname === '/api/system-log' && method === 'GET') {
        const source = requestUrl.searchParams.get('source') || 'system';
        const contentPromise = source === 'system' ? readSystemLog() : buildFilteredLog(source);

        contentPromise.then((content) => {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(trimLogForUi(content));
        }).catch(() => {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end('');
        });
        return;
    }

    if (pathname === '/api/bot-log' && method === 'GET') {
        readBotLog().then((content) => {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(trimLogForUi(content));
        }).catch(() => {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end('');
        });
        return;
    }

    if (pathname === '/api/clean-log' && method === 'GET') {
        const kind = requestUrl.searchParams.get('kind');
        const targetFile = kind === 'bot' ? botLogFile : kind === 'system' ? logFile : null;

        if (!targetFile) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false }));
            return;
        }

        clearFile(targetFile).then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        }).catch(() => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false }));
        });
        return;
    }

    if (pathname === '/api/settings' && method === 'GET') {
        const { historyLimit, defaultBotModel, defaultImageModel } = readEnvBotSettings();

        const { models, imageModels } = getSettingsModelLists();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ historyLimit, defaultBotModel, defaultImageModel, models, imageModels }));
        return;
    }

    if (pathname === '/api/settings' && method === 'POST') {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body || '{}');
                const envBotPath = path.join('secrets', '.env_bot');

                let lines = [];
                if (fs.existsSync(envBotPath)) {
                    lines = fs.readFileSync(envBotPath, 'utf8').split('\n').filter(Boolean);
                }

                const updateVar = (key, value) => {
                    const index = lines.findIndex((line) => line.startsWith(key + '='));
                    if (index !== -1) lines[index] = key + '=' + value;
                    else lines.push(key + '=' + value);
                };

                if (payload.historyLimit !== undefined) updateVar('BOT_LOG_HISTORY_LIMIT', payload.historyLimit);
                if (payload.defaultBotModel !== undefined) updateVar('DEFAULT_BOT_MODEL', payload.defaultBotModel);
                if (payload.defaultImageModel !== undefined) updateVar('DEFAULT_IMAGE_MODEL', payload.defaultImageModel);

                fs.writeFileSync(envBotPath, lines.join('\n').trim() + '\n');

                if (botProcess && botProcess.connected) {
                    botProcess.send({ type: 'update_settings', settings: payload });
                } else {
                    isBotRunning().then(async (running) => {
                        if (!running) return;
                        await enqueueBridgeCommand({ type: 'update_settings', settings: payload });
                    }).catch(() => {
                    });
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false }));
            }
        });
        return;
    }

    if (pathname === '/api/send' && method === 'POST') {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', async () => {
            let imagePath = '';

            try {
                const payload = JSON.parse(body || '{}');
                const platform = String(payload.platform || '').trim();
                const target = String(payload.target || '').trim();
                const text = String(payload.text || '');
                const trimmedText = text.trim();
                const imageName = String(payload.imageName || '').trim();
                const imageData = String(payload.imageData || '').trim();
                const hasImage = Boolean(imageData);

                if (!platform || (!trimmedText && !hasImage)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'A platform and either text or an image are required.' }));
                    return;
                }

                if (hasImage) {
                    imagePath = await saveUploadedImage(imageName, imageData);
                }

                const { historyLimit } = readEnvBotSettings();
                const sendPayload = {
                    type: 'send_msg',
                    platform,
                    target,
                    text,
                    image_path: imagePath,
                    history_limit: historyLimit
                };

                if (botProcess && botProcess.connected) {
                    botProcess.send(sendPayload);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, mode: 'ipc' }));
                    return;
                }

                const running = await isBotRunning();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                if (running) {
                    await enqueueBridgeCommand(sendPayload);
                    res.end(JSON.stringify({
                        success: true,
                        mode: 'bridge'
                    }));
                    return;
                }

                if (imagePath && fs.existsSync(imagePath)) {
                    try {
                        fs.unlinkSync(imagePath);
                    } catch (cleanupError) {
                    }
                }

                res.end(JSON.stringify({
                    success: false,
                    error: 'H-Claw is not running.'
                }));
            } catch (error) {
                if (imagePath && fs.existsSync(imagePath)) {
                    try {
                        fs.unlinkSync(imagePath);
                    } catch (cleanupError) {
                    }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: error.message || 'Failed to send message.' }));
            }
        });
        return;
    }

    if (pathname === '/api/md-files' && method === 'GET') {
        const mdDir = path.join(__dirname, 'MD');
        const files = [];
        try {
            if (fs.existsSync(mdDir)) {
                const list = fs.readdirSync(mdDir);
                list.forEach(file => {
                    if (file.toLowerCase().endsWith('.md')) {
                        files.push({ label: file, path: 'MD/' + file });
                    }
                });
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(files));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify([]));
        }
        return;
    }

    if (pathname === '/api/md-file' && method === 'GET') {
        const filePathParam = requestUrl.searchParams.get('path');
        if (!filePathParam || !filePathParam.startsWith('MD/')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Invalid path' }));
            return;
        }
        const fullPath = path.join(__dirname, filePathParam);
        fs.promises.readFile(fullPath, 'utf8').then(content => {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(content);
        }).catch(() => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false }));
        });
        return;
    }

    if (pathname === '/api/md-file' && method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const payload = JSON.parse(body || '{}');
                const filePathParam = payload.path;
                const content = payload.content;
                if (!filePathParam || !filePathParam.startsWith('MD/')) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Invalid path' }));
                    return;
                }
                const fullPath = path.join(__dirname, filePathParam);
                fs.promises.writeFile(fullPath, content, 'utf8').then(() => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                }).catch(() => {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false }));
                });
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false }));
            }
        });
        return;
    }

    if (pathname === '/api/get-any-file' && method === 'GET') {
        const fileParam = requestUrl.searchParams.get('path');
        if (!fileParam) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'No path' }));
            return;
        }
        const fullPath = resolveWorkspaceFilePath(fileParam);
        const normalizedWorkspaceRoot = path.normalize(__dirname + path.sep);
        const normalizedFullPath = path.normalize(fullPath || '');
        if (!normalizedFullPath.startsWith(normalizedWorkspaceRoot) && normalizedFullPath !== path.normalize(__dirname)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Access Denied' }));
            return;
        }
        if (!fs.existsSync(fullPath)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'File Not Found' }));
            return;
        }
        const stats = fs.statSync(fullPath);
        if (stats.isDirectory()) {
            fs.promises.readdir(fullPath, { withFileTypes: true }).then((entries) => {
                const preview = entries
                    .slice(0, 30)
                    .map((entry) => `${entry.isDirectory() ? '[DIR] ' : ''}${entry.name}`)
                    .join('\n');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    isDirectory: true,
                    isImage: false,
                    isAudio: false,
                    content: preview || '(empty directory)',
                    path: fileParam
                }));
            }).catch((err) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            });
            return;
        }
        const ext = path.extname(fullPath).toLowerCase();
        const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext);
        const isAudio = ['.mp3', '.wav', '.ogg', '.m4a'].includes(ext);
        const wholePreview = String(fileParam || '').replace(/\\/g, '/').startsWith('heartbeat/');
        const promise = (isImage || isAudio) ? fs.promises.readFile(fullPath) : fs.promises.readFile(fullPath, 'utf8');
        
        promise.then(data => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (isImage) {
                const base64 = data.toString('base64');
                const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
                const mime = mimeMap[ext] || 'image/png';
                res.end(JSON.stringify({ success: true, isImage: true, isAudio: false, wholePreview: false, content: `data:${mime};base64,${base64}`, path: fileParam }));
            } else if (isAudio) {
                const base64 = data.toString('base64');
                const mimeMap = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' };
                const mime = mimeMap[ext] || 'audio/mpeg';
                res.end(JSON.stringify({ success: true, isDirectory: false, isImage: false, isAudio: true, wholePreview: false, content: `data:${mime};base64,${base64}`, path: fileParam }));
            } else {
                res.end(JSON.stringify({ success: true, isDirectory: false, isImage: false, isAudio: false, wholePreview, content: data, path: fileParam }));
            }
        }).catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        });
        return;
    }

    if (pathname === '/api/clear-tmp' && method === 'GET') {
        const tmpDir = path.join(__dirname, 'tmp');
        if (!fs.existsSync(tmpDir)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
            return;
        }
        fs.promises.readdir(tmpDir).then(files => {
            return Promise.all(files.map(file => fs.promises.unlink(path.join(tmpDir, file))));
        }).then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        }).catch(e => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        });
        return;
    }

    if (pathname === '/api/start' && method === 'GET') {
        startBot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    if (pathname === '/api/stop' && method === 'GET') {
        stopBot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    if (pathname === '/api/restart' && method === 'GET') {
        restartBot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
    }

    // ── Schedule API ──────────────────────────────────────────────────────────
    if (pathname === '/api/schedules' && method === 'GET') {
        isBotRunning().then((running) => {
            try {
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-store, no-cache, must-revalidate'
                });
                const tasks = running ? getScheduledTasks() : getStoredScheduledTasks();
                res.end(JSON.stringify(tasks));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify([]));
            }
        });
        return;
    }

    if (pathname === '/api/schedules' && method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const payload = JSON.parse(body || '{}');
                const task = createSchedule({
                    ...payload,
                    issuer_client: payload.issuer_client || 'onboard',
                    issuer_target: resolveIssuerTargetForClient(payload.issuer_client)
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, pid: task.pid, task }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    if (pathname.startsWith('/api/schedules/') && method === 'DELETE') {
        const pid = decodeURIComponent(pathname.split('/').pop());
        try {
            deleteSchedule(pid);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    if (pathname.startsWith('/api/schedules/') && method === 'PUT') {
        const pid = decodeURIComponent(pathname.split('/').pop());
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const payload = JSON.parse(body || '{}');
                const task = updateSchedule(pid, {
                    ...payload,
                    issuer_target: payload.issuer_client !== undefined
                        ? resolveIssuerTargetForClient(payload.issuer_client)
                        : undefined
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, task }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }
    // ── End Schedule API ──────────────────────────────────────────────────────

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
});

server.listen(PORT, () => {
    console.log('H-Claw OnBoard UI is live at http://localhost:' + PORT);
});

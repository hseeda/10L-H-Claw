process.noDeprecation = true;

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { fork, exec, execFile } = require('child_process');
const {
    getStoredScheduledTasks,
    deleteSchedule,
} = require('./src/scheduleTool');

const oldLog = console.log;
console.log = () => {};
require('dotenv').config({ path: path.join('secrets', '.env'), quiet: true });
require('dotenv').config({ path: path.join('secrets', '.env_bot'), override: true, quiet: true });
console.log = oldLog;

const botScriptPath = path.resolve(__dirname, 'hclaw.js');
const queueFile = path.join(__dirname, 'tmp', 'onboard_ui_queue.jsonl');
const envBotPath = path.join(__dirname, 'secrets', '.env_bot');
const isWindows = process.platform === 'win32';

const logFiles = {
    system: path.join(__dirname, 'logs', 'log.txt'),
    bot: path.join(__dirname, 'logs', 'bot_log.txt'),
    wa: path.join(__dirname, 'logs', 'wa_log.txt'),
    tg: path.join(__dirname, 'logs', 'tg_log.txt'),
    ob: path.join(__dirname, 'logs', 'ob_log.txt'),
};

const ANSI = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    gray: '\x1b[90m',
    bg: '\x1b[48;5;235m',
    panel: '\x1b[48;5;236m',
};

let botProcess = null;
let botPid = null;
let startInFlight = false;
let activeLog = 'system';
let lastLiveLog = 'system';
let renderPaused = false;
let lastNotice = 'Type a message to send it as OnBoard. Use :help for local commands.';
let lastLogSnapshot = '';
let renderTimer = null;
let typingPauseTimer = null;
let lastRenderedFrame = '';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    completer: () => [[], ''],
});

function say(text = '') {
    process.stdout.write(`${text}\n`);
}

function setActiveView(view) {
    activeLog = view;
    if (logFiles[view]) {
        lastLiveLog = view;
    }
}

function stripAnsi(text) {
    return String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function padRight(text, width) {
    const raw = stripAnsi(text);
    if (raw.length >= width) return text;
    return text + ' '.repeat(width - raw.length);
}

function truncate(text, width) {
    const raw = stripAnsi(text);
    if (raw.length <= width) return text;
    return raw.slice(0, Math.max(0, width - 1)) + '…';
}

function statusColor(running) {
    return running ? ANSI.green : ANSI.red;
}

function readEnvBotSettings() {
    let historyLimit = 10;
    if (fs.existsSync(envBotPath)) {
        const content = fs.readFileSync(envBotPath, 'utf8');
        const matchLimit = content.match(/^BOT_LOG_HISTORY_LIMIT=(\d+)/m);
        if (matchLimit) historyLimit = parseInt(matchLimit[1], 10);
    }
    return { historyLimit };
}

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
    if (startInFlight) return false;
    startInFlight = true;
    try {
        if (await isBotRunning()) return false;
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
        return true;
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
        const externalPids = await findBotPids();
        externalPids.forEach((pid) => pidsToStop.add(pid));
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

async function enqueueBridgeCommand(payload) {
    await fs.promises.mkdir(path.dirname(queueFile), { recursive: true });
    await fs.promises.appendFile(queueFile, `${JSON.stringify(payload)}\n`, 'utf8');
}

async function readActiveLogTail(maxLines) {
    const filePath = logFiles[activeLog] || logFiles.system;
    try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        return content.split(/\r?\n/).filter(Boolean).slice(-maxLines);
    } catch (error) {
        return [`[log unavailable] ${error.message}`];
    }
}

function formatScheduleLines(tasks, width) {
    if (!tasks.length) return ['No scheduled tasks.'];
    const lines = [];
    tasks.forEach((task) => {
        lines.push(truncate(`${task.pid} | ${task.status} | ${task.issuer_client} | ${task.next_run_time || '-'}`, width));
        lines.push(truncate(`  ${task.start} -> ${task.stop} | ${task.step_time}`, width));
        lines.push(truncate(`  ${task.prompt}`, width));
    });
    return lines;
}

function renderHelp(width) {
    return [
        truncate(':help                           show local commands', width),
        truncate(':status                         show bot status', width),
        truncate(':start | :stop | :restart      bot lifecycle control', width),
        truncate(':log system|bot|wa|tg|ob       switch live pane', width),
        truncate(':schedules                      list schedules in pane', width),
        truncate(':schedule delete <pid>         delete one task', width),
        truncate(':quit                          exit CLI', width),
        truncate('plain text                     send as OnBoard input', width),
    ];
}

async function renderScreen() {
    if (renderPaused || !process.stdout.isTTY) return;

    const width = Math.max(60, process.stdout.columns || 100);
    const height = Math.max(20, process.stdout.rows || 30);
    const running = await isBotRunning();

    let contentLines;
    if (activeLog === 'schedules') {
        contentLines = formatScheduleLines(getStoredScheduledTasks(), width - 2);
    } else if (activeLog === 'help') {
        contentLines = renderHelp(width - 2);
    } else {
        contentLines = await readActiveLogTail(Math.max(6, height - 8));
        lastLogSnapshot = contentLines.join('\n');
    }

    const title = `${ANSI.bold}${ANSI.cyan}H-Claw CLI${ANSI.reset}`;
    const status = `${statusColor(running)}${running ? 'RUNNING' : 'STOPPED'}${ANSI.reset}`;
    const header = `${title}  ${ANSI.dim}claude-code style live view${ANSI.reset}`;
    const meta = `${ANSI.gray}view:${ANSI.reset} ${activeLog}   ${ANSI.gray}bot:${ANSI.reset} ${status}   ${ANSI.gray}pid:${ANSI.reset} ${botPid || '-'}`;
    const divider = `${ANSI.gray}${'─'.repeat(width)}${ANSI.reset}`;
    const notice = truncate(lastNotice, width);
    const visibleLines = [header, meta, divider];
    const bodyHeight = Math.max(6, height - 7);
    const tailLines = contentLines.slice(-bodyHeight);
    tailLines.forEach((line) => visibleLines.push(truncate(line, width)));
    while (visibleLines.length < bodyHeight + 3) {
        visibleLines.push('');
    }
    visibleLines.push(divider);
    visibleLines.push(notice);
    const nextFrame = visibleLines.join('\n') + '\n';

    if (nextFrame === lastRenderedFrame) {
        rl.setPrompt(`${ANSI.bold}${ANSI.cyan}›${ANSI.reset} `);
        rl.prompt(true);
        return;
    }

    lastRenderedFrame = nextFrame;

    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
    process.stdout.write(nextFrame);

    rl.setPrompt(`${ANSI.bold}${ANSI.cyan}›${ANSI.reset} `);
    rl.prompt(true);
}

async function handleLocalCommand(commandText) {
    const trimmed = String(commandText || '').trim();

    if (trimmed === ':help') {
        setActiveView('help');
        lastNotice = 'Local command help.';
        lastRenderedFrame = '';
        return;
    }

    if (trimmed === ':status') {
        const running = await isBotRunning();
        lastNotice = running ? `Bot is running${botPid ? ` (pid ${botPid})` : ''}.` : 'Bot is stopped.';
        lastRenderedFrame = '';
        return;
    }

    if (trimmed === ':start') {
        const started = await startBot();
        lastNotice = started ? 'Bot started.' : 'Bot already running.';
        lastRenderedFrame = '';
        return;
    }

    if (trimmed === ':stop') {
        await stopBot();
        lastNotice = 'Bot stopped.';
        lastRenderedFrame = '';
        return;
    }

    if (trimmed === ':restart') {
        await restartBot();
        lastNotice = 'Bot restarted.';
        lastRenderedFrame = '';
        return;
    }

    if (trimmed.startsWith(':log ')) {
        const view = trimmed.slice(':log '.length).trim().toLowerCase();
        if (!logFiles[view]) {
            lastNotice = 'Unknown log. Use :log system|bot|wa|tg|ob';
            return;
        }
        setActiveView(view);
        lastNotice = `Switched live pane to ${view}.`;
        lastRenderedFrame = '';
        return;
    }

    if (trimmed === ':schedules') {
        setActiveView('schedules');
        lastNotice = 'Showing schedules.';
        lastRenderedFrame = '';
        return;
    }

    if (trimmed.startsWith(':schedule delete ')) {
        const pid = trimmed.slice(':schedule delete '.length).trim();
        lastNotice = deleteSchedule(pid);
        setActiveView('schedules');
        lastRenderedFrame = '';
        return;
    }

    if (trimmed === ':quit' || trimmed === ':exit') {
        rl.close();
        return;
    }

    lastNotice = 'Unknown local command. Use :help';
    lastRenderedFrame = '';
}

async function sendOnboardText(text) {
    const cleanedText = String(text || '').trim();
    if (!cleanedText) return;
    const { historyLimit } = readEnvBotSettings();
    await enqueueBridgeCommand({
        type: 'send_msg',
        platform: 'onboard',
        target: 'dashboard',
        text: cleanedText,
        history_limit: historyLimit,
    });
    setActiveView('system');
    lastNotice = 'Sent through OnBoard bridge.';
    lastRenderedFrame = '';
}

async function handleLine(input) {
    const trimmed = String(input || '').trim();
    if (!trimmed) {
        lastNotice = 'Empty input ignored.';
        await renderScreen();
        return;
    }

    if (trimmed.startsWith(':')) {
        await handleLocalCommand(trimmed);
        await renderScreen();
        return;
    }

    await sendOnboardText(trimmed);
    await renderScreen();
}

function startRenderLoop() {
    if (renderTimer) clearInterval(renderTimer);
    renderTimer = setInterval(() => {
        renderScreen().catch(() => {});
    }, 1000);
}

function stopRenderLoop() {
    if (renderTimer) {
        clearInterval(renderTimer);
        renderTimer = null;
    }
}

function pauseRenderWhileTyping() {
    renderPaused = true;
    if (typingPauseTimer) {
        clearTimeout(typingPauseTimer);
    }
    typingPauseTimer = setTimeout(() => {
        renderPaused = false;
        renderScreen().catch(() => {});
    }, 900);
}

function returnToLiveLog() {
    if (logFiles[activeLog]) return false;
    if (typingPauseTimer) {
        clearTimeout(typingPauseTimer);
        typingPauseTimer = null;
    }
    renderPaused = false;
    setActiveView(lastLiveLog || 'system');
    lastNotice = `Returned to ${activeLog} log.`;
    lastRenderedFrame = '';
    return true;
}

async function main() {
    setActiveView('system');
    startRenderLoop();
    await renderScreen();
    if (process.stdin && process.stdin.isTTY) {
        readline.emitKeypressEvents(process.stdin);
        if (typeof process.stdin.setRawMode === 'function') {
            process.stdin.setRawMode(true);
        }
        process.stdin.on('data', () => {
            pauseRenderWhileTyping();
        });
        process.stdin.on('keypress', (_str, key) => {
            if (!key) return;
            if (key.ctrl && key.name === 'c') {
                rl.close();
                return;
            }
            if (key.name === 'escape' && returnToLiveLog()) {
                renderScreen().catch(() => {});
            }
        });
    }
    rl.on('line', (line) => {
        renderPaused = false;
        handleLine(line).catch((error) => {
            lastNotice = `Error: ${error.message}`;
        });
    });
}

rl.on('close', () => {
    stopRenderLoop();
    lastRenderedFrame = '';
    if (typingPauseTimer) {
        clearTimeout(typingPauseTimer);
        typingPauseTimer = null;
    }
    if (process.stdin && process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
        process.stdin.setRawMode(false);
    }
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
    say('Bye.');
    process.exit(0);
});

process.on('SIGINT', () => {
    rl.close();
});

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

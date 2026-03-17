const http = require('http');
const fs = require('fs');
const path = require('path');
const { fork, exec, execFile } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, 'secrets', '.env'), quiet: true });

const PORT = 3000;
const logFile = path.resolve(__dirname, 'logs', 'log.txt');
const tmpDir = path.resolve(__dirname, 'tmp');
let botProcess = null;

if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
}

// Helper to check if bot is running cross-platform
let botPid = null;

function isPidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

function runExec(command, options = {}) {
    return new Promise((resolve) => {
        exec(command, {
            encoding: 'utf-8',
            timeout: 3000,
            windowsHide: true,
            ...options
        }, (err, stdout = '', stderr = '') => {
            resolve({ err, stdout, stderr });
        });
    });
}

function runExecFile(file, args, options = {}) {
    return new Promise((resolve) => {
        execFile(file, args, {
            encoding: 'utf-8',
            timeout: 3000,
            windowsHide: true,
            ...options
        }, (err, stdout = '', stderr = '') => {
            resolve({ err, stdout, stderr });
        });
    });
}

function parsePidList(output) {
    return String(output || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => parseInt(line, 10))
        .filter(pid => Number.isInteger(pid) && pid > 0);
}

async function findExternalBotPids() {
    if (process.platform === 'win32') {
        const ps = await runExecFile('powershell.exe', [
            '-NoProfile',
            '-Command',
            "Get-CimInstance Win32_Process | Where-Object { ($_.Name -match '^node(\\.exe)?$') -and $_.CommandLine -like '*hclaw.js*' } | Select-Object -ExpandProperty ProcessId"
        ]);
        if (ps.err && ps.err.code === 'ENOENT') return [];
        return parsePidList(ps.stdout);
    }

    const result = await runExec('pgrep -f "node.*hclaw\\.js"');
    if (result.err && result.err.code !== 1) return [];

    return String(result.stdout || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => parseInt(line.split(/\s+/, 1)[0], 10))
        .filter(pid => Number.isInteger(pid) && pid > 0);
}

async function isBotRunning() {
    // Fast path: forked by us and IPC still up
    if (botProcess && botProcess.connected) return true;
    // Fast path: we know the PID from a previous fork
    if (botPid && isPidAlive(botPid)) return true;
    if (botPid && !isPidAlive(botPid)) botPid = null;

    const externalPids = await findExternalBotPids();
    if (externalPids.length > 0) {
        botPid = externalPids[0];
        return true;
    }

    return false;
}

let startInFlight = false;

async function startBot() {
    if (startInFlight) return;
    startInFlight = true;
    try {
        if (await isBotRunning()) return;
        botProcess = fork(path.resolve(__dirname, 'hclaw.js'), [], {
            stdio: ['ignore', 'ignore', 'ignore', 'ipc']
        });
        botPid = botProcess.pid;
        botProcess.on('exit', () => {
            botProcess = null;
            botPid = null;
        });
    } catch (e) {
    } finally {
        startInFlight = false;
    }
}

async function stopBot() {
    if (botProcess && botProcess.connected) {
        botProcess.send({ type: 'stop' });
        // Fail-safe kill inside timer
        setTimeout(() => {
             if (botProcess) botProcess.kill('SIGKILL');
        }, 3000);
    } else if (botPid && isPidAlive(botPid)) {
        // Started by us but IPC disconnected — kill by known PID
        try { process.kill(botPid, 'SIGTERM'); } catch (e) {}
        botPid = null;
    } else {
        // Force kill if started outside
        try {
            const externalPids = await findExternalBotPids();
            if (process.platform === 'win32') {
                externalPids.forEach((pid) => exec(`taskkill /F /PID ${pid}`));
            } else if (externalPids.length > 0) {
                externalPids.forEach((pid) => {
                    try { process.kill(pid, 'SIGTERM'); } catch (e) {}
                });
            } else {
                exec('pkill -f "node.*hclaw\\.js"');
            }
        } catch (e) {}
    }
}

// HTML Dashboard Content (Inline for no templates requirement)
const html = `
<!DOCTYPE html>
<html>
<head>
    <title>H-Claw OnBoard</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
    <style>
        * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body { margin: 0; display: flex; height: 100vh; background: #fff; color: #111; overflow: hidden; }

        /* Sidebar */
        .sidebar { width: 260px; background: #f9f9f9; border-right: 1px solid #e5e5e5; display: flex; flex-direction: column; padding: 12px 8px; font-size: 15px; }
        .sidebar-header { padding: 8px 12px 16px; font-weight: bold; font-size: 18px; display: flex; align-items: center; gap: 8px; }
        .sidebar-item { display: flex; align-items: center; padding: 10px 12px; border-radius: 8px; cursor: pointer; color: #111; margin-bottom: 2px; transition: background 0.15s; }
        .sidebar-item:hover { background: #ececec; }
        .sidebar-item i { width: 18px; margin-right: 12px; font-size: 18px; color: #444; text-align: center; }
        .sidebar-item .shortcut { margin-left: auto; color: #a0a0a0; font-size: 12px; }
        .sidebar-control { padding: 10px 12px 14px; display: flex; flex-direction: column; gap: 6px; }
        .sidebar-control label { font-size: 13px; color: #444; font-weight: 600; }
        .sidebar-control input { width: 100%; }
        .sidebar-help { font-size: 12px; color: #7a7a7a; line-height: 1.35; }
        .sidebar-item.active { background: #e7f3ef; color: #0f5132; }
        .sidebar-item.active i { color: #0f5132; }

        /* Collapsible Sections */
        .sidebar-section-title { padding: 16px 12px 6px; font-size: 12px; color: #828282; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; }
        .sidebar-section-title:hover { color: #111; }
        .sidebar-section-title i { font-size: 11px; transition: transform 0.2s; }
        .sidebar-section-title.collapsed i { transform: rotate(-90deg); }
        .sidebar-section-content { overflow: hidden; transition: max-height 0.2s ease-out; max-height: 500px; }
        .sidebar-section-content.collapsed { max-height: 0; }

        /* Main Content Area */
        .main-content { flex: 1; display: flex; flex-direction: column; background: #ffffff; overflow: hidden; }
        .main-pane { flex: 1; display: none; flex-direction: column; overflow: hidden; }
        .main-pane.active { display: flex; }

        /* Header / Top Control Bar */
        .header { padding: 15px 20px; border-bottom: 1px solid #f0f0f0; display: flex; justify-content: space-between; align-items: center; background: #fff; }
        .header h1 { margin: 0; font-size: 22px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
        .controls { display: flex; gap: 8px; align-items: center; }

        button { padding: 8px 14px; cursor: pointer; border: 1px solid #d5d5d5; font-size: 14px; font-weight: 500; background: #ffffff; color: #333; border-radius: 6px; display: flex; align-items: center; gap: 6px; transition: background 0.1s; }
        button:hover { background: #f5f5f5; }
        button.start { background: #10a37f; color: #fff; border: none; } /* ChatGPT green */
        button.start:hover { background: #0e8f6d; }
        button.stop { background: #df3022; color: #fff; border: none; }
        button.stop:hover { background: #c52419; }

        #status { font-weight: 600; font-size: 13px; padding: 4px 10px; border-radius: 20px; color: #fff; background: #888; }
        button:disabled { opacity: 0.6; cursor: not-allowed; }
        .sidebar-item.disabled { pointer-events: none; opacity: 0.5; filter: grayscale(0.5); }

        /* Layout Grid for Log & Send */
        .workspace { padding: 0 20px 20px; }

        /* Logs Viewer */
        .log-box { flex: 1; background: #ffffff; border: 1px solid #e5e5e5; border-radius: 8px; overflow-y: scroll; font-family: 'Courier New', monospace; padding: 15px; margin-top: 15px; white-space: pre-wrap; font-size: 14px; color: #1a1a1a; }

        .tab-btn { background: #f1f3f4; border: 1px solid #e5e5e5; padding: 8px 16px; border-radius: 8px 8px 0 0; border-bottom: none; cursor: pointer; font-size: 14px; font-weight: 500; color: #5f6368; }
        .tab-btn:hover { background: #e8eaed; }
        .tab-btn.active { background: #ffffff; color: #10a37f; border-bottom: 2px solid #10a37f; font-weight: 600; color: #111; }

        /* Send input block */
        .send-box { margin-top: 15px; padding: 12px; background: #fff; border: 1px solid #e5e5e5; border-radius: 12px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
        select, input { padding: 10px; border: 1px solid #d5d5d5; border-radius: 8px; font-size: 14px; background: #fff; outline: none; }
        select:focus, input:focus { border-color: #10a37f; }
        input#text { flex: 1; }
        .send-btn { border: none; background: #1a1a1a; color: #fff; width: 36px; height: 36px; padding: 0; display: flex; align-items: center; justify-content: center; border-radius: 50%; }
        .send-btn:hover { background: #333; }
        .send-btn i { font-size: 15px; }
        .attachment-chip { display: none; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid #d5d5d5; border-radius: 999px; background: #f7faf8; color: #184c3c; font-size: 13px; }
        .attachment-chip.visible { display: inline-flex; }
        .attachment-chip button { width: 24px; height: 24px; padding: 0; border-radius: 50%; }
        .send-hint { width: 100%; font-size: 13px; color: #7a7a7a; }
        .settings-pane { padding: 24px 20px 20px; gap: 18px; }
        .settings-card { max-width: 520px; border: 1px solid #e5e5e5; border-radius: 14px; background: #fff; padding: 18px; display: flex; flex-direction: column; gap: 12px; }
        .settings-card h2 { margin: 0; font-size: 20px; }
        .settings-card p { margin: 0; color: #666; font-size: 14px; line-height: 1.45; }
        .settings-field { display: flex; flex-direction: column; gap: 8px; }
        .settings-field label { font-size: 14px; font-weight: 600; color: #333; }
        .settings-field input { max-width: 180px; }
    </style>
</head>
<body>
    <div class="sidebar">
        <div class="sidebar-header">
            <span>🐾</span> H-Claw OnBoard
        </div>
        
        
        <div class="sidebar-section-title" onclick="toggleSection(this, 'actionsContent')">
            <span>Actions</span> <i class="fa-solid fa-chevron-down"></i>
        </div>
        <div id="actionsContent" class="sidebar-section-content">
            <div id="sidebar-start" class="sidebar-item" onclick="fetch('/api/start').then(loadStatus)">
                <i class="fa-solid fa-play"></i> Start Bot
            </div>
            <div id="sidebar-stop" class="sidebar-item" onclick="fetch('/api/stop').then(loadStatus)">
                <i class="fa-solid fa-stop" style="color: #df3022;"></i> Stop Bot
            </div>
        </div>

        <div class="sidebar-section-title" onclick="toggleSection(this, 'clientsContent')">
            <span>Clients</span> <i class="fa-solid fa-chevron-down"></i>
        </div>
        <div id="clientsContent" class="sidebar-section-content">
            <div class="sidebar-item" id="navWaLog" onclick="showPane('waLogPane', this)">
                <i class="fa-brands fa-whatsapp"></i> WhatsApp
            </div>
            <div class="sidebar-item" id="navTgLog" onclick="showPane('tgLogPane', this)">
                <i class="fa-brands fa-telegram"></i> Telegram
            </div>
            <div class="sidebar-item" id="navObLog" onclick="showPane('obLogPane', this)">
                <i class="fa-solid fa-display"></i> OnBoard
            </div>
        </div>

        <div class="sidebar-section-title" onclick="toggleSection(this, 'viewsContent')">
            <span>Views</span> <i class="fa-solid fa-chevron-down"></i>
        </div>
        <div id="viewsContent" class="sidebar-section-content">
            <div class="sidebar-item active" id="navWorkspace" onclick="showPane('workspacePane', this)">
                <i class="fa-regular fa-rectangle-list"></i> System Chat
            </div>
            <div class="sidebar-item" id="navBotLog" onclick="showPane('botLogPane', this)">
                <i class="fa-solid fa-file-invoice"></i> Bot Logs
            </div>
            <div class="sidebar-item" id="navSettings" onclick="showPane('settingsPane', this)">
                <i class="fa-solid fa-sliders"></i> Settings
            </div>
        </div>
    </div>

    <div class="main-content">
        <div class="header">
            <h1>🐾 H-Claw Admin</h1>
            <div class="controls">
                <button id="start-btn" class="start" onclick="fetch('/api/start').then(loadStatus)"><i class="fa-solid fa-play"></i> Start</button>
                <button id="stop-btn" class="stop" onclick="fetch('/api/stop').then(loadStatus)"><i class="fa-solid fa-stop"></i> Stop</button>
                <span id="status">Checking...</span>
            </div>
        </div>

        <div class="workspace main-pane active" id="workspacePane" style="flex-direction: column; padding: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 8px; border-bottom: 1px solid #f0f0f0; margin-bottom: 10px;">
                <h3 style="margin: 0; font-size: 14px; font-weight: 600;"><i class="fa-solid fa-desktop" style="margin-right: 6px;"></i> System Chat</h3>
                <button onclick="cleanSystemLogs()" style="padding: 4px 10px; font-size: 11px; height: 28px; border-radius: 6px;"><i class="fa-solid fa-trash-can"></i> Clean</button>
            </div>
            
            <div class="log-box" id="logBox" style="flex: 1; margin-top: 0;"></div>

        </div>

        <!-- WhatsApp Log Pane -->
        <div class="workspace main-pane" id="waLogPane" style="flex-direction: column; padding: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 8px; border-bottom: 1px solid #f0f0f0;">
                <h3 style="margin: 0; font-size: 14px; font-weight: 600;"><i class="fa-brands fa-whatsapp" style="margin-right: 6px; color: #25d366;"></i> WhatsApp Messages</h3>
            </div>
            <div class="log-box" id="waLogBox" style="flex: 1; margin-top: 10px; background: #fafafa;"></div>
        </div>

        <!-- Telegram Log Pane -->
        <div class="workspace main-pane" id="tgLogPane" style="flex-direction: column; padding: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 8px; border-bottom: 1px solid #f0f0f0;">
                <h3 style="margin: 0; font-size: 14px; font-weight: 600;"><i class="fa-brands fa-telegram" style="margin-right: 6px; color: #229ed9;"></i> Telegram Messages</h3>
            </div>
            <div class="log-box" id="tgLogBox" style="flex: 1; margin-top: 10px; background: #fafafa;"></div>
        </div>

        <!-- OnBoard Log Pane -->
        <div class="workspace main-pane" id="obLogPane" style="flex-direction: column; padding: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 8px; border-bottom: 1px solid #f0f0f0;">
                <h3 style="margin: 0; font-size: 14px; font-weight: 600;"><i class="fa-solid fa-terminal" style="margin-right: 6px;"></i> OnBoard Logs</h3>
            </div>
            <div class="log-box" id="obLogBox" style="flex: 1; margin-top: 10px; background: #fafafa;"></div>
        </div>

        <!-- Bot Logs Pane -->
        <div class="workspace main-pane" id="botLogPane" style="flex-direction: column; padding: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 8px; border-bottom: 1px solid #f0f0f0;">
                <h3 style="margin: 0; font-size: 14px; font-weight: 600;"><i class="fa-solid fa-list-check" style="margin-right: 6px;"></i> Bot Logs</h3>
                <button onclick="cleanLogs()" style="padding: 4px 10px; font-size: 11px; height: 28px; border-radius: 6px;"><i class="fa-solid fa-trash-can"></i> Clean</button>
            </div>
            <div class="log-box" id="botLogBox" style="flex: 1; margin-top: 10px; background: #fafafa;"></div>
        </div>

        <div class="settings-pane main-pane" id="settingsPane">
            <div class="settings-card">
                <h2>Bot Context</h2>
                <p>Control how much recent OnBoard conversation is injected into the next bot prompt.</p>
                <div class="settings-field">
                    <label for="historyLimit">Injected History Messages</label>
                    <input id="historyLimit" type="number" min="0" max="50" step="1" value="6">
                    <div class="sidebar-help">Set to 0 for no injected history. Higher values add more prior OnBoard turns to prompt context.</div>
                </div>
            </div>

            <div class="settings-card">
                <h2>Bot Model</h2>
                <p>Select the default AI Model to use for Bot operations triggers.</p>
                <div class="settings-field">
                    <label for="defaultBotModel" style="margin-bottom: 4px;">Default Bot Model</label>
                    <select id="defaultBotModel" style="padding: 8px 10px; border-radius: 6px; border: 1px solid #e5e5e5; width: 100%; background: #fff; outline: none;"></select>
                </div>
            </div>

            <div class="settings-card">
                <h2>Image Model</h2>
                <p>Select the default AI Model to use for Image generation triggers.</p>
                <div class="settings-field">
                    <label for="defaultImageModel" style="margin-bottom: 4px;">Default Image Model</label>
                    <select id="defaultImageModel" style="padding: 8px 10px; border-radius: 6px; border: 1px solid #e5e5e5; width: 100%; background: #fff; outline: none;"></select>
                </div>
            </div>
        </div>
        <div class="send-box" style="padding: 15px 20px 20px; border-top: 1px solid #e5e5e5; background: #fff;">
            <select id="platform" style="width: 130px;">
                <option value="onboard">OnBoard</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="telegram">Telegram</option>
            </select>
            <input id="target" placeholder="Recipient ID" style="width: 140px;">
            <input id="text" placeholder="Message H-Claw...">
            <button class="send-btn" onclick="sendMessage()"><i class="fa-solid fa-arrow-up"></i></button>
            <span id="sendResult" style="font-size: 12px; color: #888; margin-left: 5px;"></span>
            <div id="attachmentChip" class="attachment-chip">
                <span id="attachmentLabel"></span>
                <button type="button" onclick="clearPastedImage()"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="send-hint">Paste an image into the message box to attach it.</div>
        </div>
    </div>

    <script>
        const statusSpan = document.getElementById('status');
        const logBox = document.getElementById('logBox');
        const botLogBox = document.getElementById('botLogBox');
        const textInput = document.getElementById('text');
        const historyLimitInput = document.getElementById('historyLimit');
        const attachmentChip = document.getElementById('attachmentChip');
        const attachmentLabel = document.getElementById('attachmentLabel');
        let logSelectionLocked = false;
        const messageHistory = [];
        let historyIndex = -1;
        let historyDraft = '';
        let pastedImage = null;
        let latestStatusRequest = 0;

        function getHistoryLimit() {
            const parsed = Number.parseInt(historyLimitInput.value, 10);
            if (!Number.isFinite(parsed)) return 6;
            return Math.max(0, Math.min(50, parsed));
        }

        function hasSelectionInside(node) {
            const selection = window.getSelection();
            if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;

            const anchorNode = selection.anchorNode;
            const focusNode = selection.focusNode;
            return node && (node.contains(anchorNode) || node.contains(focusNode));
        }

        function toggleSection(titleEl, contentId) {
            const content = document.getElementById(contentId);
            content.classList.toggle('collapsed');
            titleEl.classList.toggle('collapsed');
        }

        function showPane(paneId, navEl) {
            document.querySelectorAll('.main-pane').forEach((pane) => {
                pane.classList.toggle('active', pane.id === paneId);
            });
            document.querySelectorAll('.sidebar-item').forEach((item) => {
                item.classList.remove('active');
            });
            if (navEl) navEl.classList.add('active');
        }

        async function loadStatus() {
            const requestId = ++latestStatusRequest;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2500);

            try {
                const response = await fetch('/api/status', {
                    signal: controller.signal,
                    cache: 'no-store'
                });
                const d = await response.json();
                if (requestId !== latestStatusRequest) return;
                statusSpan.innerText = d.running ? '🟢 RUNNING' : '🔴 STOPPED';
                statusSpan.style.background = d.running ? '#1b5e20' : '#b71c1c';
                document.getElementById('start-btn').disabled = d.running;
                document.getElementById('stop-btn').disabled = !d.running;
                const sStart = document.getElementById('sidebar-start');
                const sStop = document.getElementById('sidebar-stop');
                if (sStart) sStart.classList.toggle('disabled', d.running);
                if (sStop) sStop.classList.toggle('disabled', !d.running);
            } catch (e) {
                if (requestId !== latestStatusRequest) return;
                statusSpan.innerText = '⚠️ UNREACHABLE';
                statusSpan.style.background = '#92400e';
            } finally {
                clearTimeout(timeoutId);
            }
        }

        function renderLogContent(text) {
            return text.split('\n').map(line => {
                const escaped = line
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');
                return escaped.replace(/\[image: ([^\]]+)\]/g, function(_, imgPath) {
                    const src = '/api/image?path=' + encodeURIComponent(imgPath);
                    return '<img src="' + src + '" style="max-width:240px;max-height:180px;border-radius:6px;vertical-align:middle;margin:4px 0;display:block;cursor:pointer;border:1px solid #e5e5e5;" onclick="window.open(this.src)" title="' + imgPath + '">';
                });
            }).join('\n');
        }

        function loadLogs() {
            fetch('/api/logs').then(r => r.text()).then(t => {
                if (logSelectionLocked || hasSelectionInside(logBox)) return;
                const wasAtBottom = logBox.scrollHeight - logBox.clientHeight <= logBox.scrollTop + 5;
                logBox.innerHTML = renderLogContent(t);
                if (wasAtBottom) logBox.scrollTop = logBox.scrollHeight;
            });
        }

        logBox.addEventListener('mousedown', function() {
            logSelectionLocked = true;
        });

        if (botLogBox) {
            botLogBox.addEventListener('mousedown', function() {
                logSelectionLocked = true;
            });
        }

        document.addEventListener('mouseup', function() {
            logSelectionLocked = hasSelectionInside(logBox) || hasSelectionInside(botLogBox);
        });

        document.addEventListener('selectionchange', function() {
            logSelectionLocked = hasSelectionInside(logBox) || hasSelectionInside(botLogBox);
        });

        function sendMessage() {
            const text = textInput.value;
            const trimmedText = text.trim();
            if (!trimmedText && !pastedImage) return;

            const formData = new URLSearchParams();
            formData.append('platform', document.getElementById('platform').value);
            formData.append('target', document.getElementById('target').value);
            formData.append('text', text);
            formData.append('history_limit', String(getHistoryLimit()));
            if (pastedImage && pastedImage.path) {
                formData.append('image_path', pastedImage.path);
            }

            fetch('/api/send', { method: 'POST', body: formData })
                .then(r => r.json())
                .then(d => { 
                    const res = document.getElementById('sendResult');
                    res.innerText = d.success ? '✅ Sent' : '❌ Failed';
                    setTimeout(() => { if (res.innerText !== 'Uploading image...') res.innerText = ''; }, 3000);
                    if (d.success) {
                        if (messageHistory[messageHistory.length - 1] !== text) {
                            messageHistory.push(text);
                        }
                        historyIndex = -1;
                        historyDraft = '';
                        textInput.value = '';
                        clearPastedImage();
                    }
                });
        }

        function renderPastedImage() {
            if (!pastedImage) {
                attachmentChip.classList.remove('visible');
                attachmentLabel.textContent = '';
                return;
            }

            attachmentChip.classList.add('visible');
            attachmentLabel.textContent = pastedImage.name;
        }

        function clearPastedImage() {
            pastedImage = null;
            renderPastedImage();
        }

        async function uploadPastedImage(file) {
            const reader = new FileReader();
            const dataUrl = await new Promise((resolve, reject) => {
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(file);
            });

            const response = await fetch('/api/paste-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: file.name || 'clipboard-image.png',
                    type: file.type || 'image/png',
                    data_url: dataUrl,
                }),
            });

            const result = await response.json();
            if (!result.success) {
                throw new Error(result.error || 'Upload failed.');
            }

            pastedImage = {
                name: result.name,
                path: result.path,
            };
            renderPastedImage();
            document.getElementById('sendResult').innerText = '🖼️ Image attached';
        }

        function setHistoryValue(value) {
            textInput.value = value;
            requestAnimationFrame(() => {
                textInput.setSelectionRange(textInput.value.length, textInput.value.length);
            });
        }

        // Send on Enter
        textInput.addEventListener('keydown', function(e) {
            if (e.key === 'ArrowUp') {
                if (messageHistory.length === 0) return;
                e.preventDefault();
                if (historyIndex === -1) {
                    historyDraft = textInput.value;
                    historyIndex = messageHistory.length - 1;
                } else if (historyIndex > 0) {
                    historyIndex -= 1;
                }
                setHistoryValue(messageHistory[historyIndex]);
                return;
            }

            if (e.key === 'ArrowDown') {
                if (historyIndex === -1) return;
                e.preventDefault();
                if (historyIndex < messageHistory.length - 1) {
                    historyIndex += 1;
                    setHistoryValue(messageHistory[historyIndex]);
                } else {
                    historyIndex = -1;
                    setHistoryValue(historyDraft);
                }
                return;
            }

            if (e.key === 'Enter') {
                e.preventDefault();
                sendMessage();
            }
        });

        textInput.addEventListener('paste', async function(e) {
            const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
            const imageItem = items.find(item => item.type && item.type.startsWith('image/'));
            if (!imageItem) return;

            e.preventDefault();
            const file = imageItem.getAsFile();
            if (!file) return;

            try {
                document.getElementById('sendResult').innerText = 'Uploading image...';
                await uploadPastedImage(file);
            } catch (error) {
                document.getElementById('sendResult').innerText = '❌ Image paste failed';
            }
        });

        function loadSettings() {
            fetch('/api/settings').then(r => r.json()).then(d => {
                historyLimitInput.value = d.historyLimit;
                const modelSel = document.getElementById('defaultBotModel');
                if (modelSel) {
                    modelSel.innerHTML = '';
                    (d.models || []).forEach((m, idx) => {
                        const opt = document.createElement('option');
                        opt.value = idx + 1;
                        opt.textContent = m;
                        if (parseInt(d.defaultBotModel) === (idx + 1)) opt.selected = true;
                        modelSel.appendChild(opt);
                    });
                }
                const imgSel = document.getElementById('defaultImageModel');
                if (imgSel) {
                    imgSel.innerHTML = '';
                    (d.imageModels || []).forEach((m, idx) => {
                        const opt = document.createElement('option');
                        opt.value = idx + 1;
                        opt.textContent = m;
                        if (parseInt(d.defaultImageModel) === (idx + 1)) opt.selected = true;
                        imgSel.appendChild(opt);
                    });
                }
            });
        }

        function saveSettings() {
            const historyLimit = parseInt(historyLimitInput.value, 10);
            const defaultBotModel = parseInt(document.getElementById('defaultBotModel').value || '1', 10);
            const defaultImageModel = parseInt(document.getElementById('defaultImageModel').value || '1', 10);
            fetch('/api/settings', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({ historyLimit, defaultBotModel, defaultImageModel })
            });
        }

        historyLimitInput.addEventListener('change', saveSettings);
        document.getElementById('defaultBotModel').addEventListener('change', saveSettings);
        document.getElementById('defaultImageModel').addEventListener('change', saveSettings);

        function cleanLogs() {
             fetch('/api/clean-bot-logs').then(() => { if (botLogBox) botLogBox.innerHTML = ''; });
        }

        function cleanSystemLogs() {
             fetch('/api/clean').then(() => { if (logBox) logBox.innerHTML = ''; });
        }

        function loadBotLogs() {
            const pane = document.getElementById('botLogPane');
            if (!pane || !pane.classList.contains('active') || !botLogBox) return;

            fetch('/api/bot-logs').then(r => r.text()).then(t => {
                if (logSelectionLocked || hasSelectionInside(botLogBox)) return;
                const wasAtBottom = botLogBox.scrollHeight - botLogBox.clientHeight <= botLogBox.scrollTop + 5;
                botLogBox.innerText = t;
                if (wasAtBottom) botLogBox.scrollTop = botLogBox.scrollHeight;
            });
        }

        function makeLogLoader(paneId, boxId, endpoint) {
            return function() {
                const pane = document.getElementById(paneId);
                const box = document.getElementById(boxId);
                if (!pane || !pane.classList.contains('active') || !box) return;
                fetch(endpoint).then(r => r.text()).then(t => {
                    if (logSelectionLocked || hasSelectionInside(box)) return;
                    const wasAtBottom = box.scrollHeight - box.clientHeight <= box.scrollTop + 5;
                    box.innerText = t;
                    if (wasAtBottom) box.scrollTop = box.scrollHeight;
                });
            };
        }

        const loadWaLogs = makeLogLoader('waLogPane', 'waLogBox', '/api/wa-logs');
        const loadTgLogs = makeLogLoader('tgLogPane', 'tgLogBox', '/api/tg-logs');
        const loadObLogs = makeLogLoader('obLogPane', 'obLogBox', '/api/ob-logs');

        setInterval(loadStatus, 2000);
        setInterval(loadLogs, 1000);
        setInterval(loadBotLogs, 1000);
        setInterval(loadWaLogs, 1000);
        setInterval(loadTgLogs, 1000);
        setInterval(loadObLogs, 1000);
        loadStatus();
        loadLogs();
        loadBotLogs();
        loadWaLogs();
        loadTgLogs();
        loadObLogs();
        loadSettings();
    </script>
</body>
</html>
`;

// Create Server
const server = http.createServer((req, res) => {
    const { url, method } = req;

    if (url === '/' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
    }

    if (url === '/api/status' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        isBotRunning().then(running => {
            res.end(JSON.stringify({ running }));
        }).catch(() => {
            res.end(JSON.stringify({ running: false }));
        });
        return;
    }

    if (url === '/api/start' && method === 'GET') {
        startBot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
    }

    if (url === '/api/stop' && method === 'GET') {
        stopBot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
    }

    if (url === '/api/clean' && method === 'GET') {
        try {
            fs.writeFileSync(logFile, '');
        } catch (e) {}
        if (botProcess && botProcess.connected) {
            botProcess.send({ type: 'clear_onboard_history' });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
    }

    if (url === '/api/logs' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        if (fs.existsSync(logFile)) {
            try {
                const content = fs.readFileSync(logFile, 'utf8').split('\n').slice(-200).join('\n');
                res.end(content);
            } catch (e) {
                res.end('Error reading log.');
            }
        } else {
             res.end('Log file not found.');
        }
        return;
    }

    if (url.startsWith('/api/image') && method === 'GET') {
        const imgPath = new URLSearchParams(url.split('?')[1] || '').get('path') || '';
        const resolved = path.resolve(imgPath);
        const safeDirs = [path.resolve(__dirname, 'tmp'), path.resolve(__dirname, 'MD', 'media')];
        const isSafe = safeDirs.some(d => resolved.startsWith(d));
        if (!isSafe || !fs.existsSync(resolved)) {
            res.writeHead(404); return res.end('Not found');
        }
        const ext = path.extname(resolved).toLowerCase();
        const mimes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
        res.writeHead(200, { 'Content-Type': mimes[ext] || 'application/octet-stream' });
        return fs.createReadStream(resolved).pipe(res);
    }

    if (url === '/api/bot-logs' && method === 'GET') {
        const botLog = path.resolve(__dirname, 'logs', 'bot_log.txt');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        if (fs.existsSync(botLog)) {
            try {
                const content = fs.readFileSync(botLog, 'utf8').split('\n').slice(-200).join('\n');
                res.end(content);
            } catch (e) {
                res.end('Error reading bot log.');
            }
        } else {
             res.end('Bot log file not found.');
        }
        return;
    }

    if (url === '/api/wa-logs' && method === 'GET') {
        const waLogFile = path.resolve(__dirname, 'logs', 'wa_log.txt');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        if (fs.existsSync(logFile)) {
            try {
                const lines = fs.readFileSync(logFile, 'utf8')
                    .split('\n')
                    .filter(line => line.includes(' WA '))
                    .slice(-100);
                const content = lines.join('\n');
                res.end(content);
            } catch (e) {
                res.end('Error reading log.');
            }
        } else if (fs.existsSync(waLogFile)) {
            fs.createReadStream(waLogFile).pipe(res);
        } else {
            res.end('Log file not found.');
        }
        return;
    }

    if (url === '/api/tg-logs' && method === 'GET') {
        const tgLogFile = path.resolve(__dirname, 'logs', 'tg_log.txt');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        if (fs.existsSync(logFile)) {
            try {
                const lines = fs.readFileSync(logFile, 'utf8')
                    .split('\n')
                    .filter(line => line.includes(' TG '))
                    .slice(-100);
                const content = lines.join('\n');
                res.end(content);
            } catch (e) {
                res.end('Error reading log.');
            }
        } else if (fs.existsSync(tgLogFile)) {
            fs.createReadStream(tgLogFile).pipe(res);
        } else {
            res.end('Log file not found.');
        }
        return;
    }

    if (url === '/api/ob-logs' && method === 'GET') {
        const obLogFile = path.resolve(__dirname, 'logs', 'ob_log.txt');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        if (fs.existsSync(logFile)) {
            try {
                const lines = fs.readFileSync(logFile, 'utf8')
                    .split('\n')
                    .filter(line => line.includes('[OB]') || line.includes('[OnBoard]'))
                    .slice(-100);
                const content = lines.join('\n');
                res.end(content);
            } catch (e) {
                res.end('Error reading log.');
            }
        } else if (fs.existsSync(obLogFile)) {
            fs.createReadStream(obLogFile).pipe(res);
        } else {
            res.end('Log file not found.');
        }
        return;
    }

    if (url === '/api/clean-bot-logs' && method === 'GET') {
        const botLog = path.resolve(__dirname, 'logs', 'bot_log.txt');
        try {
            fs.writeFileSync(botLog, '');
        } catch (e) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
    }

    if (url === '/api/settings' && method === 'GET') {
        const envBotPath = path.resolve(__dirname, 'secrets', '.env_bot');
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

        let models = [];
        let imageModels = [];
        try {
            const { getAvailableModels, getAvailableImageModels } = require('./src/Models');
            models = getAvailableModels();
            imageModels = getAvailableImageModels();
        } catch(e){}

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ historyLimit, defaultBotModel, defaultImageModel, models, imageModels }));
    }

    if (url === '/api/settings' && method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
             try {
                 const payload = JSON.parse(body || '{}');
                 const envBotPath = path.resolve(__dirname, 'secrets', '.env_bot');
                 
                 let lines = [];
                 if (fs.existsSync(envBotPath)) {
                     lines = fs.readFileSync(envBotPath, 'utf8').split('\n').filter(Boolean);
                 }
                 
                 const updateVar = (key, val) => {
                     const idx = lines.findIndex(l => l.startsWith(`${key}=`));
                     if (idx !== -1) lines[idx] = `${key}=${val}`;
                     else lines.push(`${key}=${val}`);
                 };

                 if (payload.historyLimit !== undefined) updateVar('BOT_LOG_HISTORY_LIMIT', payload.historyLimit);
                 if (payload.defaultBotModel !== undefined) updateVar('DEFAULT_BOT_MODEL', payload.defaultBotModel);
                 if (payload.defaultImageModel !== undefined) updateVar('DEFAULT_IMAGE_MODEL', payload.defaultImageModel);

                 fs.writeFileSync(envBotPath, lines.join('\n').trim() + '\n');

                 if (botProcess && botProcess.connected) {
                     botProcess.send({ type: 'update_settings', settings: payload });
                 }

                 res.writeHead(200, { 'Content-Type': 'application/json' });
                 res.end(JSON.stringify({ success: true }));
             } catch(e) {
                 res.writeHead(500); res.end();
             }
        });
        return;
    }

    if (url === '/api/paste-image' && method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const payload = JSON.parse(body || '{}');
                const type = String(payload.type || 'image/png');
                const ext = type.split('/')[1] || 'png';
                const match = String(payload.data_url || '').match(/^data:.*?;base64,(.+)$/);
                if (!match) throw new Error('Invalid image payload.');

                const fileName = `onboard_paste_${Date.now()}.${ext.replace(/[^a-z0-9]/gi, '') || 'png'}`;
                const filePath = path.join(tmpDir, fileName);
                fs.writeFileSync(filePath, Buffer.from(match[1], 'base64'));

                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    success: true,
                    name: payload.name || fileName,
                    path: filePath,
                }));
            } catch (e) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    if (url === '/api/send' && method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            const params = new URLSearchParams(body);
            const platform = params.get('platform');
            const target = params.get('target');
            const text = params.get('text');
            const imagePath = params.get('image_path');
            const historyLimit = params.get('history_limit');

            if (platform === 'onboard') {
                try {
                    const ts = `${new Date().toISOString().split('T')[0]} ${new Date().toTimeString().split(' ')[0]}`;
                    const logLine = imagePath
                        ? `[${ts}] [OnBoard] User: ${text || '(image only)'} [image: ${imagePath}]\n`
                        : `[${ts}] [OnBoard] User: ${text}\n`;
                    fs.appendFileSync(logFile, logLine);
                } catch (e) {}
            }

            if (botProcess && botProcess.connected) {
                botProcess.send({ type: 'send_msg', platform, target, text, image_path: imagePath, history_limit: historyLimit });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: 'Bot is not connected or started by server.' }));
            }
        });
        return;
    }

    res.writeHead(404);
    res.end('Not Found');
});

server.listen(PORT, () => {
    console.log(`🚀 Admin Dashboard live at http://localhost:${PORT}`);
});

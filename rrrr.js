const http = require('http');
const { fork, exec, execFile } = require('child_process');
const path = require('path');

const PORT = 3000;
let botProcess = null;
let botPid = null;

// Helper to check if process with PID is alive
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
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => parseInt(line, 10))
        .filter(pid => Number.isInteger(pid) && pid > 0);
}

async function findBotPids() {
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
    if (result.err) return [];
    
    return String(result.stdout || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => parseInt(line.split(/\s+/, 1)[0], 10))
        .filter(pid => Number.isInteger(pid) && pid > 0);
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
        setTimeout(() => { if (botProcess) botProcess.kill('SIGKILL'); }, 3000);
    } else if (botPid && isPidAlive(botPid)) {
        try { process.kill(botPid, 'SIGTERM'); } catch (e) {}
        botPid = null;
    } else {
        try {
            const externalPids = await findBotPids();
            if (process.platform === 'win32') {
                externalPids.forEach(pid => exec(`taskkill /F /PID ${pid}`));
            } else {
                externalPids.forEach(pid => { try { process.kill(pid, 'SIGTERM'); } catch (e) {} });
                exec('pkill -f "node.*hclaw\\.js"');
            }
        } catch (e) {}
    }
}

// Minimal HTML Panel
const html = `
<!DOCTYPE html>
<html>
<head>
    <title>H-Claw Bot Status</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
    <style>
        * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body { margin: 0; background: #f4f6f8; display: flex; align-items: center; justify-content: center; height: 100vh; color: #333; }
        .card { background: #ffffff; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); width: 360px; padding: 24px; text-align: center; }
        .header { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 20px; font-weight: 600; font-size: 18px; }
        #status-badge { display: inline-block; padding: 6px 14px; border-radius: 20px; font-size: 14px; font-weight: 600; color: #fff; background: #888; margin-bottom: 24px; transition: background 0.3s; }
        .controls { display: flex; gap: 12px; justify-content: center; }
        button { padding: 10px 20px; border-radius: 8px; border: 1px solid #d5d5d5; background: #fff; cursor: pointer; font-size: 14px; font-weight: 500; display: flex; align-items: center; gap: 6px; transition: all 0.2s; }
        button:hover { background: #f5f5f5; }
        button.start { background: #10a37f; color: #fff; border: none; }
        button.start:hover { background: #0e8f6d; }
        button.stop { background: #df3022; color: #fff; border: none; }
        button.stop:hover { background: #c52419; }
        button:disabled { opacity: 0.6; cursor: not-allowed; }
    </style>
</head>
<body>
    <div class="card">
        <div class="header"><i class="fa-solid fa-robot"></i> H-Claw Bot Manager</div>
        <div id="status-badge">Checking...</div>
        <div class="controls">
            <button id="start-btn" class="start" onclick="fetch('/api/start').then(loadStatus)"><i class="fa-solid fa-play"></i> Start</button>
            <button id="stop-btn" class="stop" onclick="fetch('/api/stop').then(loadStatus)"><i class="fa-solid fa-stop"></i> Stop</button>
        </div>
    </div>

    <script>
        const badge = document.getElementById('status-badge');
        function loadStatus() {
            fetch('/api/status').then(r => r.json()).then(d => {
                badge.innerText = d.running ? '🟢 RUNNING' : '🔴 STOPPED';
                badge.style.background = d.running ? '#1b5e20' : '#b71c1c';
                document.getElementById('start-btn').disabled = d.running;
                document.getElementById('stop-btn').disabled = !d.running;
            }).catch(() => {
                badge.innerText = '⚠️ UNREACHABLE';
                badge.style.background = '#92400e';
            });
        }
        setInterval(loadStatus, 2000);
        loadStatus();
    </script>
</body>
</html>
`;

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
        }).catch(() => res.end(JSON.stringify({ running: false })));
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

    res.writeHead(404);
    res.end('Not Found');
});

server.listen(PORT, () => {
    console.log(`🚀 Status Panel live at http://localhost:${PORT}`);
});

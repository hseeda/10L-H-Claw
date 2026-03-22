const fs = require('fs');
const path = require('path');

const SCHEDULE_PATH = path.join(__dirname, '..', 'MD', 'SCHEDULE.json');
const LEGACY_JSON_PATH = path.join(__dirname, '..', 'MD', 'SCHEDULE.md');
const EMPTY_SCHEDULES = { version: 6, tasks: [] };
const RUNNING_WINDOW_MS = 5000;
const MIGRATION_FAR_FUTURE = '2099-12-31T23:59';
const PID_LENGTH = 8;

let scheduledTasks = [];
let lastGeneratedPid = '';

function formatDateTimeLocal(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hour}:${minute}`;
}

function encodePidNumber(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) return '';
    return Math.floor(num).toString(36).padStart(PID_LENGTH, '0').slice(-PID_LENGTH);
}

function decodePidNumber(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!/^[0-9a-z]{8}$/.test(raw)) return null;
    const parsed = parseInt(raw, 36);
    return Number.isFinite(parsed) ? parsed : null;
}

function formatPidTimestamp(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return encodePidNumber(date.getTime());
}

function nextAvailablePid(seed, used = new Set(), floorPid = '') {
    let numeric = Number(seed);
    if (!Number.isFinite(numeric) || numeric < 0) numeric = Date.now();
    let pid = encodePidNumber(numeric);
    while (!pid || used.has(pid) || (floorPid && pid <= floorPid)) {
        numeric += 1;
        pid = encodePidNumber(numeric);
    }
    used.add(pid);
    return pid;
}

function normalizeDateTime(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.toLowerCase() === 'now') return formatDateTimeLocal(new Date());
    if (raw.toLowerCase() === 'infinite') return MIGRATION_FAR_FUTURE;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return '';
    return formatDateTimeLocal(date);
}

function normalizeStatus(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'disabled') return 'disabled';
    if (raw === 'running') return 'running';
    if (raw === 'expired') return 'expired';
    return 'enabled';
}

function normalizeIssuerClient(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'whatsapp' || raw === 'telegram' || raw === 'onboard') return raw;
    return 'onboard';
}

function normalizeIssuerTarget(value) {
    return String(value || '').trim();
}

function normalizeStepTime(value) {
    const raw = String(value || '')
        .toLowerCase()
        .replace(/[٠-٩]/g, (char) => String(char.charCodeAt(0) - 1632))
        .replace(/[۰-۹]/g, (char) => String(char.charCodeAt(0) - 1776));
    const compact = raw.replace(/[^0-9a-z]/g, '');
    const match = compact.match(/^(\d+)(m|h)$/);
    return match ? `${match[1]}${match[2]}` : '';
}

function parseStepMinutes(stepTime) {
    const match = String(stepTime || '').match(/^(\d+)([mh])$/);
    if (!match) return null;
    const value = parseInt(match[1], 10);
    return match[2] === 'h' ? value * 60 : value;
}

function parseTaskDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date;
}

function buildLegacyPid(input = {}, existingTask = {}) {
    const seed = input.start || existingTask.start || input.next_run_time || existingTask.next_run_time || new Date();
    return formatPidTimestamp(seed) || formatPidTimestamp(new Date());
}

function normalizePid(value, input = {}, existingTask = {}) {
    const raw = String(value || '').trim().toLowerCase();
    if (/^[0-9a-z]{8}$/.test(raw)) {
        return raw;
    }
    return buildLegacyPid(input, existingTask);
}

function generateTaskPid() {
    const pid = nextAvailablePid(Date.now(), new Set(), lastGeneratedPid);
    lastGeneratedPid = pid;
    return pid;
}

function clampNextRunTime(candidate, start, stop, referenceTime) {
    if (!start || !stop) return '';
    const candidateDate = candidate instanceof Date ? candidate : parseTaskDate(candidate);
    if (candidateDate && candidateDate >= start && candidateDate <= stop) {
        return formatDateTimeLocal(candidateDate);
    }
    if (referenceTime <= start) return formatDateTimeLocal(start);
    return formatDateTimeLocal(stop);
}

function computeFutureOccurrence(task, referenceTime = new Date()) {
    const start = parseTaskDate(task.start);
    const stop = parseTaskDate(task.stop);
    const stepMinutes = parseStepMinutes(task.step_time);

    if (!start || !stop || stepMinutes === null) return '';
    if (stepMinutes === 0) {
        return referenceTime <= start ? formatDateTimeLocal(start) : formatDateTimeLocal(stop);
    }
    if (referenceTime <= start) return formatDateTimeLocal(start);
    if (referenceTime > stop) return formatDateTimeLocal(stop);

    const stepMs = stepMinutes * 60000;
    const elapsedMs = Math.max(0, referenceTime.getTime() - start.getTime());
    const intervalsElapsed = Math.floor(elapsedMs / stepMs);
    let nextOccurrence = new Date(start.getTime() + intervalsElapsed * stepMs);
    if (nextOccurrence <= referenceTime) {
        nextOccurrence = new Date(nextOccurrence.getTime() + stepMs);
    }

    return clampNextRunTime(nextOccurrence, start, stop, referenceTime);
}

function computeRuntimeState(task, referenceTime = new Date()) {
    const start = parseTaskDate(task.start);
    const stop = parseTaskDate(task.stop);
    const stepMinutes = parseStepMinutes(task.step_time);

    if (!start || !stop || stepMinutes === null) {
        return { status: task.status === 'disabled' ? 'disabled' : 'expired', next_run_time: '' };
    }

    if (referenceTime.getTime() > stop.getTime() + RUNNING_WINDOW_MS) {
        return { status: 'expired', next_run_time: formatDateTimeLocal(stop) };
    }

    let nextRun = parseTaskDate(task.next_run_time);
    if (!nextRun || nextRun < start || nextRun > stop) {
        nextRun = parseTaskDate(clampNextRunTime(task.next_run_time, start, stop, referenceTime));
    }

    if (referenceTime < start) {
        return {
            status: task.status === 'disabled' ? 'disabled' : 'enabled',
            next_run_time: clampNextRunTime(nextRun || start, start, stop, referenceTime)
        };
    }

    if (stepMinutes === 0) {
        const onceTime = clampNextRunTime(nextRun || start, start, stop, referenceTime);
        const onceDate = parseTaskDate(onceTime);
        const withinRunningWindow = onceDate &&
            referenceTime.getTime() >= onceDate.getTime() &&
            referenceTime.getTime() <= onceDate.getTime() + RUNNING_WINDOW_MS;
        return {
            status: task.status === 'disabled' ? 'disabled' : withinRunningWindow ? 'running' : (referenceTime.getTime() > stop.getTime() + RUNNING_WINDOW_MS ? 'expired' : 'enabled'),
            next_run_time: onceTime
        };
    }

    const nextRunText = clampNextRunTime(nextRun || start, start, stop, referenceTime);
    const nextRunDate = parseTaskDate(nextRunText);
    if (!nextRunDate) {
        return { status: task.status === 'disabled' ? 'disabled' : 'expired', next_run_time: formatDateTimeLocal(stop) };
    }

    const withinRunningWindow = referenceTime.getTime() >= nextRunDate.getTime() &&
        referenceTime.getTime() <= nextRunDate.getTime() + RUNNING_WINDOW_MS;

    return {
        status: task.status === 'disabled' ? 'disabled' : withinRunningWindow ? 'running' : 'enabled',
        next_run_time: nextRunText
    };
}

function normalizeTask(input, existingTask = {}) {
    const task = {
        pid: normalizePid(input.pid !== undefined ? input.pid : existingTask.pid, input, existingTask),
        start: normalizeDateTime(input.start !== undefined ? input.start : existingTask.start),
        stop: normalizeDateTime(input.stop !== undefined ? input.stop : existingTask.stop),
        step_time: normalizeStepTime(input.step_time !== undefined ? input.step_time : existingTask.step_time),
        prompt: String(input.prompt !== undefined ? input.prompt : existingTask.prompt || '').trim(),
        status: normalizeStatus(input.status !== undefined ? input.status : existingTask.status),
        next_run_time: normalizeDateTime(input.next_run_time !== undefined ? input.next_run_time : existingTask.next_run_time),
        issuer_client: normalizeIssuerClient(input.issuer_client !== undefined ? input.issuer_client : existingTask.issuer_client),
        issuer_target: normalizeIssuerTarget(input.issuer_target !== undefined ? input.issuer_target : existingTask.issuer_target)
    };

    if (task.issuer_client === 'onboard') {
        task.issuer_target = 'dashboard';
    } else if (task.issuer_target === 'dashboard') {
        task.issuer_target = '';
    }

    if (!task.start) throw new Error('Start must be a valid local datetime.');
    if (!task.stop) throw new Error('Stop must be a valid local datetime.');
    if (!task.step_time) throw new Error('Step time must be `#m`, `# m`, `#h`, `# h`, or `0m` for Run Once.');
    if (!task.prompt) throw new Error('Prompt is required.');

    return task;
}

function mergeLegacyStart(task) {
    const start = String(task.start || '').trim();
    if (start) return normalizeDateTime(start);

    const startDate = String(task.start_date || 'now').trim().toLowerCase();
    const startTime = String(task.start_time || '').trim();
    if (startDate === 'now' && startTime) {
        return normalizeDateTime(`${formatDateTimeLocal(new Date()).slice(0, 10)}T${startTime}`);
    }
    if (startDate !== 'now' && startTime) {
        return normalizeDateTime(`${startDate}T${startTime}`);
    }
    return normalizeDateTime(startDate);
}

function mergeLegacyStop(task) {
    const stop = String(task.stop || '').trim();
    if (stop) return normalizeDateTime(stop);

    const endDate = String(task.end_date || 'infinite').trim().toLowerCase();
    const endTime = String(task.end_time || '').trim().toLowerCase();
    if (endDate === 'infinite' || endTime === 'forever' || !endTime) {
        return MIGRATION_FAR_FUTURE;
    }
    return normalizeDateTime(`${endDate}T${endTime}`);
}

function parseLegacyMarkdown(content) {
    const tasks = [];
    for (const line of String(content || '').split(/\r?\n/)) {
        if (!line.startsWith('|') || line.startsWith('| ID') || line.startsWith('|---')) continue;
        const cols = line.split('|').map((c) => c.trim()).filter((_, i) => i > 0);
        if (cols.length < 6) continue;
        const [idStr, timeExpr, , , status, ...promptParts] = cols;
        const id = parseInt(idStr, 10);
        if (!Number.isInteger(id)) continue;

        const expr = String(timeExpr || '').trim().toLowerCase();
        const range = expr.match(/^start\s+(\d{1,2}):(\d{2})\s+end\s+((?:\d{1,2}:\d{2})|forever)\s+step\s+(\d+\s*[mh])$/);
        if (!range) continue;

        const today = formatDateTimeLocal(new Date()).slice(0, 10);
        const start = normalizeDateTime(`${today}T${range[1].padStart(2, '0')}:${range[2]}`);
        const stop = range[3] === 'forever'
            ? MIGRATION_FAR_FUTURE
            : normalizeDateTime(`${today}T${range[3]}`);

        tasks.push(normalizeTask({
            pid: buildLegacyPid({ id, start }),
            start,
            stop,
            step_time: normalizeStepTime(range[4]),
            prompt: promptParts.join('|').replace(/\|+$/, '').trim(),
            status,
            next_run_time: '',
            issuer_client: 'onboard',
            issuer_target: 'dashboard'
        }));
    }
    return { version: 6, tasks };
}

function ensureScheduleFile() {
    fs.mkdirSync(path.dirname(SCHEDULE_PATH), { recursive: true });
    if (fs.existsSync(SCHEDULE_PATH)) return;

    if (fs.existsSync(LEGACY_JSON_PATH)) {
        const legacyRaw = fs.readFileSync(LEGACY_JSON_PATH, 'utf8').trim();
        let payload = { ...EMPTY_SCHEDULES };

        if (legacyRaw) {
            try {
                const parsed = JSON.parse(legacyRaw);
                const legacyTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
                payload.tasks = legacyTasks.map((task) => normalizeTask({
                    pid: task.pid,
                    id: task.id,
                    start: mergeLegacyStart(task),
                    stop: mergeLegacyStop(task),
                    step_time: task.step_time,
                    prompt: task.prompt,
                    status: task.status,
                    next_run_time: task.next_run_time,
                    issuer_client: task.issuer_client,
                    issuer_target: task.issuer_target
                }, task));
            } catch (error) {
                payload = parseLegacyMarkdown(legacyRaw);
            }
        }

        fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(payload, null, 2), 'utf8');
        return;
    }

    fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(EMPTY_SCHEDULES, null, 2), 'utf8');
}

function readScheduleData() {
    ensureScheduleFile();
    const raw = fs.readFileSync(SCHEDULE_PATH, 'utf8').trim();
    if (!raw) return { ...EMPTY_SCHEDULES };
    const parsed = JSON.parse(raw);
    const tasks = Array.isArray(parsed.tasks) ? ensureUniqueTaskPids(parsed.tasks.map((task) => normalizeTask(task, task))) : [];
    return { version: 6, tasks };
}

function writeScheduleData(data) {
    ensureScheduleFile();
    fs.writeFileSync(SCHEDULE_PATH, JSON.stringify({
        version: 6,
        tasks: Array.isArray(data.tasks) ? data.tasks : []
    }, null, 2), 'utf8');
}

function sortTasksChronologically(tasks) {
    return (tasks || []).sort((a, b) => String(a.pid || '').localeCompare(String(b.pid || '')));
}

function ensureUniqueTaskPids(tasks) {
    const used = new Set();
    const normalized = (tasks || []).map((task) => {
        const basePid = normalizePid(task.pid, task, task);
        const baseNum = decodePidNumber(basePid) ?? Date.now();
        const pid = nextAvailablePid(baseNum, used);
        return { ...task, pid };
    });
    lastGeneratedPid = normalized.reduce((maxPid, task) => (String(task.pid) > String(maxPid) ? String(task.pid) : String(maxPid)), '');
    return normalized;
}

function loadScheduledTasks(referenceTime = new Date()) {
    const data = readScheduleData();
    scheduledTasks = sortTasksChronologically(
        ensureUniqueTaskPids(data.tasks.map((task) => ({ ...task, ...computeRuntimeState(task, referenceTime) })))
    );
    writeScheduleData({ version: 6, tasks: scheduledTasks });
    return scheduledTasks;
}

function saveScheduledTasks() {
    scheduledTasks = ensureUniqueTaskPids(scheduledTasks);
    writeScheduleData({ version: 6, tasks: sortTasksChronologically(scheduledTasks) });
}

function getScheduledTasks(referenceTime = new Date()) {
    return loadScheduledTasks(referenceTime);
}

function getStoredScheduledTasks() {
    return sortTasksChronologically(readScheduleData().tasks);
}

function getSchedulableTasks(referenceTime = new Date()) {
    return loadScheduledTasks(referenceTime).filter((task) => {
        const nextRun = parseTaskDate(task.next_run_time);
        return task.status !== 'disabled' && task.status !== 'expired' && nextRun && nextRun <= referenceTime;
    });
}

function createSchedule(taskInput) {
    loadScheduledTasks();
    const pid = generateTaskPid();
    const baseTask = normalizeTask({
        ...taskInput,
        pid,
        next_run_time: taskInput.next_run_time !== undefined ? taskInput.next_run_time : computeFutureOccurrence(taskInput, new Date())
    });
    const runtime = computeRuntimeState(baseTask);
    const task = { ...baseTask, ...runtime };
    scheduledTasks.push(task);
    saveScheduledTasks();
    return task;
}

function updateSchedule(pid, updates) {
    loadScheduledTasks();
    const index = scheduledTasks.findIndex((task) => String(task.pid) === String(pid));
    if (index === -1) throw new Error(`Task ${pid} not found.`);
    const existing = scheduledTasks[index];
    const nextRunSeed = updates.next_run_time !== undefined
        ? updates.next_run_time
        : computeFutureOccurrence({ ...existing, ...updates }, new Date());
    const baseTask = normalizeTask({
        ...existing,
        ...updates,
        pid,
        next_run_time: nextRunSeed
    }, existing);
    const runtime = computeRuntimeState(baseTask);
    const task = { ...baseTask, ...runtime };
    scheduledTasks[index] = task;
    saveScheduledTasks();
    return task;
}

function markTaskExecuted(pid, referenceTime = new Date()) {
    loadScheduledTasks(referenceTime);
    const index = scheduledTasks.findIndex((task) => String(task.pid) === String(pid));
    if (index === -1) throw new Error(`Task ${pid} not found.`);
    const existing = scheduledTasks[index];
    const stop = parseTaskDate(existing.stop);
    const next_run_time = computeFutureOccurrence(existing, referenceTime);
    const task = {
        ...existing,
        next_run_time,
        status: stop && referenceTime >= stop ? 'expired' : existing.status === 'disabled' ? 'disabled' : 'enabled'
    };
    scheduledTasks[index] = task;
    saveScheduledTasks();
    return task;
}

function deleteSchedule(pid) {
    loadScheduledTasks();
    const initialCount = scheduledTasks.length;
    scheduledTasks = scheduledTasks.filter((task) => String(task.pid) !== String(pid));
    if (scheduledTasks.length === initialCount) return `❌ Task ${pid} not found.`;
    saveScheduledTasks();
    return `✅ Deleted scheduled task ${pid}.`;
}

function clearAllSchedules() {
    scheduledTasks = [];
    saveScheduledTasks();
    return '✅ All scheduled tasks cleared.';
}

function scheduleTask(description, timeExpression, prompt, options = {}) {
    const raw = String(timeExpression || '').trim().toLowerCase();
    const range = raw.match(/^start\s+(\d{1,2}):(\d{2})\s+end\s+(\d{1,2}:\d{2})\s+step\s+(\d+\s*[mh])$/);
    if (!range) {
        return '❌ Unsupported format. Use `start HH:MM end HH:MM step Xm|Xh`.';
    }

    const today = formatDateTimeLocal(new Date()).slice(0, 10);
    const start = normalizeDateTime(`${today}T${range[1].padStart(2, '0')}:${range[2]}`);
    const stop = normalizeDateTime(`${today}T${range[3]}`);

    const task = createSchedule({
        start,
        stop,
        step_time: normalizeStepTime(range[4]),
        prompt: String(prompt || description || '').trim(),
        status: 'enabled',
        issuer_client: options.issuer_client,
        issuer_target: options.issuer_target
    });
    return `✅ Scheduled task ${task.pid} saved. Next run: ${task.next_run_time || 'not set'}`;
}

module.exports = {
    SCHEDULE_PATH,
    computeNextRunTime: computeRuntimeState,
    computeFutureOccurrence,
    loadScheduledTasks,
    saveScheduledTasks,
    getScheduledTasks,
    getStoredScheduledTasks,
    getSchedulableTasks,
    createSchedule,
    updateSchedule,
    markTaskExecuted,
    deleteSchedule,
    clearAllSchedules,
    scheduleTask
};

const fs = require('fs');
const { generateAIResponse } = require('./aiHandler');
const { getAvailableModelsList, getCurrentModelInfo, resetToDefaultModel, switchModelByNumber, switchImageModelByNumber } = require('./Models');
const { analyzeLocalMediaFile } = require('./aiTools');
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

async function handleCommand(cmdText) {
    const cmd = cmdText.trim().toLowerCase();
    
    if (cmd === '/help') {
        const reply = `🐾 *OB Commands:*\n` +
            `📖 */help* — This menu\n` +
            `📖 */get history* — Show chat history\n` +
            `🌀 */wipe* — Wipe history\n` +
            `🗑️ */wipe tmp* — Clear tmp files\n` +
            `📋 */list models* — All models\n` +
            `🎯 */current model* — Active model\n` +
            `🔀 */switch model #* — Switch chat model\n` +
            `🎨 */switch image model #* — Switch image model\n` +
            `♻️ */reset model* — Reset model\n` +
            `📋 */list schedule* — View schedules\n` +
            `🗑️ */delete schedule* — Clear all\n` +
            `🗑️ */delete task <pid>* — Delete specific\n` +
            `⏰ */schedule [start] [end] [step] [prompt]* — Add task\n` +
            `🛑 */stop* — Shut down`;
        console.log(`📤 [OB] \n${ensureBotPrefix(reply)}`);
        return true;
    }

    if (cmd === '/get history') {
        const historyText = await historyHandler.getHistory('onboard');
        console.log(`📤 [OB] \n${ensureBotPrefix(historyText || 'No history found.')}`);
        return true;
    }

    if (cmd === '/wipe') {
        historyHandler.clearHistory('onboard');
        console.log(`📤 [OB] ${ensureBotPrefix('🌀 *History wiped!*')}`);
        return true;
    }

    if (cmd === '/list models') {
         console.log(`📤 [OB] \n${ensureBotPrefix(getAvailableModelsList())}`);
         return true;
    }

    if (cmd === '/current model') {
         console.log(`📤 [OB] \n${ensureBotPrefix(getCurrentModelInfo())}`);
         return true;
    }

    if (cmd === '/reset model') {
         console.log(`📤 [OB] \n${ensureBotPrefix(resetToDefaultModel())}`);
         return true;
    }

    if (cmd.startsWith('/switch model ')) {
        const targetNum = parseInt(cmd.replace('/switch model ', ''));
        console.log(`📤 [OB] \n${ensureBotPrefix(switchModelByNumber(targetNum))}`);
        return true;
    }

    if (cmd.startsWith('/switch image model ')) {
        const targetNum = parseInt(cmd.replace('/switch image model ', ''));
        console.log(`📤 [OB] \n${ensureBotPrefix(switchImageModelByNumber(targetNum))}`);
        return true;
    }

    if (cmd.startsWith('/wipe tmp')) {
        const { wipeTmpDirectory } = require('./aiTools');
        const count = wipeTmpDirectory();
        console.log(`📤 [OB] ${ensureBotPrefix(`*Tmp Wipe complete!* Cleared ${count} files from \`../tmp\`.`)}`);
        return true;
    }

    if (cmd === '/list schedule') {
        const { getScheduledTasks } = require('./scheduleTool');
        const tasks = getScheduledTasks();
        if (!tasks || tasks.length === 0) {
            console.log(`📤 [OB] ${ensureBotPrefix('*No tasks scheduled.*')}`);
            return true;
        }
        let reply = "📋 *Scheduled Tasks:\n\n*";
        tasks.forEach(t => {
            reply += `*${t.pid}*\nStart: ${t.start}\nStop: ${t.stop}\nStep: ${t.step_time}\nStatus: ${formatScheduleStatus(t.status)}\nNext: ${t.next_run_time || '-'}\n\n`;
        });
        console.log(`📤 [OB] \n${ensureBotPrefix(reply)}`);
        return true;
    }

    if (cmd === '/delete schedule') {
        const { clearAllSchedules } = require('./scheduleTool');
        const reply = clearAllSchedules();
        console.log(`📤 [OB] ${ensureBotPrefix(reply)}`);
        return true;
    }

    if (cmd.startsWith('/delete task ')) {
        const pid = cmdText.trim().slice('/delete task '.length).trim();
        const { deleteSchedule } = require('./scheduleTool');
        const reply = deleteSchedule(pid);
        console.log(`📤 [OB] ${ensureBotPrefix(reply)}`);
        return true;
    }

    if (cmd.startsWith('/schedule ')) {
        const parts = cmdText.trim().split(' ');
        if (parts.length < 5) {
            console.log(`📤 [OB] ${ensureBotPrefix('*Format: /schedule [start] [end] [step] [prompt]*\nExample: \`/schedule 09:00 17:00 30m Check servers\`')}`);
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
            issuer_client: 'onboard',
            issuer_target: 'dashboard'
        });
        console.log(`📤 [OB] ${ensureBotPrefix(reply)}`);
        return true;
    }

    if (cmd === '/stop') {
        const { stopServer } = require('./serverTools');
        console.log(`📤 [OB] ${ensureBotPrefix('🛑 Shutting down server...')}`);
        stopServer();
        return true;
    }

    return false;
}

async function handleOnboardDashboardMessage(msg, whatsappClient = null) {
    const {
        text,
        image_path: imagePath,
        media_path: mediaPath,
        history_limit: historyLimit
    } = msg;
            const attachedMediaPath = mediaPath || imagePath || '';
            const promptParts = [];

            if (typeof text === 'string' && text.trim()) {
                promptParts.push(text.trim());
            }

            if (attachedMediaPath) {
                const mediaAnalysis = await analyzeLocalMediaFile(attachedMediaPath);
                promptParts.push(`[ATTACHED MEDIA PATH]\n${attachedMediaPath}`);
                promptParts.push(`[ATTACHED MEDIA ANALYSIS]\n${mediaAnalysis}`);
            }

            const prompt = promptParts.join('\n\n') || 'Please inspect the attached media and respond.';
            const injectedHistory = await historyHandler.getHistory('onboard', Number(historyLimit));

            const { appendBotLog } = require('./loggerTool');
            const inputText = typeof text === 'string' ? text.trim() : '';
            
            // Log incoming dashboard input
                const inputLine = `📩 [OB] Input: ${inputText || '(media/prompt)'}`;

            if (!inputText.startsWith('/')) {
                    appendBotLog(`👤 ${inputText || '(media/prompt)'}`);
            }
            console.log(inputLine);

            try {
                // Try to handle as a built-in command first
                if (typeof text === 'string' && text.trim() && await handleCommand(text)) return;

                // Generate Response using AI context for Dashboard Onboarding
                let response = await generateAIResponse(prompt, false, whatsappClient, injectedHistory, "onboard");
                response = String(response || '').trim();
                
                if (response && !response.startsWith('🐾')) {
                    response = '🐾 ' + response;
                }
                
                // Log outgoing dashboard output
                const replyLine = `📤 [OB] Reply: ${response}`;
                const { appendBotLog } = require('./loggerTool');
                appendBotLog(response);
                console.log(replyLine);
                historyHandler.appendHistory('onboard', null, 'user', typeof text === 'string' && text.trim() ? text : '(media only)');
                historyHandler.appendHistory('onboard', null, 'assistant', response);

                if (attachedMediaPath && fs.existsSync(attachedMediaPath)) {
                    try { fs.unlinkSync(attachedMediaPath); } catch (e) {}
                }

            } catch (e) {
                console.error(`❌ [OB] Error generating response:`, e.message);
                if (attachedMediaPath && fs.existsSync(attachedMediaPath)) {
                    try { fs.unlinkSync(attachedMediaPath); } catch (cleanupError) {}
                }
            }
}

function initializeOnboardClient(whatsappClient = null) {
    process.on('message', async (msg) => {
        if (msg.type === 'clear_onboard_history') {
            historyHandler.clearHistory('onboard');
            console.log('🧹 [OB] History cleared.');
            return;
        }

    });
}

module.exports = { initializeOnboardClient, handleOnboardDashboardMessage };

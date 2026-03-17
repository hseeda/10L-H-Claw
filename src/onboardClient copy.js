const fs = require('fs');
const { generateAIResponse } = require('./aiHandler');
const { getAvailableModelsList, getCurrentModelInfo, resetToDefaultModel, switchModelByNumber, switchImageModelByNumber } = require('./Models');
const { analyzeLocalMediaFile } = require('./aiTools');
const { getWhatsAppStatus } = require('./whatsappClient');
const historyHandler = require('./historyHandler');

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
            `🛑 */stop* — Shut down`;
        console.log(`📤 [OB] \n${reply}`);
        return true;
    }

    if (cmd === '/get history') {
        const historyText = await historyHandler.getHistory('onboard');
        console.log(`📤 [OB] \n${historyText || '🐾 No history found.'}`);
        return true;
    }

    if (cmd === '/wipe') {
        historyHandler.clearHistory('onboard');
        console.log(`📤 [OB] 🌀 *History wiped!*`);
        return true;
    }

    if (cmd === '/list models') {
         console.log(`📤 [OB] \n${getAvailableModelsList()}`);
         return true;
    }

    if (cmd === '/current model') {
         console.log(`📤 [OB] \n${getCurrentModelInfo()}`);
         return true;
    }

    if (cmd === '/reset model') {
         console.log(`📤 [OB] \n${resetToDefaultModel()}`);
         return true;
    }

    if (cmd.startsWith('/switch model ')) {
        const targetNum = parseInt(cmd.replace('/switch model ', ''));
        console.log(`📤 [OB] \n${switchModelByNumber(targetNum)}`);
        return true;
    }

    if (cmd.startsWith('/switch image model ')) {
        const targetNum = parseInt(cmd.replace('/switch image model ', ''));
        console.log(`📤 [OB] \n${switchImageModelByNumber(targetNum)}`);
        return true;
    }

    if (cmd.startsWith('/wipe tmp')) {
        const { wipeTmpDirectory } = require('./aiTools');
        const count = wipeTmpDirectory();
        console.log(`📤 [OB] 🐾 *Tmp Wipe complete!* Cleared ${count} files from \`../tmp\`.`);
        return true;
    }

    if (cmd === '/stop') {
        const { stopServer } = require('./serverTools');
        console.log(`📤 [OB] 🛑 Shutting down server...`);
        stopServer();
        return true;
    }

    return false;
}

async function handleOnboardDashboardMessage(msg, whatsappClient = null) {
    const { text, image_path: imagePath, history_limit: historyLimit } = msg;
            const promptParts = [];
            promptParts.push(`[RUNTIME STATUS]\n${getWhatsAppStatus()}`);

            if (typeof text === 'string' && text.trim()) {
                promptParts.push(text.trim());
            }

            if (imagePath) {
                const mediaAnalysis = await analyzeLocalMediaFile(imagePath);
                promptParts.push(`[ATTACHED IMAGE PATH]\n${imagePath}`);
                promptParts.push(`[ATTACHED IMAGE ANALYSIS]\n${mediaAnalysis}`);
            }

            const prompt = promptParts.join('\n\n') || 'Please inspect the attached image and respond.';
            const injectedHistory = await historyHandler.getHistory('onboard', Number(historyLimit));

            const { appendBotLog } = require('./loggerTool');
            const inputText = typeof text === 'string' ? text.trim() : '';
            
            // Log incoming dashboard input
            const inputLine = `📩 [OB] Input: ${inputText || '(image/prompt)'}`;

            if (!inputText.startsWith('/')) {
                appendBotLog(`👤 ${inputText || '(image/prompt)'}`);
            }
            console.log(inputLine);

            try {
                // Try to handle as a built-in command first
                if (typeof text === 'string' && text.trim() && await handleCommand(text)) return;

                // Generate Response using AI context for Dashboard Onboarding
                let response = await generateAIResponse(prompt, false, whatsappClient, injectedHistory, "onboard");
                
                if (response && !response.startsWith('🐾')) {
                    response = '🐾 ' + response;
                }
                
                // Log outgoing dashboard output
                const replyLine = `📤 [OB] Reply: ${response}`;
                const { appendBotLog } = require('./loggerTool');
                appendBotLog(response);
                console.log(replyLine);
                historyHandler.appendHistory('onboard', null, 'user', typeof text === 'string' && text.trim() ? text : '(image only)');
                historyHandler.appendHistory('onboard', null, 'assistant', response);

                if (imagePath && fs.existsSync(imagePath)) {
                    try { fs.unlinkSync(imagePath); } catch (e) {}
                }

            } catch (e) {
                console.error(`❌ [OB] Error generating response:`, e.message);
                if (imagePath && fs.existsSync(imagePath)) {
                    try { fs.unlinkSync(imagePath); } catch (cleanupError) {}
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

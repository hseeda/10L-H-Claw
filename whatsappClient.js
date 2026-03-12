const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { generateAIResponse } = require('./aiHandler');
const { getActiveModel, getAvailableModels, getCurrentModelInfo, getAvailableModelsList, resetToDefaultModel, switchModelByNumber, printModelVariables } = require('./Models');

let client = null;

function getWhatsappClient() {
    return client;
}

async function logMessageFormatted(msg) {
    const isIncoming = !msg.id.fromMe;
    const direction = isIncoming ? "📩 INCOMING" : "📤 OUTGOING";
    const dateStr = new Date(msg.timestamp * 1000).toLocaleString();
    
    let fromName = msg.from;
    let toName = msg.to;

    try {
        if (msg.from) {
            const fromContact = await client.getContactById(msg.from);
            fromName = fromContact?.name || fromContact?.pushname || fromContact?.shortName || fromContact?.number || msg.from;
        }
        if (msg.to) {
            const toContact = await client.getContactById(msg.to);
            toName = toContact?.name || toContact?.pushname || toContact?.shortName || toContact?.number || msg.to;
        }
    } catch (err) {}

    // Simple heuristic for group/self
    const isGroup = msg.from.includes('@g.us') || msg.to.includes('@g.us');
    const isSelf = msg.to === msg.from;
    
    let bodyText = msg.body || '';
    // Multi-line bodies
    bodyText = bodyText.replace(/\n/g, '\n│          ');

    const output = `\n┌─ ${direction} ──────────────────────────────
│ From:    ${fromName === msg.from ? msg.from : `${fromName} (${msg.from})`}
│ To:      ${toName === msg.to ? msg.to : `${toName} (${msg.to})`}
│ Time:    ${dateStr}
│ Type:    ${msg.type}
│ FromMe:  ${msg.id.fromMe}  |  Group: ${isGroup}  |  Self: ${isSelf}
│ Body:    ${bodyText}
└──────────────────────────────────────────`;
    console.log(output);
}

async function cleanUpMessages(msg) {
    try {
        const chat = await msg.getChat();
        const messages = await chat.fetchMessages({ limit: 1000 });
        const oneDayAgo = (Date.now() / 1000) - (24 * 60 * 60);
        
        let deletedCount = 0;
        for (const m of messages) {
            if (m.timestamp >= oneDayAgo) {
                try {
                    try {
                        await m.delete(true); 
                    } catch (err) {
                        await m.delete(false);
                    }
                    deletedCount++;
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (err) {
                    console.error(`Failed to delete message ${m.id?.id || m.id}:`, err.message);
                }
            }
        }
        await client.sendMessage(msg.to, `ℹ️ Cleanup complete! Deleted ${deletedCount} messages from the past 24 hours.`);
        console.log(`ℹ️ Cleanup complete! Deleted ${deletedCount} messages from the past 24 hours.`);
    } catch (error) {
        console.error('Error during cleanup:', error);
        await client.sendMessage(msg.to, 'ℹ️ Oops, an error occurred during cleanup.');
        console.log('ℹ️ Oops, an error occurred during cleanup.');
    }
    return;
}

async function listContacts(msg) {
    try {
        let query = msg.body.trim().toLowerCase().replace('/list contacts ', '').replace('/list contacts', '').trim();
        // Remove surrounding quotes if any
        if (query.startsWith('"') && query.endsWith('"')) query = query.slice(1, -1).trim();

        const contacts = await client.getContacts();
        
        let filtered = contacts.filter(c => c && c.id && (c.isMyContact || c.isGroup));
        if (query) {
            filtered = filtered.filter(c => {
                const name = (c.name || '').toLowerCase();
                const pushname = (c.pushname || '').toLowerCase();
                const userId = (c.id && c.id.user ? c.id.user : '');
                return name.includes(query) || pushname.includes(query) || userId.includes(query);
            });
        }

        // Limit results to avoid massive messages
        const limit = 20;
        const results = filtered.slice(0, limit);
        
        if (results.length === 0) {
            await client.sendMessage(msg.to, `ℹ️ No contacts found matching "${query}".`);
            return;
        }

        let reply = `ℹ️ *WhatsApp Contacts${query ? ` matching "${query}"` : ''}:*\n\n`;
        results.forEach((c, idx) => {
            const type = c.isGroup ? '👥' : '👤';
            const name = c.name || c.pushname || 'Unknown';
            reply += `${idx + 1}. ${type} *${name}* (${c.id.user})\n`;
        });

        if (filtered.length > limit) {
            reply += `\n...and ${filtered.length - limit} more.`;
        }

        await client.sendMessage(msg.to, reply);
    } catch (error) {
        console.error('Error listing contacts:', error);
        await client.sendMessage(msg.to, `❌ Failed to list contacts: ${error.message}`);
    }
}

async function listCommands(msg) {
    const reply = `🐾 *Built-in Commands:*\n\n` +
        `• \`/help\` - Show this help menu\n` +
        `• \`/wipe\` - Delete all bot messages from the past 24 hours\n` +
        `• \`/wipe tmp\` - Delete all files in the ./tmp directory\n` +
        `• \`/list models\` - List all available AI models\n` +
        `• \`/current model\` - Show the currently active AI model\n` +
        `• \`/switch model <number>\` - Switch the active AI model\n` +
        `• \`/reset model\` - Reset to the default model\n` +
        `• \`/list contacts [query]\` - List/Search your WhatsApp contacts\n` +
        `• \`/print\` - Print current internal model variables to console\n` +
        `• \`/stop\` - Safely shut down the H-Claw server`;
    await client.sendMessage(msg.to, reply);
}

async function builtInCommands(msg) {
    const cmd = msg.body.trim().toLowerCase();
    if (cmd === '/help' || cmd === '/list commands') {
        await listCommands(msg);
        return true;
    }

    if (msg.body.trim().toLowerCase() === '/wipe') {
        await cleanUpMessages(msg);
        return true;
    }

    if (cmd === '/list models') {
        const reply = getAvailableModelsList();
        await client.sendMessage(msg.to, reply);
        return true;
    }

    if (cmd === '/current model') {
        const reply = getCurrentModelInfo();
        await client.sendMessage(msg.to, reply);
        return true;
    }

    if (cmd === '/reset model') {
        const reply = resetToDefaultModel();
        await client.sendMessage(msg.to, reply);
        return true;
    }

    if (cmd.startsWith('/switch model ')) {
        const targetNum = parseInt(msg.body.trim().toLowerCase().replace('/switch model ', ''));
        const reply = switchModelByNumber(targetNum);
        await client.sendMessage(msg.to, reply);
        return true;
    }

    if (cmd.startsWith('/list contacts')) {
        await listContacts(msg);
        return true;
    }

    if (cmd.startsWith('/print')) {
        printModelVariables();
        return true;
    }

    if(msg.body.trim().toLowerCase().startsWith('/wipe tmp')) {
        const { wipeTmpDirectory } = require('./aiTools');
        const count = wipeTmpDirectory();
        await msg.reply(`🐾 *Tmp Wipe complete!* Cleared ${count} files from \`./tmp\`.`);
        return true;
    }

    if(cmd.startsWith('/stop')) {
        const { stopServer } = require('./serverTools');
        stopServer();
        return true;
    }
    return false;
}

function initializeWhatsAppClient() {
    client = null;

    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            args: ['--no-sandbox']
        }
    });

    client.on('qr', (qr) => {
        // Generate and scan this code with your phone
        console.log('QR RECEIVED. Scan the code below:');
        qrcode.generate(qr, {small: true});
    });

    client.on('ready', async () => {
        console.log('✅ WhatsApp Client is ready! 🚀');
        try {
            const selfChatId = client.info.wid._serialized;
            await client.sendMessage(selfChatId, '🐾 *H-Claw started!* ✨');

            // Telegram Notification
            if (process.env.TELEGRAM_CHAT_ID) {
                try {
                    const { getTelegramClient } = require('./telegramClient');
                    const tg = getTelegramClient();
                    if (tg) {
                        await tg.sendTelegramMessage(process.env.TELEGRAM_CHAT_ID, '🐾 *H-Claw started!* ✨');
                    }
                } catch (tErr) {
                    console.error('Failed to send Telegram start message:', tErr.message);
                }
            }
        } catch (err) {
            console.error('Failed to send startup message:', err);
        }
    });

    // WhatsApp Client authenticated successfully.
    client.on('authenticated', () => {
        console.log('🔐 WhatsApp Client authenticated successfully.');
    });

    client.on('auth_failure', msg => {
        console.error('🔐 WhatsApp Client authentication failure:', msg);
    });

    // Listen to all created messages (incoming AND outgoing)
    client.on('message_create', async (msg) => {
        await logMessageFormatted(msg);

        // Don't reply to broadcast messages
        if (msg.from === 'status@broadcast') return;

        const isSelf = msg.to === msg.from;

        // BOT POLICY: Never send info messages or replies to any one but the user.
        // We only process messages in the self-chat ("Note to Self").
        if (!isSelf) return;

        // If it's a message from bot to user, we don't want the bot to reply
        // to its own replies and cause an infinite loop. 
        if (msg.body.startsWith('🐾')) return;
        if (msg.body.startsWith('ℹ️')) return;
        if (msg.body.startsWith('❌')) return;
        if (msg.body.startsWith('🔄')) return;

        if (isSelf && await builtInCommands(msg)) return;
        let model = getActiveModel();
        try {
            const chat = await msg.getChat();
            // Fetch last 11 messages (10 history + current message)
            const recentMessages = await chat.fetchMessages({ limit: 11 }); 
            const historyStrings = [];
            for (const m of recentMessages) {
                if (m.id._serialized === msg.id._serialized) continue; 
                
                // Identify bot messages
                const isBot = m.body.startsWith('🐾') || m.body.startsWith('ℹ️') || m.body.startsWith('❌');
                const prefix = isBot ? "H-Claw" : "User";
                historyStrings.push(`[${new Date(m.timestamp * 1000).toLocaleString()}] ${prefix}: ${m.body}`);
            }
            const chatHistory = historyStrings.join('\n');

            // Only take commands/replies if isSelf is true (already filtered above)
            let prompt = msg.body;
            if (msg.hasMedia) {
                prompt += `\n\n[MEDIA ATTACHED: Use whatsapp_read_media with message_id: "${msg.id._serialized}" to understand/read this media (audio, image, document, etc.)]`;
            }
            const aiReply = await generateAIResponse(prompt, isSelf, client, chatHistory, 'whatsapp');
            
            // AI responses already start with 🐾 in the handler or we add it here
            let finalReply = aiReply;
            if (!finalReply.startsWith('🐾')) {
                finalReply = '🐾 ' + finalReply;
            }
            await msg.reply(finalReply);
        } catch (error) {
            console.error('Error handling message:', error);
            await msg.reply("🐾 Oops, I encountered an internal error.");
        }
    });

    client.initialize();
    return client;
}

module.exports = { 
    initializeWhatsAppClient,
    getWhatsappClient
};

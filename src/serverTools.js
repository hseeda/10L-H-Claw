let isShuttingDown = false;

async function stopServer() {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log('\n🛑 Shutting down H-Claw...');

    // 2. Telegram Notification (Independent)
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
        try {
            const { getTelegramClient, isTelegramActive } = require('./telegramClient');
            if (isTelegramActive()) {
                const tg = getTelegramClient();
                if (tg) {
                    await tg.sendTelegramMessage(process.env.TELEGRAM_CHAT_ID, '🐾 *H-Claw stopped!* 🛑');
                }
            }
        } catch (tErr) {
            console.error('Failed to send Telegram stop message:', tErr.message);
        }
    }

    // 1. WhatsApp Notification
    const { getWhatsappClient } = require('./whatsappClient');
    const client = getWhatsappClient();
    try {
        if (client && client.info && client.info.wid) {
            const selfChatId = client.info.wid._serialized;
            await client.sendMessage(selfChatId, '🐾 *H-Claw stopped!* 🛑');
        }
    } catch (err) {
        console.error('Failed to send WhatsApp stop message:', err.message);
    }

    // Wait briefly to ensure messages are dispatched
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
        if (client) await client.destroy();
    } catch (err) {
        console.error('Error destroying WhatsApp client:', err.message);
    }
    
    process.exit(0);
}

module.exports = {
    stopServer
};

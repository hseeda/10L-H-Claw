require('dotenv').config({ path: require('path').join(__dirname, 'secrets', '.env') });
const fs = require('fs');
const path = require('path');
const { initializeWhatsAppClient } = require('./src/whatsappClient');
const { initializeTelegramClient } = require('./src/telegramClient');

console.log(`🐾 WhatsApp AI Assistant initializing 🐾`);



const whatsappClient = initializeWhatsAppClient();
initializeTelegramClient(whatsappClient);

// Handle graceful shutdown globally
process.on('SIGINT', async () => {
    const { stopServer } = require('./src/serverTools');
    await stopServer();
});

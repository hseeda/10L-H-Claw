require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { initializeWhatsAppClient } = require('./whatsappClient');
const { initializeTelegramClient } = require('./telegramClient');

console.log(`🐾 WhatsApp AI Assistant initializing 🐾`);



const whatsappClient = initializeWhatsAppClient();
initializeTelegramClient(whatsappClient);

// Handle graceful shutdown globally
process.on('SIGINT', async () => {
    const { stopServer } = require('./serverTools');
    await stopServer();
});

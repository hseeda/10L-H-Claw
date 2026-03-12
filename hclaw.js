const path = require('path');
const fs = require('fs');

const envPath = path.join(__dirname, 'secrets', '.env');
if (!fs.existsSync(envPath)) {
    console.error('\n╔══════════════════════════════════════════════════════╗');
    console.error('║  ❌  .env file not found!                            ║');
    console.error('╠══════════════════════════════════════════════════════╣');
    console.error('║                                                      ║');
    console.error(`║  Expected path:                                      ║`);
    console.error(`║    ${envPath.padEnd(50)}║`);
    console.error('║                                                      ║');
    console.error('║  To fix this:                                        ║');
    console.error('║    1. Copy .env.example to secrets/.env              ║');
    console.error('║    2. Fill in your API keys and tokens               ║');
    console.error('║    3. Restart the application                        ║');
    console.error('║                                                      ║');
    console.error('║  Required (at least one):                            ║');
    console.error('║    - OPENAI_API_KEY                                  ║');
    console.error('║    - GEMINI_API_KEY                                  ║');
    console.error('║                                                      ║');
    console.error('║  Optional:                                           ║');
    console.error('║    - TELEGRAM_BOT_TOKEN                              ║');
    console.error('║                                                      ║');
    console.error('╚══════════════════════════════════════════════════════╝\n');
    process.exit(1);
}

require('dotenv').config({ path: envPath, quiet: true });
const { initializeWhatsAppClient } = require('./src/whatsappClient');
const { initializeTelegramClient } = require('./src/telegramClient');

console.log(`🐾 WhatsApp AI Assistant initializing 🐾`);

// --- Startup warnings for missing API keys ---
if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY.toUpperCase().includes('YOUR_')) {
    console.warn('⚠️  GEMINI_API_KEY is not set. Gemini models will not be available.');
} else {
    console.log('💎 Gemini API key loaded.');
}
if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.toUpperCase().includes('YOUR_')) {
    console.warn('⚠️  OPENAI_API_KEY is not set. OpenAI models will not be available.');
} else {
    console.log('🤖 OpenAI API key loaded.');
}



const whatsappClient = initializeWhatsAppClient();
initializeTelegramClient(whatsappClient);

// Handle graceful shutdown globally
process.on('SIGINT', async () => {
    const { stopServer } = require('./src/serverTools');
    await stopServer();
});
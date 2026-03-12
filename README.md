<p align="center">
  <img src="assets/logo.png" width="150" alt="H-Claw Logo">
</p>

# 🐾 H-Claw: The WhatsApp AI Power-Suite

![H-Claw Banner](assets/banner.png)

**H-Claw** is a premium, personal AI assistant that lives inside your WhatsApp. Built with a "Note to Self" philosophy, it serves as a powerful bridge between your messaging app and cutting-edge AI models, persistent memory, and local system tools.

## 🏗️ Project Structure

```text
├── hclaw.js                # Main application entry point
├── src/                    # Source code directory
│   ├── Models.js           # AI Model configuration
│   ├── aiHandler.js        # AI message processing logic
│   ├── aiTools.js          # Tool definitions for AI
│   ├── mailTools.js        # Email management
│   ├── serverTools.js      # Server utility tools
│   ├── telegramClient.js   # Telegram bot integration
│   └── whatsappClient.js   # WhatsApp bot integration
├── secrets/                # Configuration and secret files
│   ├── .env                # Environment variables
│   └── mail_accounts.json  # Email account configurations
├── MD/                     # AI Context files (Soul, Tools, Memory)
├── assets/                 # Static assets
└── tmp/                    # Temporary files
```

---

## ✨ Key Features

- **🧠 Multi-Model Intelligence**: Seamlessly switch between **Google Gemini** and **OpenAI GPT** models using simple slash commands.
- **📔 Persistent Memory**: A dedicated long-term memory system (`MEMORY.md`) allowing the AI to recall facts, relationships, and shared media across conversations.
- **🛠️ Extensible Toolset**:
  - **System Access**: Run Bash and PowerShell commands directly from WhatsApp.
  - **Email Management**: Full MAPI/SMTP/IMAP access to send, receive, list, and organize emails across multiple accounts (Gmail, Outlook, Private etc.).
  - **Social Integration**: Telegram client for sending/receiving messages and orchestrating notifications.
  - **Media Generation**: Create DALL-E 3 images and TTS audio on the fly.
  - **Media Analysis**: Advanced Vision and Whisper transcription for images, audio, and documents.
- **🔒 Privacy First**: Strict bot-policy enforcement; H-Claw only responds in self-chats and never initiates external messages unless explicitly instructed.
- **📦 Dynamic Tool Discovery**: Ability for bots to discover and save new tools/scripts to `TOOLS.md` for future use.

---

## 🚀 Installation & Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (v16+)
- A WhatsApp account for the bot
- API Keys for Google Gemini and OpenAI
- (Optional) Telegram Bot Token & Chat ID for notifications

### 1. Clone & Install

```bash
git clone https://github.com/hseeda/10L-H-Claw.git
cd 10L-H-Claw
npm install
```

### 2. Configure Environment

H-Claw uses template files for configuration. Copy the example files and fill in your credentials.

#### API Keys & General Settings

Copy `.env.example` to `.env` and fill in your API keys:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# AI API Keys
GEMINI_API_KEY=your_gemini_key
OPENAI_API_KEY=your_openai_key

# Fallback Order (Provider:Model)
AI_FALLBACK_ORDER=gemini:gemini-3-flash-preview,gemini:gemini-3.1-pro-preview,chatgpt:gpt-4o

# Telegram (Optional)
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

#### Email Configuration (Optional)

You can configure email accounts manually or **directly through conversation** with the bot:

- **Manual**: Copy `mail_accounts.json.example` to `mail_accounts.json` and edit.
- **Bot-Assisted**: Simply tell the bot: *"H-Claw, I want to add my Gmail account. Use these settings: [host, port, user, pass...]"*. The bot will use its file system tools to update your `mail_accounts.json` automatically.

> [!WARNING]
> Never commit your `.env` or `mail_accounts.json` files. They are included in `.gitignore` by default.

### 3. Running H-Claw

```bash
node hclaw.js
```

---

## 📱 Communication Setup

### 🟢 WhatsApp (Mandatory)

H-Claw uses `whatsapp-web.js` to mirror your account.

1. Run `node hclaw.js`.
2. A **QR Code** will appear in your terminal.
3. Open WhatsApp on your phone → **Linked Devices** → **Link a Device**.
4. Scan the terminal QR code. The bot is now live!

### 🔵 Telegram (Optional)

Used for secondary notifications and remote orchestration.

1. Message [@BotFather](https://t.me/botfather) to create a bot and get your **Token**.
2. Message [@userinfobot](https://t.me/userinfobot) to get your **Chat ID**.
3. Add these to your `.env` file.

---

## 🚀 Dynamic Expansion (Core Capability)

H-Claw's greatest power is its ability to **evolve**. Because it has direct access to Bash and PowerShell, it can create, test, and save new tools during a conversation.

### How it Works

1. **Request**: Ask for a new capability (e.g., "Add a tool to check my system's disk space and alert me if it's low").
2. **Creation**: The bot writes a script, validates it via the shell, and uses `tool_save` to add the recipe to `MD/TOOLS.md`.
3. **Persistence**: The bot now "knows" this tool and can use it in future sessions.

### Example: Adding a System Monitor
>
> **User**: *"H-Claw, add a tool that uses PowerShell to check my local weather using 'wttr.in'."*
>
> **H-Claw**: *"I've successfully created and saved a new weather tool using `curl wttr.in?format=3`. You can now ask me for the weather anytime!"*

---

## 🛠️ Bot Tool Classification

### 1. Built-in Commands (Slash Commands)

These are direct instructions you send to the bot. They are processed locally and do not require AI inference.

| Command | Description |
| :--- | :--- |
| `/help` | Show the help menu with all available commands |
| `/list commands` | Alias for `/help` |
| `/wipe` | Delete all bot messages from the past 24 hours |
| `/wipe tmp` | Delete all files in the `./tmp` directory |
| `/list models` | Show all available AI models |
| `/current model` | Display the model currently in use |
| `/switch model <n>` | Switch the active AI model by its index |
| `/reset model` | Reset to the default AI model |
| `/list contacts [query]` | Search and list your WhatsApp contacts |
| `/print` | Debug: Print internal model variables to console |
| `/stop` | Gracefully shut down the server |

### 2. Built-in AI Tools (Hardcoded Capabilities)

These are specialized functions the AI can "choose" to use based on your request. They are defined in `aiTools.js`.

- **Shell Tools**: `execute_bash`, `execute_powershell` (Execute system commands).
- **Memory Tools**: `memory_list`, `memory_add`, `memory_add_media`, `memory_remove`, `memory_edit`, `memory_clear`.
- **File System**: `file_read`, `file_write`, `file_append`, `file_list`.
- **Email**: `mail_send_email`, `mail_list_messages`, `mail_get_message`, etc.
- **WhatsApp Media**: `generate_image` (DALL-E), `generate_audio` (TTS), `whatsapp_read_media` (Vision/Whisper).
- **Telegram**: `telegram_send`, `telegram_list_recent`, `telegram_read_media`.
- **System**: `tool_save` (Saves "Learned Tools" to `TOOLS.md`).

### 3. Learned Tools (Dynamic Recipes)

These are "recipes" or complex workflows stored in `MD/TOOLS.md`. The AI consults this file to learn how to perform non-native tasks.

- **OS Rules**: Context on when to use PowerShell vs Bash.
- **YouTube Access**: Using `yt-dlp` to download audio or fetch video metadata directly from a URL.
- **Web Reader**: How to use `lynx` or `links` to scrape websites.
- **PC Alerts**: Commands for native OS notifications (e.g., `BurntToast` for Windows).
- **Crypto Tracking**: Scripts to fetch real-time prices from public APIs like CoinGecko.
- **Custom Workflows**: Any routine the AI has been taught to automate.

---

## 📐 Architecture

H-Claw acts as an intelligent middleware, orchestrating requests between the `whatsapp-web.js` client and various AI provider APIs. It manages context via local Markdown files, ensuring your AI "knows" you better the more you use it.

---

<p align="center">
  <i>"Connecting your digital life through the paw of an AI."</i>
</p>

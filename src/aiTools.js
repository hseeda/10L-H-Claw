const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { MessageMedia } = require("whatsapp-web.js");
const OpenAI = require("openai");
const { GoogleGenAI } = require("@google/genai");
const mailManager = require("./mailTools");
// telegramManager is lazy-loaded in executeTool to avoid circular dependency with aiHandler

// Local Instances for internal AI perception/generation
let internalOpenAI = null;
let geminiToolClient = null;
let fileManager = null;

try {
  if (process.env.OPENAI_API_KEY) {
    internalOpenAI = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } else {
    console.warn("⚠️  OPENAI_API_KEY not found in environment.");
  }
  
  if (process.env.GEMINI_API_KEY) {
    geminiToolClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    fileManager = geminiToolClient.files;
  } else {
    console.warn("⚠️  GEMINI_API_KEY not found in environment.");
  }
} catch (e) {
  console.error("❌ Error initializing AI clients in aiTools.js:", e.message);
}

const memoryPath = path.join(__dirname, "MD", "MEMORY.md");
const toolsPath = path.join(__dirname, "MD", "TOOLS.md");
const tmpDir = path.join(__dirname, "tmp");

// Ensure directories exist
[tmpDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

function readMemoryLines() {
  if (!fs.existsSync(memoryPath)) return [];
  const text = fs.readFileSync(memoryPath, "utf8");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "MEMORY");
}

function writeMemoryLines(lines) {
  fs.writeFileSync(memoryPath, "MEMORY\n" + lines.join("\n") + "\n", "utf8");
}

function wipeTmpDirectory() {
  if (!fs.existsSync(tmpDir)) return 0;
  const files = fs.readdirSync(tmpDir);
  let count = 0;
  for (const file of files) {
    try {
      const fullPath = path.join(tmpDir, file);
      if (fs.lstatSync(fullPath).isFile()) {
        fs.unlinkSync(fullPath);
        count++;
      }
    } catch (e) {
      console.error(`Failed to delete ${file}:`, e.message);
    }
  }
  return count;
}

// ─── Tool Schemas ──────────────────────────────────────────────────────────────

const customToolsSchema = [
  // --- SHELL TOOLS ---
  {
    name: "execute_bash",
    description: "Run bash/sh command and get output.",
    parameters: {
      type: "OBJECT",
      properties: {
        command: {
          type: "STRING",
          description: "Command to run.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "execute_powershell",
    description: "Run PowerShell (pwsh) command and get output.",
    parameters: {
      type: "OBJECT",
      properties: {
        command: {
          type: "STRING",
          description: "Command to run.",
        },
      },
      required: ["command"],
    },
  },
  // --- MEMORY TOOLS ---
  {
    name: "memory_list",
    description: "List saved memory facts.",
  },
  {
    name: "memory_add",
    description: "Add a raw fact to memory.",
    parameters: {
      type: "OBJECT",
      properties: {
        fact: { type: "STRING", description: "Concise fact." },
      },
      required: ["fact"],
    },
  },
  {
    name: "memory_add_media",
    description: "Save a visual/audio entry in memory.",
    parameters: {
      type: "OBJECT",
      properties: {
        file_path: {
          type: "STRING",
          description: "Absolute file path.",
        },
        description: {
          type: "STRING",
          description: "What this media represents.",
        },
      },
      required: ["file_path", "description"],
    },
  },
  {
    name: "memory_remove",
    description: "Remove fact by 1-based index.",
    parameters: {
      type: "OBJECT",
      properties: {
        index: {
          type: "INTEGER",
          description: "1-based index.",
        },
      },
      required: ["index"],
    },
  },
  {
    name: "memory_edit",
    description: "Edit fact by 1-based index.",
    parameters: {
      type: "OBJECT",
      properties: {
        index: { type: "INTEGER", description: "1-based index." },
        new_fact: { type: "STRING", description: "Updated fact." },
      },
      required: ["index", "new_fact"],
    },
  },
  {
    name: "memory_clear",
    description: "Clear all memory facts.",
  },
  // --- FILE SYSTEM TOOLS ---
  {
    name: "file_read",
    description: "Read text file.",
    parameters: {
      type: "OBJECT",
      properties: {
        file_path: { type: "STRING", description: "Absolute path." },
      },
      required: ["file_path"],
    },
  },
  {
    name: "file_write",
    description: "Write/overwrite file.",
    parameters: {
      type: "OBJECT",
      properties: {
        file_path: { type: "STRING", description: "Absolute path." },
        content: { type: "STRING", description: "Text content." },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "file_append",
    description: "Append text to file.",
    parameters: {
      type: "OBJECT",
      properties: {
        file_path: { type: "STRING", description: "Absolute path." },
        content: { type: "STRING", description: "Text to append." },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "file_list",
    description: "List directory contents.",
    parameters: {
      type: "OBJECT",
      properties: {
        dir_path: { type: "STRING", description: "Absolute path." },
      },
      required: ["dir_path"],
    },
  },
  // --- SYSTEM TOOLS ---
  {
    name: "tool_save",
    description: "Save new tool/workflow to ./MD/TOOLS.md.",
    parameters: {
      type: "OBJECT",
      properties: {
        tool_content: { type: "STRING", description: "Documentation or script." },
      },
      required: ["tool_content"],
    },
  },
  // --- WHATSAPP TEXT TOOLS ---
  {
    name: "whatsapp_send",
    description: "Send WhatsApp text.",
    parameters: {
      type: "OBJECT",
      properties: {
        target_id: { type: "STRING", description: "Phone number (000...)." },
        message: { type: "STRING", description: "Text message." },
      },
      required: ["target_id", "message"],
    },
  },
  {
    name: "whatsapp_list_recent",
    description: "Get recent WhatsApp history.",
    parameters: {
      type: "OBJECT",
      properties: {
        target_id: { type: "STRING", description: "Phone number." },
        limit: { type: "INTEGER", description: "Max count (default 10)." },
      },
      required: ["target_id"],
    },
  },
  {
    name: "whatsapp_list_contacts",
    description: "List/Search WhatsApp contacts.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "Search term." },
      },
    },
  },
  {
    name: "whatsapp_reply",
    description: "Reply to specific message ID.",
    parameters: {
      type: "OBJECT",
      properties: {
        message_id: { type: "STRING", description: "ID to reply to." },
        message: { type: "STRING", description: "Reply text." },
      },
      required: ["message_id", "message"],
    },
  },
  // --- WHATSAPP MEDIA TOOLS ---
  {
    name: "generate_image",
    description: "Generate image with DALL-E 3 (requires visual prompt).",
    parameters: {
      type: "OBJECT",
      properties: {
        prompt: { type: "STRING", description: "Visual prompt." },
        save_as_fact: { type: "BOOLEAN", description: "Save as memory fact." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "generate_audio",
    description: "Convert text to audio (TTS-1).",
    parameters: {
      type: "OBJECT",
      properties: {
        text: { type: "STRING", description: "Text to speak." },
        voice: { type: "STRING", description: "Voice: alloy, echo, fable, onyx, nova, shimmer." },
      },
      required: ["text", "voice"],
    },
  },
  {
    name: "whatsapp_send_media",
    description: "Send file/media to WhatsApp.",
    parameters: {
      type: "OBJECT",
      properties: {
        target_id: { type: "STRING", description: "Phone number." },
        file_path: { type: "STRING", description: "Absolute path." },
        caption: { type: "STRING", description: "Optional caption." },
      },
      required: ["target_id", "file_path"],
    },
  },
  {
    name: "whatsapp_read_media",
    description: "Understand/transcribe WhatsApp media via AI.",
    parameters: {
      type: "OBJECT",
      properties: {
        message_id: { type: "STRING", description: "Message ID." },
      },
      required: ["message_id"],
    },
  },
  {
    name: "whatsapp_download_media",
    description: "Download WhatsApp media to tmp.",
    parameters: {
      type: "OBJECT",
      properties: {
        message_id: { type: "STRING", description: "Message ID." },
        filename: { type: "STRING", description: "Optional filename." },
      },
      required: ["message_id"],
    },
  },
  // --- MAIL TOOLS ---
  {
    name: "mail_add_account",
    description: "Add SMTP/IMAP account.",
    parameters: {
      type: "OBJECT",
      properties: {
        name: { type: "STRING", description: "Account name." },
        host: { type: "STRING", description: "Server host." },
        port: { type: "INTEGER", description: "Port." },
        secure: { type: "BOOLEAN", description: "Use SSL/TLS." },
        user: { type: "STRING", description: "Username/Email." },
        pass: { type: "STRING", description: "Password." },
        type: { type: "STRING", description: "Account type ('smtp' or 'imap')." },
      },
      required: ["name", "host", "port", "secure", "user", "pass", "type"],
    },
  },
  {
    name: "mail_list_accounts",
    description: "List configured mail accounts.",
  },
  {
    name: "mail_send_email",
    description: "Send email via SMTP.",
    parameters: {
      type: "OBJECT",
      properties: {
        account_name: { type: "STRING", description: "Account name." },
        to: { type: "STRING", description: "Recipient." },
        subject: { type: "STRING", description: "Subject." },
        body: { type: "STRING", description: "Text body." },
        html: { type: "STRING", description: "Optional HTML." },
      },
      required: ["account_name", "to", "subject", "body"],
    },
  },
  {
    name: "mail_list_folders",
    description: "List IMAP folders.",
    parameters: {
      type: "OBJECT",
      properties: {
        account_name: { type: "STRING", description: "Account name." },
      },
      required: ["account_name"],
    },
  },
  {
    name: "mail_list_messages",
    description: "List recent emails (meta only).",
    parameters: {
      type: "OBJECT",
      properties: {
        account_name: { type: "STRING", description: "Account name." },
        folder: { type: "STRING", description: "Folder (default 'INBOX')." },
        limit: { type: "INTEGER", description: "Limit (default 10)." },
      },
      required: ["account_name"],
    },
  },
  {
    name: "mail_list_messages_all",
    description: "List recent emails including full text body.",
    parameters: {
      type: "OBJECT",
      properties: {
        account_name: { type: "STRING", description: "Account name." },
        folder: { type: "STRING", description: "Folder (default 'INBOX')." },
        limit: { type: "INTEGER", description: "Limit (default 10)." },
      },
      required: ["account_name"],
    },
  },
  {
    name: "mail_get_message",
    description: "Get full email content/attachments.",
    parameters: {
      type: "OBJECT",
      properties: {
        account_name: { type: "STRING", description: "Account name." },
        uid: { type: "STRING", description: "Email UID." },
        folder: { type: "STRING", description: "Folder." },
        download_attachments: { type: "BOOLEAN", description: "Download attachments." },
      },
      required: ["account_name", "uid"],
    },
  },
  {
    name: "mail_delete_message",
    description: "Delete an email.",
    parameters: {
      type: "OBJECT",
      properties: {
        account_name: { type: "STRING", description: "Account name." },
        uid: { type: "STRING", description: "Email UID." },
        folder: { type: "STRING", description: "Folder." },
      },
      required: ["account_name", "uid"],
    },
  },
  {
    name: "mail_move_message",
    description: "Move email to another folder.",
    parameters: {
      type: "OBJECT",
      properties: {
        account_name: { type: "STRING", description: "Account name." },
        uid: { type: "STRING", description: "Email UID." },
        target_folder: { type: "STRING", description: "Target folder." },
        source_folder: { type: "STRING", description: "Source folder." },
      },
      required: ["account_name", "uid", "target_folder"],
    },
  },
  // --- TELEGRAM TOOLS ---
  {
    name: "telegram_send",
    description: "Send Telegram message.",
    parameters: {
      type: "OBJECT",
      properties: {
        chat_id: { type: "STRING", description: "Chat ID." },
        message: { type: "STRING", description: "Text message." },
      },
      required: ["chat_id", "message"],
    },
  },
  {
    name: "telegram_list_recent",
    description: "Get recent Telegram updates.",
    parameters: {
      type: "OBJECT",
      properties: {
        offset: { type: "INTEGER", description: "Offset ID." },
        limit: { type: "INTEGER", description: "Max updates (max 100)." },
      },
    },
  },
  {
    name: "telegram_delete",
    description: "Delete Telegram message.",
    parameters: {
      type: "OBJECT",
      properties: {
        chat_id: { type: "STRING", description: "Chat ID." },
        message_id: { type: "INTEGER", description: "Message ID." },
      },
      required: ["chat_id", "message_id"],
    },
  },
  {
    name: "telegram_send_media",
    description: "Send file/media to Telegram.",
    parameters: {
      type: "OBJECT",
      properties: {
        chat_id: { type: "STRING", description: "Chat ID." },
        file_path: { type: "STRING", description: "Absolute path." },
        caption: { type: "STRING", description: "Optional caption." },
      },
      required: ["chat_id", "file_path"],
    },
  },
  {
    name: "telegram_read_media",
    description: "Understand/transcribe Telegram media via AI.",
    parameters: {
      type: "OBJECT",
      properties: {
        chat_id: { type: "STRING", description: "Chat ID." },
        message_id: { type: "INTEGER", description: "Message ID." },
      },
      required: ["chat_id", "message_id"],
    },
  },
  // --- SERVER TOOLS ---
  {
    name: "server_stop",
    description: "Gracefully shut down H-Claw.",
  },
];

// Map cleanly to Gemini
const GEMINI_TOOLS = [
  {
    functionDeclarations: customToolsSchema.map((t) => {
      // Gemini doesn't use the 'properties' wrapper if there are none, but safely we keep it
      const schema = { ...t };
      if (!schema.parameters) {
        delete schema.parameters;
      }
      return schema;
    }),
  },
];

// Map cleanly to OpenAI
const OPENAI_TOOLS = customToolsSchema.map((t) => {
  const oaiTool = {
    type: "function",
    function: { name: t.name, description: t.description },
  };
  if (t.parameters) {
    oaiTool.function.parameters = {
      type: "object",
      properties: {},
      required: t.parameters.required || [],
    };
    for (const [key, val] of Object.entries(t.parameters.properties)) {
      oaiTool.function.parameters.properties[key] = {
        type: val.type.toLowerCase(),
        description: val.description,
      };
    }
  } else {
    oaiTool.function.parameters = { type: "object", properties: {} };
  }
  return oaiTool;
});

// ─── Tool Executor ─────────────────────────────────────────────────────────────

const TOOL_TIMEOUT_MS = 15000;

function runShellCommand(shell, command) {
  console.log(`[${shell.toUpperCase()}] Executing: ${command}`);

  // For PowerShell, explicitly force NoProfile in the wrapper command
  // By passing it to the default shell (cmd.exe on Windows), we avoid nested pwsh calls where the outer one loads the profile.
  const execStr =
    shell === "pwsh"
      ? `pwsh -NoProfile -NonInteractive -Command "${command.replace(/"/g, '\\"')}"`
      : command;

  const options = { timeout: TOOL_TIMEOUT_MS };
  if (shell === "bash") {
    options.shell = "bash";
  }

  return new Promise((resolve) => {
    exec(execStr, options, (error, stdout, stderr) => {
      let output = (stdout || "") + (stderr || "");
      if (error && !output) output = error.message;
      const finalOutput = output.trim() || "(no output)";
      console.log(`[${shell.toUpperCase()}] Output:\n${finalOutput}`);
      resolve(finalOutput);
    });
  });
}

function processTarget(target_id) {
  let target = String(target_id).trim();
  if (!target.includes("@")) target += "@c.us";
  return target;
}

async function executeTool(name, args, client = null) {
  console.log(`🔧  Tool called: ${name}`);

  // ─── SERVER TOOLS ───
  if (name === "server_stop") {
    const { stopServer } = require("./serverTools");
    await stopServer();
    return "✅ Shutdown initiated.";
  }

  // ─── SHELL TOOLS ───
  if (name === "execute_bash")
    return await runShellCommand("bash", args.command);
  if (name === "execute_powershell")
    return await runShellCommand("pwsh", args.command);

  // ─── MEMORY TOOLS ───
  if (name === "memory_list") {
    const lines = readMemoryLines();
    if (lines.length === 0) return "🧠 Memory is empty.";
    return (
      "🧠 Memory Facts:\n" + lines.map((l, i) => `[${i + 1}] ${l}`).join("\n")
    );
  }
  if (name === "memory_add") {
    const lines = readMemoryLines();
    lines.push(args.fact);
    writeMemoryLines(lines);
    return `✅ Fact added. Total: ${lines.length}`;
  }
  if (name === "memory_add_media") {
    try {
      const fp = args.file_path;
      if (!fs.existsSync(fp))
        return `❌ File not found at path: ${fp}`;

      // Add it to memory
      const lines = readMemoryLines();
      const finalDesc = (args.description || "User-provided media").trim();
      lines.push(`${finalDesc} (File Path: @[${fp}])`);
      writeMemoryLines(lines);

      return `✅ Media fact added.`;
    } catch (e) {
      return `❌ Save Media Error: ${e.message}`;
    }
  }
  if (name === "memory_remove") {
    const lines = readMemoryLines();
    const idx = args.index - 1;
    if (idx >= 0 && idx < lines.length) {
      const rm = lines.splice(idx, 1);
      writeMemoryLines(lines);
      return `🗑️ Removed [${args.index}]: "${rm[0]}"`;
    }
    return `❌ Invalid index.`;
  }
  if (name === "memory_edit") {
    const lines = readMemoryLines();
    const idx = args.index - 1;
    if (idx >= 0 && idx < lines.length) {
      lines[idx] = args.new_fact;
      writeMemoryLines(lines);
      return `✏️ Edited fact [${args.index}] to: "${args.new_fact}"`;
    }
    return `❌ Invalid index.`;
  }
  if (name === "memory_clear") {
    writeMemoryLines([]);
    return `🧹 Memory cleared.`;
  }

  // ─── FILE SYSTEM TOOLS ───
  if (name === "file_read") {
    try {
      if (!fs.existsSync(args.file_path))
        return `❌ File not found: ${args.file_path}`;
      const content = fs.readFileSync(args.file_path, "utf8");
      return content.substring(0, 10000); // Prevent too large files from breaking context
    } catch (e) {
      return `❌ Read Error: ${e.message}`;
    }
  }
  if (name === "file_write") {
    try {
      fs.writeFileSync(args.file_path, args.content, "utf8");
      return `✅ Wrote: ${args.file_path}`;
    } catch (e) {
      return `❌ Write Error: ${e.message}`;
    }
  }
  if (name === "file_append") {
    try {
      const appended =
        typeof args.content === "string" && !args.content.startsWith("\n")
          ? "\n" + args.content
          : args.content;
      fs.appendFileSync(args.file_path, appended, "utf8");
      return `✅ Appended: ${args.file_path}`;
    } catch (e) {
      return `❌ Append Error: ${e.message}`;
    }
  }
  if (name === "file_list") {
    try {
      if (!fs.existsSync(args.dir_path))
        return `❌ Directory not found: ${args.dir_path}`;
      const items = fs.readdirSync(args.dir_path);
      return `📂 Contents of ${args.dir_path}:\n` + items.join("\n");
    } catch (e) {
      return `❌ List Error: ${e.message}`;
    }
  }

  // ─── SYSTEM TOOLS ───
  if (name === "tool_save") {
    try {
      const appended =
        typeof args.tool_content === "string" &&
        !args.tool_content.startsWith("\n")
          ? "\n" + args.tool_content
          : args.tool_content;
      fs.appendFileSync(toolsPath, appended + "\n", "utf8");
      return `✅ Saved to ./MD/TOOLS.md`;
    } catch (e) {
      return `❌ Tool Save Error: ${e.message}`;
    }
  }

  // ─── WHATSAPP TEXT TOOLS ───
  if (name === "whatsapp_send") {
    if (!client) return `❌ No client.`;
    try {
      const target = processTarget(args.target_id);
      const payload = args.message.startsWith("🐾")
        ? args.message
        : "🐾 " + args.message;
      await client.sendMessage(target, payload);
      return `✅ Sent to ${target}.`;
    } catch (e) {
      return `❌ Error: ${e.message}`;
    }
  }

  if (name === "whatsapp_reply") {
    if (!client) return `❌ No client.`;
    try {
      const targetMessage = await client.getMessageById(args.message_id.trim());
      if (targetMessage) {
        const payload = args.message.startsWith("🐾")
          ? args.message
          : "🐾 " + args.message;
        await targetMessage.reply(payload);
        return `✅ Replied (ID: ${args.message_id}).`;
      }
      return `❌ Message not found.`;
    } catch (e) {
      return `❌ Error: ${e.message}`;
    }
  }

  if (name === "whatsapp_list_recent") {
    if (!client) return `❌ No client.`;
    try {
      const target = processTarget(args.target_id);
      const chat = await client.getChatById(target);
      const messages = await chat.fetchMessages({ limit: args.limit || 10 });
      if (messages.length === 0) return `ℹ️ No messages.`;
      const formatted = messages.map((m) => {
        const dir = m.id.fromMe ? "📤 Out" : "📩 In";
        const hasMedia = m.hasMedia ? " [MEDIA ATTACHED] " : " ";
        return `[${new Date(m.timestamp * 1000).toLocaleString()}] ID: ${m.id._serialized} | ${dir}:${hasMedia}${m.body}`;
      });
      return `📱 Recent messages:\n${formatted.join("\n")}`;
    } catch (e) {
      return `❌ Error: ${e.message}`;
    }
  }

  if (name === "whatsapp_list_contacts") {
    if (!client) return `❌ No client.`;
    try {
      let query = (args.query || "").toLowerCase().trim();
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

      const limit = 30;
      const results = filtered.slice(0, limit);
      
      if (results.length === 0) {
          return `ℹ️ No contacts found matching "${query}".`;
      }

      let reply = `📱 *WhatsApp Contacts${query ? ` matching "${query}"` : ''}:*\n\n`;
      results.forEach((c, idx) => {
          const type = c.isGroup ? '[GROUP]' : '[CONTACT]';
          const name = c.name || c.pushname || 'Unknown';
          reply += `${idx + 1}. ${type} ${name} (${c.id.user})\n`;
      });

      if (filtered.length > limit) {
          reply += `\n...and ${filtered.length - limit} more.`;
      }
      return reply;
    } catch (e) {
      return `❌ Error: ${e.message}`;
    }
  }

  // ─── MEDIA GENERATION TOOLS ───
  if (name === "generate_image") {
    if (!internalOpenAI) return `❌ OpenAI Client not configured.`;
    try {
      console.log(`🎨 Requesting DALL-E 3 image: "${args.prompt}"...`);
      const response = await internalOpenAI.images.generate({
        model: "dall-e-3",
        prompt: args.prompt,
        n: 1,
        size: "1024x1024",
      });
      const imageUrl = response.data[0].url;
      console.log(`📡 Image URL received. Downloading...`);
      
      // Download Image with 30s timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      try {
        const fetchResponse = await fetch(imageUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!fetchResponse.ok) throw new Error(`HTTP ${fetchResponse.status}`);
        
        const buffer = await fetchResponse.arrayBuffer();
        const fn = `img_${Date.now()}.png`;
        const fp = path.join(tmpDir, fn);
        
        console.log(`💾 Saving image to: ${fp}`);
        fs.writeFileSync(fp, Buffer.from(buffer));
        
            return `✅ Image: ${fp}`;
      } catch (fErr) {
        clearTimeout(timeoutId);
        return `❌ Image Download Error: ${fErr.message}`;
      }
    } catch (e) {
      return `❌ Image Gen Error: ${e.message}`;
    }
  }

  if (name === "generate_audio") {
    if (!internalOpenAI) return `❌ OpenAI Client not configured.`;
    try {
      const mp3 = await internalOpenAI.audio.speech.create({
        model: "tts-1",
        voice: args.voice || "alloy",
        input: args.text,
      });
      const buffer = Buffer.from(await mp3.arrayBuffer());
      const fn = `audio_${Date.now()}.mp3`;
      const fp = path.join(tmpDir, fn);
      fs.writeFileSync(fp, buffer);
      return `✅ Audio: ${fp}`;
    } catch (e) {
      return `❌ Audio Gen Error: ${e.message}`;
    }
  }

  if (name === "whatsapp_send_media") {
    if (!client) return `❌ No client.`;
    try {
      const target = processTarget(args.target_id);
      if (!fs.existsSync(args.file_path))
        return `❌ File not found at path: ${args.file_path}`;

      const media = MessageMedia.fromFilePath(args.file_path);
      let finalCaption = args.caption ? args.caption.trim() : "";
      if (!finalCaption.startsWith("🐾")) {
        finalCaption = finalCaption ? "🐾 " + finalCaption : "🐾 ";
      }
      const options = { caption: finalCaption };

      await client.sendMessage(target, media, options);
      return `✅ Media sent.`;
    } catch (e) {
      return `❌ Send Media Error: ${e.message}`;
    }
  }

  // ─── MEDIA UNDERSTANDING TOOL ───
  if (name === "whatsapp_read_media") {
    if (!client) return `❌ No client.`;
    try {
      const targetMessage = await client.getMessageById(args.message_id.trim());
      if (!targetMessage || !targetMessage.hasMedia)
        return `❌ Message ID not found or has no media attached.`;

      const media = await targetMessage.downloadMedia();
      if (!media) return `❌ Failed to download media from WhatsApp.`;

      // 1. Audio / Voice Notes -> OpenAI Whisper
      if (media.mimetype.includes("audio")) {
        if (!internalOpenAI) return "❌ OpenAI (Whisper) not configured.";
        const fp = path.join(tmpDir, `temp_read_${Date.now()}.ogg`);
        fs.writeFileSync(fp, Buffer.from(media.data, "base64"));

        const transcription = await internalOpenAI.audio.transcriptions.create({
          file: fs.createReadStream(fp),
          model: "whisper-1",
        });

        fs.unlinkSync(fp); // cleanup
        return `🎙️ Audio Transcription: "${transcription.text}"`;
      }

      // 2. Images, Videos, PDFs, Documents -> Upload to Gemini File API
      if (!fileManager)
        return "❌ Google Gen AI File Manager not configured. Cannot process large documents/media.";

      const ext = media.mimetype.split("/")[1]?.split(";")[0] || "bin";
      const fp = path.join(tmpDir, `upload_${Date.now()}.${ext}`);

      // Temporarily write the base64 data to disk so we can upload it
      fs.writeFileSync(fp, Buffer.from(media.data, "base64"));

      try {
        const uploadResult = await fileManager.upload({
          file: fp,
          mimeType: media.mimetype,
        });

        // Clean up temporary file
        fs.unlinkSync(fp);

        const { getActiveModel } = require("./Models");
        const activeModelProvider = getActiveModel().provider;

        // If the main model is OpenAI, OpenAI cannot read Google's File_URIs.
        // So we use Gemini internally to read the file and return the summary text back to OpenAI.
        if (
          activeModelProvider === "openai" ||
          activeModelProvider === "chatgpt"
        ) {
          if (!geminiToolClient)
            return "❌ Gemini fallback not configured. Cannot proxy document reading.";

          const prompt = "Describe this file in explicit detail. Omit talk.";

          const proxyResponse = await geminiToolClient.models.generateContent({
            model: "gemini-1.5-flash",
            contents: [
              {
                role: "user",
                parts: [
                  {
                    fileData: {
                      mimeType: media.mimetype,
                      fileUri: uploadResult.uri,
                    },
                  },
                  { text: prompt },
                ],
              },
            ],
          });

          // We can optionally delete the file from Google now since we got the text
          try {
            await fileManager.delete({ name: uploadResult.name });
          } catch (err) {}

          return `📄 [PROXY AI DOCUMENT ANALYSIS]\n${proxyResponse.text}`;
        }

        // If main model is Gemini, just return the URI so Gemini can read it directly
        return `📄 [FILE_URI_ATTACHMENT]
The user's file has been securely uploaded to the AI cloud for analysis.
MimeType: ${media.mimetype}
FileUri: ${uploadResult.uri}`;
      } catch (uploadError) {
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
        throw uploadError;
      }
    } catch (e) {
      return `❌ Read Media Error: ${e.message}`;
    }
  }

  if (name === "whatsapp_download_media") {
    if (!client) return `❌ No client.`;
    try {
      const targetMessage = await client.getMessageById(args.message_id.trim());
      if (!targetMessage || !targetMessage.hasMedia)
        return `❌ Message ID not found or has no media attached.`;

      const media = await targetMessage.downloadMedia();
      if (!media) return `❌ Failed to download media from WhatsApp.`;

      const ext = media.mimetype.split("/")[1]?.split(";")[0] || "bin";
      const fn =
        args.filename || media.filename || `download_${Date.now()}.${ext}`;
      const fp = path.join(tmpDir, fn);
      fs.writeFileSync(fp, Buffer.from(media.data, "base64"));
      return `✅ Downloaded: ${fp}`;
    } catch (e) {
      return `❌ Download Media Error: ${e.message}`;
    }
  }

  // ─── MAIL TOOLS ───
  if (name === "mail_add_account") {
    try {
      return mailManager.addAccount(args.name, {
        host: args.host,
        port: args.port,
        secure: args.secure,
        user: args.user,
        pass: args.pass,
        type: args.type,
      });
    } catch (e) {
      return `❌ Mail Error: ${e.message}`;
    }
  }

  if (name === "mail_list_accounts") {
    const list = mailManager.listAccounts();
    return list.length === 0 ? "📭 No mail accounts configured." : `📬 Configured mail accounts:\n- ${list.join("\n- ")}`;
  }

  if (name === "mail_send_email") {
    try {
      const mid = await mailManager.sendEmail(args.account_name, args.to, args.subject, args.body, args.html);
      return `✅ Email sent. ID: ${mid}`;
    } catch (e) {
      return `❌ Mail Send Error: ${e.message}`;
    }
  }

  if (name === "mail_list_folders") {
    try {
      const folders = await mailManager.listFolders(args.account_name);
      return `📂 Folders in ${args.account_name}:\n- ${folders.join("\n- ")}`;
    } catch (e) {
      return `❌ Mail Error: ${e.message}`;
    }
  }

  if (name === "mail_list_messages") {
    try {
      const messages = await mailManager.listMessages(args.account_name, args.folder, args.limit);
      if (messages.length === 0) return `ℹ️ No messages found.`;
      const formatted = messages.map(m => `[UID: ${m.uid}] ${m.subject} (From: ${m.from}, To: ${m.to}, Date: ${m.date})`);
      return `📧 Recent messages in ${args.folder || 'INBOX'}:\n${formatted.join("\n")}`;
    } catch (e) {
      return `❌ Mail Error: ${e.message}`;
    }
  }

  if (name === "mail_list_messages_all") {
    try {
      const messages = await mailManager.listMessagesAll(args.account_name, args.folder, args.limit);
      if (messages.length === 0) return `ℹ️ No messages found.`;
      const formatted = messages.map(m => {
        let res = `[UID: ${m.uid}] ${m.subject}\nFrom: ${m.from}\nTo: ${m.to}\nDate: ${m.date}\n\n${m.text || m.html || '(No content)'}`;
        return res;
      });
      return `📧 Full messages in ${args.folder || 'INBOX'}:\n\n${formatted.join("\n\n---\n\n")}`;
    } catch (e) {
      return `❌ Mail Error: ${e.message}`;
    }
  }

  if (name === "mail_get_message") {
    try {
      const msg = await mailManager.getMessage(args.account_name, args.uid, args.folder, args.download_attachments);
      let res = `📧 Subject: ${msg.subject}\nFrom: ${msg.from}\nTo: ${msg.to}\nDate: ${msg.date}\n\n${msg.text}\n`;
      if (msg.attachments && msg.attachments.length > 0) {
        res += `\n📎 Attachments: ${msg.attachments.map(a => `${a.filename} (${a.size} bytes)`).join(", ")}`;
        if (msg.downloadedAttachments) {
          res += `\n✅ Downloaded to: ${msg.downloadedAttachments.map(da => da.path).join(", ")}`;
        } else {
          res += `\nℹ️ Attachments not downloaded. Call again with download_attachments: true to fetch them.`;
        }
      }
      return res;
    } catch (e) {
      return `❌ Mail Error: ${e.message}`;
    }
  }

  if (name === "mail_delete_message") {
    try {
      return await mailManager.deleteMessage(args.account_name, args.uid, args.folder);
    } catch (e) {
      return `❌ Mail Error: ${e.message}`;
    }
  }

  if (name === "mail_move_message") {
    try {
      return await mailManager.moveMessage(args.account_name, args.uid, args.target_folder, args.source_folder);
    } catch (e) {
      return `❌ Mail Error: ${e.message}`;
    }
  }

  // ─── TELEGRAM TOOLS ───
  if (name.startsWith("telegram_")) {
    const { getTelegramClient } = require("./telegramClient");
    const telegram = getTelegramClient();

    if (!telegram) return "❌ Telegram client not initialized.";

    if (name === "telegram_send") {
        try {
          const data = await telegram.sendTelegramMessage(args.chat_id, args.message);
          return `✅ Telegram sent. ID: ${data.result.message_id}`;
        } catch (e) {
          return `❌ Telegram Error: ${e.message}`;
        }
    }

    if (name === "telegram_list_recent") {
        try {
          const data = await telegram.getTelegramUpdates(args.offset, args.limit);
          if (data.result.length === 0) return "ℹ️ No recent Telegram updates.";
          const formatted = data.result.map(u => {
            const msg = u.message || u.edited_message || u.channel_post;
            if (!msg) return `[Update ID: ${u.update_id}] (Non-message update)`;
            return `[Msg ID: ${msg.message_id}] From: ${msg.from?.first_name || 'System'} (Chat: ${msg.chat.id}): ${msg.text || '(No text content)'}`;
          });
          return `📱 Recent Telegram updates:\n${formatted.join("\n")}`;
        } catch (e) {
          return `❌ Telegram Error: ${e.message}`;
        }
    }

    if (name === "telegram_delete") {
        try {
          await telegram.deleteTelegramMessage(args.chat_id, args.message_id);
          return `✅ Telegram deleted (ID: ${args.message_id}).`;
        } catch (e) {
          return `❌ Telegram Error: ${e.message}`;
        }
    }

    if (name === "telegram_send_media") {
        try {
            await telegram.sendTelegramMedia(args.chat_id, args.file_path, args.caption);
            return `✅ Telegram media sent.`;
        } catch (e) {
            return `❌ Telegram Error: ${e.message}`;
        }
    }

    if (name === "telegram_read_media") {
        try {
            // 1. Get update history to find the media file info
            const updates = await telegram.getTelegramUpdates();
            const update = updates.result.find(u => {
                const msg = u.message || u.edited_message || u.channel_post;
                return msg && String(msg.message_id) === String(args.message_id) && String(msg.chat.id) === String(args.chat_id);
            });

            if (!update) return "❌ Message not found in recent history. Cannot download.";
            const msg = update.message || update.edited_message || update.channel_post;
            
            let fileId = null;
            let type = '';
            let mimetype = '';

            if (msg.photo) {
                fileId = msg.photo[msg.photo.length - 1].file_id;
                type = 'photo';
                mimetype = 'image/jpeg';
            } else if (msg.voice) {
                fileId = msg.voice.file_id;
                type = 'voice';
                mimetype = 'audio/ogg';
            } else if (msg.audio) {
                fileId = msg.audio.file_id;
                type = 'audio';
                mimetype = 'audio/mpeg';
            } else if (msg.document) {
                fileId = msg.document.file_id;
                type = 'document';
                mimetype = msg.document.mime_type || 'application/octet-stream';
            }

            if (!fileId) return "❌ No media found in this message.";

            const ext = mimetype.split('/')[1]?.split(';')[0] || 'bin';
            const fp = path.join(tmpDir, `tele_read_${Date.now()}.${ext}`);
            await telegram.downloadTelegramFile(fileId, fp);

            // Re-use the existing logic from whatsapp_read_media but adapted for a local file
            if (type === 'voice' || type === 'audio') {
                if (!internalOpenAI) return "❌ OpenAI (Whisper) not configured.";
                const transcription = await internalOpenAI.audio.transcriptions.create({
                    file: fs.createReadStream(fp),
                    model: "whisper-1",
                });
                fs.unlinkSync(fp);
                return `🎙️ Telegram Audio Transcription: "${transcription.text}"`;
            }

            // For images/docs, use Gemini
            if (!fileManager) return "❌ Gemini File Manager not configured.";
            
            const uploadResult = await fileManager.upload({
                file: fp,
                mimeType: mimetype,
            });
            fs.unlinkSync(fp);

            const { getActiveModel } = require("./Models");
            const activeModelProvider = getActiveModel().provider;

            if (activeModelProvider === "openai" || activeModelProvider === "chatgpt") {
                const prompt = "Describe this file in explicit detail. Omit talk.";
                const proxyResponse = await geminiToolClient.models.generateContent({
                    model: "gemini-1.5-flash",
                    contents: [{ role: "user", parts: [{ fileData: { mimeType: mimetype, fileUri: uploadResult.uri } }, { text: prompt }] }],
                });
                try { await fileManager.delete({ name: uploadResult.name }); } catch (err) {}
                return `📄 [TELEGRAM MEDIA ANALYSIS]\n${proxyResponse.text}`;
            }

            return `📄 [TELEGRAM_FILE_URI] MimeType: ${mimetype} FileUri: ${uploadResult.uri}`;
        } catch (e) {
            return `❌ Telegram Read Media Error: ${e.message}`;
        }
    }
  }

  return `Unknown tool: ${name}`;
}

module.exports = {
  GEMINI_TOOLS,
  OPENAI_TOOLS,
  executeTool,
  wipeTmpDirectory,
};

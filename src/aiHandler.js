const { GoogleGenAI } = require("@google/genai");
const OpenAI = require("openai");
const { getActiveModel, getAvailableModels, activeModelFallback} = require ('./Models');
const { GEMINI_TOOLS, OPENAI_TOOLS, executeTool } = require('./aiTools');
const { recordTokenUsage } = require('./tokenUsageStore');
const { appendModelPromptLog } = require('./loggerTool');


const geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let cumulativeTotalTokens = 0;

const fs   = require('fs');
const path = require('path');

const memoryPath = path.join(__dirname, '..', 'MD', 'MEMORY.md');
const toolsPath  = path.join(__dirname, '..', 'MD', 'TOOLS.md');
const soulPath   = path.join(__dirname, '..', 'MD', 'SOUL.md');
const heartbeatPath = path.join(__dirname, '..', 'MD', 'HEARTBEAT.md');

const PROMPT_LIMITS = {
  systemChars: 6000,
  historyChars: 3500,
  currentMessageChars: 4000,
  toolResultChars: 1800,
};

const PLATFORM_PROMPTS = {
    whatsapp: "Platform: WhatsApp. Reply directly; use whatsapp_send/whatsapp_reply only for other chats.",
    telegram: "Platform: Telegram. Reply directly; use telegram_send/telegram_reply only for other chats.",
    onboard: "Platform: OB Dashboard. System admin tools enabled."
};

function parsePlatformContext(platform = 'whatsapp') {
  const raw = String(platform || 'whatsapp');
  if (!raw.includes(':')) {
    return { platformName: raw, currentTarget: '' };
  }
  const [platformName, ...rest] = raw.split(':');
  return {
    platformName: platformName || 'whatsapp',
    currentTarget: rest.join(':').trim(),
  };
}

function providerEmoji(provider) {
  if (provider === 'gemini') return '💎';
  if (provider === 'openai' || provider === 'chatgpt') return '🤖';
  if (provider === 'anthropic' || provider === 'claude') return '🧠';
  return '🤔';
}

function getUsagePlatform(platform = 'whatsapp') {
  return parsePlatformContext(platform).platformName;
}

function getMaxToolRounds() {
  const raw = parseInt(process.env.MAX_TOOL_CALLS || '15', 10);
  if (!Number.isFinite(raw)) return 15;
  return Math.max(1, Math.min(100, raw));
}

function normalizeWhitespace(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function trimFromStart(text, maxChars) {
  const normalized = normalizeWhitespace(text);
  if (!maxChars || normalized.length <= maxChars) return normalized;
  return `...${normalized.slice(-(maxChars - 3))}`;
}

function trimKeepEdges(text, maxChars) {
  const normalized = normalizeWhitespace(text);
  if (!maxChars || normalized.length <= maxChars) return normalized;
  if (maxChars <= 20) return normalized.slice(0, maxChars);
  const keep = maxChars - 7;
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${normalized.slice(0, head)}\n...\n${normalized.slice(-tail)}`;
}

function appendWithinBudget(parts, text, remaining) {
  const normalized = normalizeWhitespace(text);
  if (!normalized || remaining <= 0) return remaining;
  if (normalized.length <= remaining) {
    parts.push(normalized);
    return remaining - normalized.length - 1;
  }
  if (remaining > 32) {
    parts.push(trimKeepEdges(normalized, remaining));
  }
  return 0;
}

function getSystemPrompt(platform = 'whatsapp', userPrompt = '') {
  const { platformName, currentTarget } = parsePlatformContext(platform);
  const parts = [];
  let remaining = PROMPT_LIMITS.systemChars;
  const shouldInjectHeartbeat = /_heartbeat_/i.test(String(userPrompt || ''));
  const { getBotLogHistory } = require('./historyHandler');
  const botLogHistory = normalizeWhitespace(getBotLogHistory());
  if (platformName === 'telegram' && currentTarget) {
    remaining = appendWithinBudget(parts, `Current Telegram chat_id: ${currentTarget}.`, remaining);
  }
  try {
    if (fs.existsSync(soulPath)) {
      remaining = appendWithinBudget(parts, fs.readFileSync(soulPath, 'utf8'), remaining);
    }
    if (fs.existsSync(memoryPath)) {
      remaining = appendWithinBudget(parts, fs.readFileSync(memoryPath, 'utf8'), remaining);
    }
    if (fs.existsSync(toolsPath)) {
      remaining = appendWithinBudget(parts, fs.readFileSync(toolsPath, 'utf8'), remaining);
    }
    if (botLogHistory) {
      remaining = appendWithinBudget(parts, `[RECENT BOT LOGS]\n${botLogHistory}`, remaining);
    }
    if (shouldInjectHeartbeat && fs.existsSync(heartbeatPath)) {
      remaining = appendWithinBudget(parts, fs.readFileSync(heartbeatPath, 'utf8'), remaining);
    }
  } catch(e) {
    console.error("Error loading prompt context files:", e);
  }
  return parts.join("\n");
}

function buildPromptContext(prompt, historyText = '') {
  const trimmedPrompt = trimKeepEdges(prompt, PROMPT_LIMITS.currentMessageChars);
  const trimmedHistory = trimFromStart(historyText, PROMPT_LIMITS.historyChars);
  if (!trimmedHistory) {
    return trimmedPrompt;
  }
  return `[RECENT BOT LOGS]\n${trimmedHistory}\n\n[CURRENT MESSAGE]\n${trimmedPrompt}`;
}

function clampToolResult(result) {
  if (typeof result !== 'string') return result;
  return trimKeepEdges(result, PROMPT_LIMITS.toolResultChars);
}

function getUserPromptChars(prompt) {
  return trimKeepEdges(prompt, PROMPT_LIMITS.currentMessageChars).length;
}

async function getGeminiResponse(modelName, prompt, client, chatHistory = "", platform = 'whatsapp') {
  const model = getActiveModel();
  if(model.changed) {
    model.setChanged(false);
  }

  const fullPrompt = buildPromptContext(prompt, chatHistory);
  const systemPrompt = getSystemPrompt(platform, prompt);
  const systemPromptChars = systemPrompt.length;
  const userPromptChars = getUserPromptChars(prompt);
  appendModelPromptLog(systemPrompt, fullPrompt);

  // Build initial contents array
  const contents = [{ role: 'user', parts: [{ text: fullPrompt }] }];
  const MAX_ROUNDS = getMaxToolRounds();

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await geminiClient.models.generateContent({
      model: modelName,
      contents: contents,
      config: {
        systemInstruction: systemPrompt,
        tools: GEMINI_TOOLS,
      },
    });
    //++++++++++++++++++++++++++++++
    cumulativeTotalTokens += response.usageMetadata.totalTokenCount || 0;
    console.log("🪙  PT = ", response.usageMetadata.promptTokenCount," CT= ", response.usageMetadata.candidatesTokenCount,
    " TT = ", response.usageMetadata.totalTokenCount, " CTT = ", cumulativeTotalTokens,
    " SPC = ", systemPromptChars, " UPC = ", userPromptChars);       // total
    recordTokenUsage({
      provider: 'gemini',
      model: modelName,
      platform: getUsagePlatform(platform),
      usage: {
        input_tokens: response.usageMetadata.promptTokenCount || 0,
        output_tokens: response.usageMetadata.candidatesTokenCount || 0,
        total_tokens: response.usageMetadata.totalTokenCount || 0,
        cached_tokens: response.usageMetadata.cachedContentTokenCount || 0,
      },
    });
    //+++++++++++++++++++++++++++++++

    // Check if the model wants to call a tool
    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const toolCallParts = parts.filter(p => p.functionCall);

    if (toolCallParts.length === 0) {
      // No tool calls — return the final text
      return response.text;
    }

    // Append the model's tool call turn to the conversation
    contents.push({ role: 'model', parts: parts });

    // Execute each tool call and collect function responses
    const toolResponseParts = [];
    for (const part of toolCallParts) {
      const { name, args } = part.functionCall;
      const rawResult = await executeTool(name, args, client, platform);
      const result = clampToolResult(rawResult);

      // If the tool uploaded a file, we need to extract the URI and MimeType
      // to pass it genuinely as 'fileData' so the model can read it, not just as text.
      if (typeof rawResult === 'string' && rawResult.includes('[FILE_URI_ATTACHMENT]')) {
         const mimeMatch = rawResult.match(/MimeType:\s*([^\n]+)/);
         const uriMatch = rawResult.match(/FileUri:\s*([^\n]+)/);
         
         if (mimeMatch && uriMatch) {
            toolResponseParts.push({
               fileData: { mimeType: mimeMatch[1].trim(), fileUri: uriMatch[1].trim() }
            });
         }
      }

      // Always return the text output of the tool as well so the model knows it succeeded
      toolResponseParts.push({
        functionResponse: {
          name: name,
          response: { output: result },
        },
      });
    }

    // Append the tool results as a user turn
    contents.push({ role: 'user', parts: toolResponseParts });
  }

  return '❌ Max tool-calling rounds reached without a final response.';
}

async function getOpenAIResponse(modelName, prompt, client, chatHistory = "", platform = 'whatsapp') {
  const model = getActiveModel();
  if(model.changed) {
    model.setChanged(false);
  }

  const fullPrompt = buildPromptContext(prompt, chatHistory);
  const systemPrompt = getSystemPrompt(platform, prompt);
  const systemPromptChars = systemPrompt.length;
  const userPromptChars = getUserPromptChars(prompt);
  appendModelPromptLog(systemPrompt, fullPrompt);

  // Build initial messages array
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: fullPrompt },
  ];
  const MAX_ROUNDS = getMaxToolRounds();

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await openaiClient.chat.completions.create({
      model: modelName,
      messages: messages,
      tools: OPENAI_TOOLS,
    });
    //++++++++++++++++++++++++++++++
    cumulativeTotalTokens += response.usage.total_tokens || 0;
    console.log("🪙  IT = ", response.usage.prompt_tokens," OT= ", response.usage.completion_tokens,
    " TT = ", response.usage.total_tokens, " CTT = ", cumulativeTotalTokens,
    " SPC = ", systemPromptChars, " UPC = ", userPromptChars);       // total
    recordTokenUsage({
      provider: 'openai',
      model: modelName,
      platform: getUsagePlatform(platform),
      usage: {
        input_tokens: response.usage.prompt_tokens || 0,
        output_tokens: response.usage.completion_tokens || 0,
        total_tokens: response.usage.total_tokens || 0,
        reasoning_tokens: response.usage.completion_tokens_details?.reasoning_tokens || 0,
        cached_tokens: response.usage.prompt_tokens_details?.cached_tokens || 0,
      },
    });
    //+++++++++++++++++++++++++++++++

    const choice = response.choices[0];

    if (choice.finish_reason !== 'tool_calls') {
      // No tool calls — return the final text
      return choice.message.content;
    }

    // Append the assistant's tool call message
    messages.push(choice.message);

    // Execute each tool call and append the results
    for (const toolCall of choice.message.tool_calls) {
      const name = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);
      const result = clampToolResult(await executeTool(name, args, client, platform));
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  return '❌ Max tool-calling rounds reached without a final response.';
}

async function generateAIResponse(prompt, isSelf = false, client = null, chatHistory = "", platform = 'whatsapp') {
  let model = getActiveModel();
  let provider = model.provider;
  let modelName = model.model;
  const { platformName } = parsePlatformContext(platform);
  const heartbeatDetected = /_heartbeat_/i.test(String(prompt || ''));

  const appendedHistory = '';

  try {
    console.log(`${providerEmoji(provider)} ${modelName}`);
    if (heartbeatDetected) {
      console.log('💓 [HEARTBEAT] "_heartbeat_" detected in prompt. HEARTBEAT.md injected into system prompt.');
    }
    //++++++++++++++++++++++++++++++
    if (provider === "gemini") {
      return await getGeminiResponse(modelName, prompt, client, appendedHistory, platform);
    } else if (provider === "chatgpt" || provider === "openai") {
      return await getOpenAIResponse(modelName, prompt, client, appendedHistory, platform);
    } else {
      console.warn(`Unknown provider: ${provider}`);
    }
    //++++++++++++++++++++++++++++++
  } 
  catch (error) 
  {
    console.error(`❌  Error with ${provider} (${modelName}):`, error.message);
    console.log(`🔄  Falling back to next model...`);
    //++++++++++++++++++++++++++++++
    activeModelFallback();
    model = getActiveModel();
    //++++++++++++++++++++++++++++++
    if (model.number === 0){
      model.set(1);
      console.log ("❌  I'm sorry, all my AI models are currently unavailable. Please try again later.");
      return "❌  I'm sorry, all my AI models are currently unavailable. Please try again later.";
    }
    else{
      provider = model.provider;
      modelName = model.model;
      console.log(`🔄  ${provider} (${modelName}): just activated. resent prompt`);
      return await generateAIResponse(prompt, isSelf, client, chatHistory, platformName === 'telegram' ? platform : platformName)
    }
  }
}

module.exports = { 
  generateAIResponse
 };

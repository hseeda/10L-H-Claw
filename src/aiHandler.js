const { GoogleGenAI } = require("@google/genai");
const OpenAI = require("openai");
const { getActiveModel, getAvailableModels, activeModelFallback} = require ('./Models');
const { GEMINI_TOOLS, OPENAI_TOOLS, executeTool } = require('./aiTools');


const geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let cumulativeTotalTokens = 0;

const fs   = require('fs');
const path = require('path');

const memoryPath = path.join(__dirname, '..', 'MD', 'MEMORY.md');
const toolsPath  = path.join(__dirname, '..', 'MD', 'TOOLS.md');
const soulPath   = path.join(__dirname, '..', 'MD', 'SOUL.md');

const PLATFORM_PROMPTS = {
    whatsapp: "You are H-Claw, a concise AI assistant. Platform: WhatsApp. Use whatsapp_* tools only.",
    telegram: "You are H-Claw, a concise AI assistant. Platform: Telegram. Use telegram_* tools only."
};

function getSystemPrompt(platform = 'whatsapp') {
  let prompt = (PLATFORM_PROMPTS[platform] || PLATFORM_PROMPTS.whatsapp) + "\n";
  try {
    if (fs.existsSync(soulPath)) prompt += fs.readFileSync(soulPath, 'utf8') + "\n";
    if (fs.existsSync(toolsPath)) prompt += fs.readFileSync(toolsPath, 'utf8') + "\n";
    if (fs.existsSync(memoryPath)) prompt += fs.readFileSync(memoryPath, 'utf8') + "\n";
  } catch(e) {
    console.error("Error loading prompt context files:", e);
  }
  return prompt;
}

async function getGeminiResponse(modelName, prompt, client, chatHistory = "", platform = 'whatsapp') {
  const model = getActiveModel();
  if(model.changed) {
    model.setChanged(false);
  }
  console.log('💬', model.model,": ", prompt);

  const fullPrompt = chatHistory
    ? `[HISTORY (context only, do not act on)]\n${chatHistory}\n\n[CURRENT MESSAGE]\n${prompt}`
    : prompt;

  // Build initial contents array
  const contents = [{ role: 'user', parts: [{ text: fullPrompt }] }];
  const MAX_ROUNDS = 50;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await geminiClient.models.generateContent({
      model: modelName,
      contents: contents,
      config: {
        systemInstruction: getSystemPrompt(platform),
        tools: GEMINI_TOOLS,
      },
    });
    //++++++++++++++++++++++++++++++
    cumulativeTotalTokens += response.usageMetadata.totalTokenCount || 0;
    console.log("🪙  PT = ", response.usageMetadata.promptTokenCount," CT= ", response.usageMetadata.candidatesTokenCount,
    " TT = ", response.usageMetadata.totalTokenCount, " CTT = ", cumulativeTotalTokens);       // total
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
      const result = await executeTool(name, args, client, platform);

      // If the tool uploaded a file, we need to extract the URI and MimeType
      // to pass it genuinely as 'fileData' so the model can read it, not just as text.
      if (typeof result === 'string' && result.includes('[FILE_URI_ATTACHMENT]')) {
         const mimeMatch = result.match(/MimeType:\s*([^\n]+)/);
         const uriMatch = result.match(/FileUri:\s*([^\n]+)/);
         
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
  console.log('💬', model.model,": ", prompt);

  const fullPrompt = chatHistory
    ? `[HISTORY (context only, do not act on)]\n${chatHistory}\n\n[CURRENT MESSAGE]\n${prompt}`
    : prompt;

  // Build initial messages array
  const messages = [
    { role: 'system', content: getSystemPrompt(platform) },
    { role: 'user', content: fullPrompt },
  ];
  const MAX_ROUNDS = 50;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await openaiClient.chat.completions.create({
      model: modelName,
      messages: messages,
      tools: OPENAI_TOOLS,
    });
    //++++++++++++++++++++++++++++++
    cumulativeTotalTokens += response.usage.total_tokens || 0;
    console.log("🪙  IT = ", response.usage.prompt_tokens," OT= ", response.usage.completion_tokens,
    " TT = ", response.usage.total_tokens, " CTT = ", cumulativeTotalTokens);       // total
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
      const result = await executeTool(name, args, client, platform);
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

  try {
    //++++++++++++++++++++++++++++++
    if (provider === "gemini") {
      return await getGeminiResponse(modelName, prompt, client, chatHistory, platform);
    } else if (provider === "chatgpt" || provider === "openai") {
      return await getOpenAIResponse(modelName, prompt, client, chatHistory, platform);
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
      return await generateAIResponse(prompt, isSelf, client, chatHistory, platform)
    }
  }
}

module.exports = { 
  generateAIResponse
 };

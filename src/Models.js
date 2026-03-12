function getAvailableModels() {
    return process.env.AI_FALLBACK_ORDER.split(',');
}

function getModel(model_number)  
{
    const models = getAvailableModels();
    
    if (model_number < 1 || model_number > models.length) {
        return null;
    }
    const model = models[model_number - 1];
    const parts = model.split(':');
    return parts.length > 1 ? parts[1].trim() : model.trim();
}

function getProvider(model_number)  {
    const models = getAvailableModels();
    
    if (model_number < 1 || model_number > models.length) {
        return null;
    }
    const model = models[model_number - 1];
    const provider = model.split(':')[0].toLowerCase();
    if (provider === 'gemini') return 'gemini';
    if (provider === 'openai' || provider === 'chatgpt') return 'openai';
    if (provider === 'anthropic' || provider === 'claude') return 'anthropic';
    return null; // fallback
}

function getType(model_number) 
{
    // reads the list of models ang return 0 if model is gemini, 1 in openai, 2 if anthropic
    const models = getAvailableModels();
    if (model_number < 1 || model_number > models.length) return 0;
    const model = models[model_number - 1];
    const provider = model.split(':')[0].toLowerCase();
    if (provider === 'gemini') return 0;
    if (provider === 'openai' || provider === 'chatgpt') return 1;
    if (provider === 'anthropic' || provider === 'claude') return 2;
    return 0; // fallback
}

const activeModel = {
    number:  null,
    type:    null,        // 0: gemini, 1: openai, 2: claude
    changed: false,
    model:    null,
    provider: null,
    set(model_number){
        if(model_number===0){
            this.number = 0;
            this.changed = true;
            
            return;
        }
        this.number = model_number;
        this.type = getType(model_number);
        this.changed = true;
        this.provider = getProvider(model_number);
        this.model = getModel(model_number);
    },
    setChanged(ichanged=true){
        this.changed = ichanged;
    }
};

activeModel.set(1);

function getActiveModel() {
    return activeModel;
}

function getModelsCount(){
    const models = getAvailableModels();
    return models.length
}

function activeModelFallback(){
    let model = getActiveModel();
    let mn = getModelsCount();
    let n = model.number;
    n += 1;
    if (n <= mn) model.set(n);
    else model.set(0);
}

function providerEmoji(provider) {
    if (provider === 'gemini') return '💎';
    if (provider === 'openai' || provider === 'chatgpt') return '🤖';
    if (provider === 'anthropic' || provider === 'claude') return '🧠';
    return '🤔';
}

function getCurrentModelInfo() {
    const m = getActiveModel();
    const entry = getAvailableModels()[m.number - 1] || getAvailableModels()[0];
    return `${providerEmoji(m.provider)} *Active:* \`${entry}\` (#${m.number})`;
}

function getAvailableModelsList() {
    const models = getAvailableModels();
    const active = getActiveModel().number;
    let r = '📋 *Models:*\n';
    models.forEach((m, i) => {
        const p = m.split(':')[0].toLowerCase();
        const tag = (i + 1) === active ? ' 🎯' : '';
        r += `${i + 1}. ${providerEmoji(p)} \`${m}\`${tag}\n`;
    });
    return r;
}

function resetToDefaultModel() {
    const m = getActiveModel();
    m.set(1);
    return `♻️ *Reset:* \`${m.model}\``;
}

function switchModelByNumber(targetNum) {
    const models = getAvailableModels();
    const m = getActiveModel();
    if (!isNaN(targetNum) && targetNum > 0 && targetNum <= models.length) {
        m.set(targetNum);
        return `✅ *Switched:* ${providerEmoji(m.provider)} \`${m.model}\``;
    }
    return `❌ Model #${targetNum} not found. Use \`/list models\``;
}

function printModelVariables() {
    const model = getActiveModel();
    let reply = `ModelNumber      =  ${model.number}\n`
    reply    += `ModelType        =  ${model.type}\n`
    reply    += `ModelChanged     =  ${model.changed}\n`
    reply    += `ModelProvider    =  ${model.provider}\n`
    reply    += `Model            =  ${model.model}\n`

    console.log(reply);
}

module.exports = { 
    getActiveModel,
    getAvailableModels,
    activeModelFallback,
    getCurrentModelInfo,
    getAvailableModelsList,
    resetToDefaultModel,
    switchModelByNumber,
    printModelVariables
};
const { GoogleGenAI } = require('@google/genai');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'secrets', '.env') });

async function detectModels() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error('❌ Error: GEMINI_API_KEY not found in secrets/.env');
        process.exit(1);
    }

    console.log('🔍 Detecting Gemini models...');
    const client = new GoogleGenAI({ apiKey });

    try {
        const modelsResult = await client.models.list();
        
        console.log('\n✅ Available Gemini Models (Detailed):');
        console.log('======================================');
        
        const allModels = [];
        for await (const model of modelsResult) {
            allModels.push(model);
            const methods = (model.supportedGenerationMethods || []).join(', ') || 'N/A';
            console.log(`- ${model.name}`);
            console.log(`  Title: ${model.displayName || 'N/A'}`);
            console.log(`  Methods: ${methods}`);
            console.log('----------------------------');
        }

        // --- COMPACT LISTING BY VERSION AND TYPE ---
        console.log('\n📦 Compact Summary (By Version & TYPE):');
        console.log('======================================');

        const groups = {
            'Latest Version': [],
            'Version 4.0': [],
            'Gemini 3.1': [],
            'Gemini 3.0 (3)': [],
            'Gemini 2.5': [],
            'Gemini 2.0': [],
            'Gemini 1.5': [],
            'Gemini 1.0': [],
            'Embedding': [],
            'Experimental': [],
            'AQA / Other': []
        };

        allModels.forEach(m => {
            const name = m.name.toLowerCase();
            const dName = (m.displayName || '').toLowerCase();
            const label = m.name.split('/').pop();

            if (name.includes('latest')) groups['Latest Version'].push(label);
            else if (name.includes('embedding')) groups['Embedding'].push(label);
            else if (name.includes('exp') || dName.includes('experimental')) groups['Experimental'].push(label);
            else if (name.includes('4.0')) groups['Version 4.0'].push(label);
            else if (name.includes('gemini-3.1')) groups['Gemini 3.1'].push(label);
            else if (name.includes('gemini-3')) groups['Gemini 3.0 (3)'].push(label);
            else if (name.includes('gemini-2.5')) groups['Gemini 2.5'].push(label);
            else if (name.includes('gemini-2.0')) groups['Gemini 2.0'].push(label);
            else if (name.includes('gemini-1.5')) groups['Gemini 1.5'].push(label);
            else if (name.includes('gemini-1.0') || name.includes('gemini-pro') || name.includes('gemini-ultra')) groups['Gemini 1.0'].push(label);
            else groups['AQA / Other'].push(label);
        });

        for (const [groupName, models] of Object.entries(groups)) {
            if (models.length > 0) {
                console.log(`\n🔹 ${groupName} (${models.length}):`);
                const sorted = models.sort();
                sorted.forEach(m => console.log(`  - ${m}`));
            }
        }

        console.log(`\n\nTotal models found: ${allModels.length}`);
    } catch (error) {
        console.error('❌ Error fetching Gemini models:', error.message);
        if (error.message.includes('API key not valid')) {
            console.error('👉 Please check your GEMINI_API_KEY in secrets/.env');
        }
    }
}

detectModels();

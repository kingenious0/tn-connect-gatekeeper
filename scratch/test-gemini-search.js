const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

async function run() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error('No GEMINI_API_KEY found in .env');
        return;
    }
    const genAI = new GoogleGenerativeAI(apiKey);
    try {
        console.log('Testing Google Search Grounding with gemini-2.5-flash...');
        const model = genAI.getGenerativeModel({
            model: 'gemini-2.5-flash',
            tools: [{ googleSearch: {} }]
        });
        
        const response = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: 'What is the latest NITA bill in Ghana passed in 2024 or recent times? Give me a super brief summary.' }] }]
        });
        
        console.log('Response:');
        console.log(response.response.text());
        
        // Check if grounding metadata exists in response
        const candidate = response.response.candidates?.[0];
        if (candidate?.groundingMetadata) {
            console.log('Grounding metadata found!');
            console.log('Web search queries:', candidate.groundingMetadata.webSearchQueries);
            console.log('Search entry point:', candidate.groundingMetadata.searchEntryPoint);
        } else {
            console.log('No grounding metadata (did not search or not returned in candidate).');
        }
    } catch (e) {
        console.error('Error during test:', e);
    }
}

run();

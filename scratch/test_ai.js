require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');

const geminiClient = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const groqClient = process.env.GROQ_API_KEY ? new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' }) : null;

async function testGroq() {
    if (!groqClient) {
        console.log('Groq: Client not initialized');
        return;
    }
    try {
        console.log('Testing Groq Llama 3.3 70B...');
        const response = await groqClient.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: 'Say hello in 3 words.' }],
            max_tokens: 50,
        });
        console.log('Groq Success:', response.choices[0]?.message?.content);
    } catch (err) {
        console.error('Groq Error:', err.message);
    }
}

async function testGemini() {
    if (!geminiClient) {
        console.log('Gemini: Client not initialized');
        return;
    }
    try {
        console.log('Testing Gemini 2.5 flash-lite...');
        const model = geminiClient.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
        const result = await model.generateContent('Say hello in 3 words.');
        console.log('Gemini Success:', result.response.text());
    } catch (err) {
        console.error('Gemini Error:', err.message);
    }
}

async function main() {
    await testGroq();
    await testGemini();
}

main();

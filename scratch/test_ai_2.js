require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const geminiClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function test(modelName) {
    try {
        console.log('Testing ' + modelName + '...');
        const model = geminiClient.getGenerativeModel({ model: modelName });
        const result = await model.generateContent('Say hello in 3 words.');
        console.log(modelName + ' Success:', result.response.text().trim());
    } catch (err) {
        console.error(modelName + ' Error:', err.message);
    }
}

async function main() {
    await test('gemini-2.5-flash');
    await test('gemini-2.5-flash-lite');
}

main();

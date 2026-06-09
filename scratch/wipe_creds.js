const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function run() {
    try {
        console.log('Deleting creds from bot_auth...');
        const { data, error } = await supabase.from('bot_auth').delete().eq('id', 'creds');
        if (error) throw error;
        console.log('Successfully wiped creds from Supabase bot_auth table! The bot will now generate a fresh QR code.');
    } catch (e) {
        console.error('Error:', e.message);
    }
}
run();

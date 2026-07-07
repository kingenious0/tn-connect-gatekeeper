const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function run() {
    try {
        console.log('Querying _config_active_convos...');
        const { data, error } = await supabase.from('gatekeeper_sessions').select('*').eq('phone', '_config_active_convos').maybeSingle();
        if (error) throw error;
        console.log('Active convos:', JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Error:', e.message);
    }
}
run();

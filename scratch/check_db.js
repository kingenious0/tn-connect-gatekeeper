const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function run() {
    try {
        console.log('Querying bot_auth...');
        const { data: authData, error: authError } = await supabase.from('bot_auth').select('*');
        if (authError) throw authError;
        console.log('bot_auth records:', JSON.stringify(authData, null, 2));

        console.log('Querying gatekeeper_sessions...');
        const { data: sessData, error: sessError } = await supabase.from('gatekeeper_sessions').select('*');
        if (sessError) throw sessError;
        console.log('gatekeeper_sessions records:', sessData.map(s => ({ phone: s.phone, admin_name: s.admin_name, role: s.role })));
    } catch (e) {
        console.error('Error:', e.message);
    }
}
run();

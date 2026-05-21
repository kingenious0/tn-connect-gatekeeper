-- Campus admin nodes for conversational broadcast (gatekeeper_sessions)
-- Run in Supabase SQL Editor, or POST /api/admins/seed-campus on the bot server.

INSERT INTO gatekeeper_sessions (phone, admin_name, role, updated_at)
VALUES
  ('233264579215', 'Yhaar Bhaby', 'admin_node', NOW()),
  ('233207924793', 'You mean to tell me', 'admin_node', NOW()),
  ('233246546818', 'TiLIe Nadis', 'admin_node', NOW()),
  ('233208282949', 'Manager For TN', 'admin_node', NOW()),
  ('233256921483', 'Easydata', 'admin_node', NOW()),
  ('233543091276', 'Capo(TN)', 'admin_node', NOW()),
  ('233552289454', 'Priscilla Coffie', 'admin_node', NOW()),
  ('233593950770', 'Elikem(TN)', 'admin_node', NOW()),
  ('233541948442', 'Roland Asareson Men...', 'admin_node', NOW()),
  ('233559965347', 'AKEedwin', 'admin_node', NOW()),
  ('233599994129', 'STEVO', 'admin_node', NOW()),
  ('233500200750', 'Jeff Bezzos', 'admin_node', NOW()),
  ('233540509751', 'Air Star', 'admin_node', NOW()),
  ('233597626090', 'Kingenious', 'admin_node', NOW()),
  ('233538719819', 'Mr.Gyan', 'admin_node', NOW()),
  ('233595802277', 'PROPHETIC BUSINESS', 'admin_node', NOW())
ON CONFLICT (phone)
DO UPDATE SET
  admin_name = EXCLUDED.admin_name,
  role = 'admin_node',
  updated_at = NOW();

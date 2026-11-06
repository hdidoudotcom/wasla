# Wasla code map

| Task | Start here | Notes |
|---|---|---|
| Database tables, RLS, permissions | supabase/schema.sql | workspaces, workspace_members (owner/admin/agent), workspace_settings, instagram_accounts (public part), instagram_tokens (server only), contacts, messages, rules, comment_replies (server only), event_log. Functions: wasla_create_workspace, wasla_record_message (server only), wasla_mark_read. tests/schema.test.mjs. |
| Instagram webhook, auto replies, OAuth connect, sending | supabase/functions/instagram/index.ts | One Edge Function, `verify_jwt=false`. `?webhook=1`: GET = Meta verification, POST = signed events (X-Hub-Signature-256). Other POSTs = app actions with the user's JWT: connect_url, connect, disconnect, send, status. Tokens refreshed when < 20 days remain. |
| Keyword matching, 24 h window, signature, webhook parsing | supabase/functions/instagram/model.js | Pure functions, tests/model.test.mjs. Graph API version in `GRAPH`. |
| App: sign in, business choice, inbox, rules, Instagram tab | app/index.html, app/app.js, app/app.css | Reads through RLS with supabase-js; Instagram actions through the Edge Function. Inbox polls every 10 s. UI in French for now. |
| Public config | app/config.js | Supabase URL + publishable key only. |
| Landing page | index.html | Link to /app/. |
| Hosting | netlify.toml | Static site, no build. |

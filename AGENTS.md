# Working on Wasla

**First read PROJECT_HISTORY.md** (what was built, rules, how to talk to the owner, open items). Then CODE_MAP.md.

- Wasla serves several businesses ("workspaces"). Every business table has `workspace_id` and RLS through `wasla_is_member` / `wasla_is_manager`. Never add a table or query that skips this.
- Instagram access tokens live only in `instagram_tokens` (service role). Never return them to the browser, never log them. `app/config.js` holds public configuration only.
- Use only the official Instagram API with Instagram Login. Never automate with passwords or scraping.
- Respect Instagram rules in code: replies only within 24 h of the customer's last message; one private reply per comment.
- Test what you change: `cd tests && npm ci && npm test` (model + database permission tests).
- MANDATORY, without being asked: after any feature, rule change, release or unfinished work, update PROJECT_HISTORY.md (timeline, rules, open items, "Last updated") and the affected CODE_MAP.md rows in the same session.
- Saving code is not permission to deploy. Deploy only when the owner says "deploy". Documentation-only commits include [skip netlify].

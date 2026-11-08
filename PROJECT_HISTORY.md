# Wasla project history

> Last updated: 2026-11-08.
>
> Every time you add a feature, change a rule, release something, or leave something unfinished, update this file in the same session: timeline (section 4), rules (section 5), open items (section 6), and "Last updated". Also update CODE_MAP.md. A task is not finished until this file reflects it.

## 1. The project in one minute

- **What:** Wasla (وصلة), our own ManyChat-like platform: automatic replies to Instagram private messages and comments, plus a shared inbox. Built for several businesses; **KLINOVA (klinova.ma, repository hdidoudotcom/klin-ma) is the first client** and the test account.
- **Owner:** the KLINOVA owner. Non-technical. **Always answer in Darija written in Arabic script.** Explain simply before coding; wait for approval on substantive choices.
- **Stack:** plain HTML/CSS/ES modules (no build), Netlify hosting, a separate Supabase project for Wasla (not the KLINOVA project): **`wasla`, ref `vdrgtkirvbdrvlqwbixp`**, organization KLIN (free plan), region eu-west-1.

## 2. How to work with this owner

1. Explain simply before coding, no jargon.
2. Never deploy until the owner says "deploy".
3. Show results with screenshots (Playwright with mocked Supabase).
4. Never put secrets in the repository. Never automate Instagram with passwords or scraping.

## 3. Setup (one time, not done yet)

1. ✅ 2026-11-06 **Supabase project `wasla`** (`vdrgtkirvbdrvlqwbixp`, free plan, $0) created; `supabase/schema.sql` applied as migration `wasla_initial_schema`; `app/config.js` filled. Edge Function `instagram` v1 deployed (`verify_jwt=false`), inert until the secrets of step 3 exist. Still to do: Auth → URL configuration: Site URL and redirect `https://<wasla domain>/app/` (after the Netlify site exists).
2. **Meta developer app** at developers.facebook.com: create an app (type Business), add the product **Instagram → API setup with Instagram login**.
   - Note the **Instagram app ID** and **Instagram app secret**.
   - Business login settings → OAuth redirect URI: `https://<wasla domain>/app/` (exactly the value of `WASLA_APP_URL`).
   - Webhooks: callback URL `https://<project>.supabase.co/functions/v1/instagram?webhook=1`, verify token = `IG_VERIFY_TOKEN`; subscribe to `messages` and `comments`.
   - App roles → add the KLINOVA Instagram account as an **Instagram tester** and accept the invitation in Instagram (Settings → Website permissions / Apps and websites). Until App Review, only accounts with a role on the app work.
3. **Edge Function secrets:** `IG_APP_ID`, `IG_APP_SECRET`, `IG_VERIFY_TOKEN` (random), `WASLA_APP_URL`. Redeploy `instagram` (`verify_jwt=false`) whenever its files change.
4. ✅ 2026-11-08 **Netlify site `wasla-ma`** created (id `b3cc15b6-4479-4683-adcc-69106f2331b1`, team hdidoudotcom, URL https://wasla-ma.netlify.app; the names `wasla` and `wasla-app` were taken). `app/config.js` already filled. **Not deployed yet**: the first deploy needs the owner's explicit "deploy". Linking the site to the GitHub repo for automatic deploys is done in the Netlify UI.
5. Open `/app/`, create an account, create the business, Instagram tab → Connect.

## 4. Timeline

| Date | What | Files |
|---|---|---|
| 2026-11-06 | Owner request: ManyChat-like Instagram automation as a separate multi-business platform, name chosen: Wasla. First version written (not deployed): businesses + members with roles, Instagram connection (OAuth, long-lived token, auto refresh), webhook (signed), keyword rules for private messages and comments (one private reply per comment, optional public reply), fallback rules, 6 h anti-repeat per rule and person, pause after a human reply, shared inbox with 24 h reply window, activity log. Tests: model + database permissions. | supabase/schema.sql, supabase/functions/instagram/, app/, tests/ |
| 2026-11-08 | Netlify site `wasla-ma` created (empty, not deployed). | — |
| 2026-11-06 | Supabase project `wasla` created (free), schema applied (`wasla_initial_schema`), `instagram` Edge Function v1 deployed, app config filled. Security advisor: only expected notices (server-only tables without policies; RPCs callable by signed-in users on purpose). | app/config.js |

## 5. Rules you must not break

- Each business sees only its own data (RLS on `workspace_id`). Managers (owner/admin) change rules and settings; agents read and reply.
- Instagram tokens stay server-side (`instagram_tokens`, service role only).
- One Instagram account can be connected to one business only.
- Replies only within 24 h of the customer's last private message (a comment does not open that window). One private reply per comment.
- Automatic replies stay quiet for `human_pause_minutes` after a person replies (from Wasla or the Instagram app). The same rule answers the same person at most once every 6 hours.

## 6. Open items

- Setup of section 3 still to do: first Netlify deploy (waiting for "deploy"), Meta app, Edge Function secrets, Supabase Auth URLs (`https://wasla-ma.netlify.app/app/`), domain. Ask the owner before creating paid resources.
- Supabase's built-in e-mail sender is limited to a few sign-up e-mails per hour; add a custom SMTP before real businesses sign up.
- **App Review + Meta Business Verification** are required before businesses other than testers can connect (permissions `instagram_business_manage_messages`, `instagram_business_manage_comments`; Meta asks for a screencast).
- Not built yet: Arabic interface (UI is French), inviting team members to a business, password reset page, rules for a specific post chosen from a list (column `rules.media_id` exists, no UI), quick-reply buttons, subscriptions/billing, WhatsApp.
- Echo handling waits 3 s so Wasla's own sent copy is saved first; if Instagram's echo arrives earlier, an automatic reply could be shown as "App Instagram" and pause automation. Watch for it in real use.
- The GitHub repository is public; consider making it private.

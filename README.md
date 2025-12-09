# ZXRP Dashboard - Full (Railway ready)

This repo contains a ready-to-deploy dashboard for your Discord server.

## Features
- Discord OAuth login (passport-discord)
- Interview application form + accept/reject
- Ticket system (create/close) + create by bot command
- Auto-role on join
- Welcome message config
- Moderation (ban/kick via commands)
- Logs to a channel via BOT_TOKEN
- Prefix change via settings

## Deploy
1. Upload to GitHub and connect to Railway, OR upload files to Railway.
2. Add environment variables (CLIENT_ID, CLIENT_SECRET, CALLBACK_URL, BOT_TOKEN, LOG_CHANNEL_ID, SESSION_SECRET, BASE_URL)
3. Start command: `node index.js`

## Notes
- Replace BOT_TOKEN placeholder in Railway variables with your bot token (do not commit secrets to GitHub)
- DB stored in `db.json` (lowdb)

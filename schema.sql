ABUM Cloudflare migration starter

Current HTML endpoints now target same-origin /api/<handler>. The Pages Function dispatches those requests to the carried-over handler logic.
Use D1 binding name DB. Secret MAIN_APP_BOT_TOKEN and variable ABUM_ADMIN_IDS must be configured in Cloudflare Pages.
Do not switch the main Telegram bot URL until you have verified the new URL and dealt with old-player data migration.

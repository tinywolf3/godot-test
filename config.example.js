// Public defaults shipped with the web build / GitHub Pages.
// For local overrides, copy to godot/web/config.js (gitignored) — export_web.sh
// copies it next to index.html but builds/web/.gitignore keeps it out of deploy.
window.GUILD_HOME_CONFIG = {
	GOOGLE_CLIENT_ID: '',
	DISCORD_CLIENT_ID: '',
	// Defaults to API_BASE + /auth/discord/callback when empty.
	DISCORD_REDIRECT_URI: '',
	WS_URL: 'ws://127.0.0.1:8787/ws',
	API_BASE: 'http://127.0.0.1:8787',
	WIDGETBOT_SERVER_ID: '',
	WIDGETBOT_CHANNEL_ID: '',
};

/**
 * Auth + chat panel state machine for the Godot web shell.
 * States: unauth | profile_setup | google_chat | discord_widget
 */
(function () {
	'use strict';

	const STORAGE_KEY = 'guildhome.auth.profile';
	const DEFAULT_AVATAR =
		'data:image/svg+xml,' +
		encodeURIComponent(
			'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect fill="#2a2e38" width="64" height="64"/><circle cx="32" cy="24" r="12" fill="#5a6578"/><ellipse cx="32" cy="56" rx="20" ry="14" fill="#5a6578"/></svg>'
		);

	const cfg = Object.assign(
		{
			GOOGLE_CLIENT_ID: '',
			DISCORD_CLIENT_ID: '',
			DISCORD_REDIRECT_URI: '',
			WS_URL: 'ws://127.0.0.1:8787/ws',
			API_BASE: 'http://127.0.0.1:8787',
			WIDGETBOT_SERVER_ID: '',
			WIDGETBOT_CHANNEL_ID: '',
		},
		typeof window.GUILD_HOME_CONFIG === 'object' && window.GUILD_HOME_CONFIG
			? window.GUILD_HOME_CONFIG
			: {}
	);

	let state = 'unauth';
	let profile = null; // { provider, email, nickname, avatar_url }
	let pendingProvider = null;
	let ws = null;
	let godotAuthCb = null;
	const pendingAuthQueue = [];

	const panel = () => document.getElementById('chat-panel');

	function loadStoredProfile() {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) return null;
			const p = JSON.parse(raw);
			if (p && p.nickname && p.provider) return p;
		} catch (_) {
			/* ignore */
		}
		return null;
	}

	function saveProfile(p) {
		profile = p;
		localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
		notifyGodot(p);
	}

	function clearProfile() {
		profile = null;
		localStorage.removeItem(STORAGE_KEY);
		disconnectWs();
	}

	function notifyGodot(p) {
		const payload = JSON.stringify(p);
		if (typeof window.godotAuthCallback === 'function' && window.godotAuthCallback !== queueAuth) {
			try {
				window.godotAuthCallback(payload);
				return;
			} catch (err) {
				console.warn('godotAuthCallback failed', err);
			}
		}
		if (godotAuthCb) {
			try {
				godotAuthCb(payload);
				return;
			} catch (err) {
				console.warn('godot auth cb failed', err);
			}
		}
		pendingAuthQueue.push(payload);
	}

	function queueAuth(payload) {
		pendingAuthQueue.push(String(payload));
	}

	// Godot registers via __godotAuthReady(cb); until then queue callbacks.
	window.godotAuthCallback = queueAuth;
	window.__godotAuthReady = function (cb) {
		godotAuthCb = cb;
		window.godotAuthCallback = function (payload) {
			try {
				cb(payload);
			} catch (err) {
				console.warn(err);
			}
		};
		while (pendingAuthQueue.length) {
			window.godotAuthCallback(pendingAuthQueue.shift());
		}
	};

	function showView(name) {
		const root = panel();
		if (!root) return;
		root.querySelectorAll('.ac-view').forEach((el) => {
			el.classList.toggle('is-active', el.dataset.view === name);
		});
		state = name;
	}

	function renderState(name, userData) {
		if (userData) profile = userData;
		switch (name) {
			case 'unauth':
				showView('unauth');
				refreshUnauthButtons();
				break;
			case 'profile_setup':
				showView('profile_setup');
				fillSetupForm();
				break;
			case 'google_chat':
				showView('google_chat');
				fillComposer();
				connectWs();
				break;
			case 'discord_widget':
				showView('discord_widget');
				mountWidgetBot();
				break;
			default:
				showView('unauth');
		}
	}

	function refreshUnauthButtons() {
		const googleBtn = document.getElementById('ac-btn-google');
		const discordBtn = document.getElementById('ac-btn-discord');
		if (googleBtn) {
			const ok = Boolean(cfg.GOOGLE_CLIENT_ID);
			googleBtn.disabled = !ok;
			googleBtn.title = ok ? '' : 'config.js에 GOOGLE_CLIENT_ID가 필요합니다';
		}
		if (discordBtn) {
			const ok = Boolean(cfg.DISCORD_CLIENT_ID);
			discordBtn.disabled = !ok;
			discordBtn.title = ok ? '' : 'config.js에 DISCORD_CLIENT_ID가 필요합니다';
		}
	}

	function fillSetupForm() {
		const nick = document.getElementById('ac-setup-nick');
		const img = document.getElementById('ac-setup-avatar');
		if (nick) nick.value = (profile && profile.nickname) || '';
		if (img) img.src = (profile && profile.avatar_url) || DEFAULT_AVATAR;
	}

	function fillComposer() {
		const nick = document.getElementById('ac-composer-nick');
		const img = document.getElementById('ac-composer-avatar');
		if (nick) nick.textContent = (profile && profile.nickname) || 'Guest';
		if (img) img.src = (profile && profile.avatar_url) || DEFAULT_AVATAR;
	}

	function mountWidgetBot() {
		const wrap = document.getElementById('ac-widget-wrap');
		const fallback = document.getElementById('ac-widget-fallback');
		if (!wrap || !fallback) return;
		wrap.innerHTML = '';
		const serverId = cfg.WIDGETBOT_SERVER_ID;
		const channelId = cfg.WIDGETBOT_CHANNEL_ID;
		if (!serverId || !channelId) {
			fallback.style.display = 'flex';
			wrap.style.display = 'none';
			return;
		}
		fallback.style.display = 'none';
		wrap.style.display = 'block';
		const iframe = document.createElement('iframe');
		iframe.src = `https://e.widgetbot.io/channels/${serverId}/${channelId}`;
		iframe.allow = 'clipboard-write; fullscreen';
		iframe.title = 'Discord WidgetBot';
		wrap.appendChild(iframe);
	}

	function appendMessage(msg) {
		const list = document.getElementById('ac-messages');
		if (!list) return;
		const row = document.createElement('div');
		row.className = 'ac-msg';
		const img = document.createElement('img');
		img.src = msg.avatar_url || DEFAULT_AVATAR;
		img.alt = '';
		const body = document.createElement('div');
		body.className = 'ac-msg-body';
		const nick = document.createElement('div');
		nick.className = 'ac-msg-nick';
		nick.textContent = msg.nickname || 'anon';
		const text = document.createElement('div');
		text.className = 'ac-msg-text';
		text.textContent = msg.text || '';
		body.appendChild(nick);
		body.appendChild(text);
		row.appendChild(img);
		row.appendChild(body);
		list.appendChild(row);
		list.scrollTop = list.scrollHeight;
	}

	function setWsStatus(on) {
		const dot = document.getElementById('ac-ws-dot');
		if (dot) dot.classList.toggle('is-on', on);
	}

	function disconnectWs() {
		if (ws) {
			try {
				ws.close();
			} catch (_) {
				/* ignore */
			}
			ws = null;
		}
		setWsStatus(false);
	}

	function connectWs() {
		disconnectWs();
		if (!cfg.WS_URL) return;
		try {
			ws = new WebSocket(cfg.WS_URL);
		} catch (err) {
			console.warn('WebSocket connect failed', err);
			appendMessage({
				nickname: 'system',
				text: 'WebSocket 연결 실패 — server를 실행하거나 WS_URL을 확인하세요.',
				avatar_url: DEFAULT_AVATAR,
			});
			return;
		}
		ws.addEventListener('open', () => {
			setWsStatus(true);
			appendMessage({
				nickname: 'system',
				text: '채팅 서버에 연결되었습니다.',
				avatar_url: DEFAULT_AVATAR,
			});
		});
		ws.addEventListener('close', () => setWsStatus(false));
		ws.addEventListener('error', () => setWsStatus(false));
		ws.addEventListener('message', (ev) => {
			try {
				const data = JSON.parse(ev.data);
				if (data.type === 'system') {
					appendMessage({
						nickname: 'system',
						avatar_url: DEFAULT_AVATAR,
						text: data.text || '',
					});
					return;
				}
				if (data.type === 'chat' || data.text) {
					appendMessage({
						nickname: data.nickname || 'anon',
						avatar_url: data.avatar_url || DEFAULT_AVATAR,
						text: data.text || '',
					});
				}
			} catch (_) {
				appendMessage({ nickname: 'server', text: String(ev.data), avatar_url: DEFAULT_AVATAR });
			}
		});
	}

	function sendChat(text) {
		const trimmed = String(text || '').trim();
		if (!trimmed || !profile) return;
		const payload = {
			type: 'chat',
			provider: profile.provider,
			email: profile.email || '',
			nickname: profile.nickname,
			avatar_url: profile.avatar_url || '',
			text: trimmed,
		};
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(payload));
		} else {
			// Local echo when server is down.
			appendMessage(payload);
		}
	}

	function beginProfileSetup(partial) {
		pendingProvider = partial.provider;
		profile = {
			provider: partial.provider,
			email: partial.email || '',
			nickname: partial.nickname || 'Player',
			avatar_url: partial.avatar_url || DEFAULT_AVATAR,
		};
		renderState('profile_setup', profile);
	}

	function finishProfileSetup() {
		const nickEl = document.getElementById('ac-setup-nick');
		const nickname = (nickEl && nickEl.value.trim()) || (profile && profile.nickname) || 'Player';
		const saved = {
			provider: (profile && profile.provider) || pendingProvider || 'google',
			email: (profile && profile.email) || '',
			nickname,
			avatar_url: (profile && profile.avatar_url) || DEFAULT_AVATAR,
		};
		saveProfile(saved);
		if (saved.provider === 'discord') {
			renderState('discord_widget', saved);
		} else {
			renderState('google_chat', saved);
		}
	}

	function mockLogin(provider) {
		beginProfileSetup({
			provider,
			email: provider === 'google' ? 'mock@gmail.com' : 'mock@discord.local',
			nickname: provider === 'google' ? 'GoogleMock' : 'DiscordMock',
			avatar_url: DEFAULT_AVATAR,
		});
	}

	function startGoogleLogin() {
		if (!cfg.GOOGLE_CLIENT_ID) return;
		// GIS One Tap / button flow — requires real client id.
		if (window.google && google.accounts && google.accounts.id) {
			google.accounts.id.initialize({
				client_id: cfg.GOOGLE_CLIENT_ID,
				callback: (resp) => {
					try {
						const payload = JSON.parse(atob(resp.credential.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
						beginProfileSetup({
							provider: 'google',
							email: payload.email || '',
							nickname: payload.name || payload.email || 'GoogleUser',
							avatar_url: payload.picture || DEFAULT_AVATAR,
						});
					} catch (err) {
						console.error(err);
						alert('Google 로그인 파싱에 실패했습니다.');
					}
				},
			});
			google.accounts.id.prompt();
		} else {
			alert('Google Identity Services가 로드되지 않았습니다. 네트워크를 확인하세요.');
		}
	}

	async function startDiscordLogin() {
		if (!cfg.DISCORD_CLIENT_ID) return;
		const redirect =
			cfg.DISCORD_REDIRECT_URI || `${cfg.API_BASE.replace(/\/$/, '')}/auth/discord/callback`;
		const state = Array.from(crypto.getRandomValues(new Uint8Array(16)))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		const params = new URLSearchParams({
			client_id: cfg.DISCORD_CLIENT_ID,
			response_type: 'code',
			redirect_uri: redirect,
			scope: 'identify email',
			state,
		});
		const url = `https://discord.com/api/oauth2/authorize?${params.toString()}`;
		const popup = window.open(url, 'discord_oauth', 'width=520,height=720');
		if (!popup) {
			alert('팝업이 차단되었습니다. 팝업을 허용해 주세요.');
			return;
		}
		const onMsg = (ev) => {
			if (!ev.data || ev.data.type !== 'discord_oauth') return;
			window.removeEventListener('message', onMsg);
			if (ev.data.error) {
				alert('Discord 로그인 실패: ' + ev.data.error);
				return;
			}
			const u = ev.data.user || {};
			beginProfileSetup({
				provider: 'discord',
				email: u.email || '',
				nickname: u.username || u.global_name || 'DiscordUser',
				avatar_url: u.avatar_url || DEFAULT_AVATAR,
			});
		};
		window.addEventListener('message', onMsg);
	}

	function logout() {
		clearProfile();
		const list = document.getElementById('ac-messages');
		if (list) list.innerHTML = '';
		renderState('unauth');
	}

	function bindEvents() {
		document.getElementById('ac-btn-google')?.addEventListener('click', startGoogleLogin);
		document.getElementById('ac-btn-discord')?.addEventListener('click', startDiscordLogin);
		document.getElementById('ac-btn-mock-google')?.addEventListener('click', () => mockLogin('google'));
		document.getElementById('ac-btn-mock-discord')?.addEventListener('click', () => mockLogin('discord'));
		document.getElementById('ac-setup-save')?.addEventListener('click', finishProfileSetup);
		document.getElementById('ac-setup-cancel')?.addEventListener('click', logout);
		document.getElementById('ac-link-discord')?.addEventListener('click', () => {
			if (cfg.DISCORD_CLIENT_ID) startDiscordLogin();
			else mockLogin('discord');
		});
		document.getElementById('ac-logout-google')?.addEventListener('click', logout);
		document.getElementById('ac-logout-discord')?.addEventListener('click', logout);
		const form = document.getElementById('ac-composer-form');
		form?.addEventListener('submit', (ev) => {
			ev.preventDefault();
			const input = document.getElementById('ac-composer-input');
			if (!input) return;
			sendChat(input.value);
			input.value = '';
		});
	}

	function boot() {
		if (!panel()) return;
		bindEvents();
		const stored = loadStoredProfile();
		if (stored) {
			profile = stored;
			notifyGodot(stored);
			if (stored.provider === 'discord') renderState('discord_widget', stored);
			else renderState('google_chat', stored);
		} else {
			renderState('unauth');
		}
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot);
	} else {
		boot();
	}

	window.GuildHomeAuthChat = { renderState, notifyGodot, cfg };
})();

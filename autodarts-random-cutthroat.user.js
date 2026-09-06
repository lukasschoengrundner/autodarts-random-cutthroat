// ==UserScript==
// @name         Autodarts Random Cutthroat Cricket
// @namespace    https://github.com/lukasschoengrundner/autodarts-random-cutthroat
// @version      0.2.0
// @description  Random Cutthroat Cricket overlay for Autodarts. 7 random targets, Bull always/never/random, local Board Manager scoring.
// @author       Lukas Schöngrundner
// @match        https://play.autodarts.com/*
// @match        https://play.autodarts.io/*
// @updateURL    https://raw.githubusercontent.com/lukasschoengrundner/autodarts-random-cutthroat/main/autodarts-random-cutthroat.user.js
// @downloadURL  https://raw.githubusercontent.com/lukasschoengrundner/autodarts-random-cutthroat/main/autodarts-random-cutthroat.user.js
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const APP_ID = 'ad-rcc';
  const STORAGE_KEY = 'autodarts-random-cutthroat:v1';
  const DEFAULT_BOARD_HOST = 'http://localhost:3180';
  const VERSION = '0.2.0';
  const MARKS = ['–', '/', 'X', '⊗'];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const defaultState = () => ({
    schemaVersion: 2, screen: 'setup', bullMode: 'random', targetCount: 7, targets: [],
    players: [1, 2].map((i) => ({ name: `Spieler ${i}`, marks: {}, score: 0 })),
    currentPlayer: 0, turnDarts: 0, turnSerial: 0, winner: null,
    boardHost: DEFAULT_BOARD_HOST, inputMode: 'board', connected: false,
    boardGate: 'await-empty', visit: null, legacyVisit: false, minimized: false, notice: '',
  });

  let state = loadState();
  let socket = null;
  let reconnectTimer = null;
  let renderQueued = false;
  let lastBoard = null;
  let takingOut = false;
  let connectionStatus = 'Nicht verbunden';
  let lastEvent = 'Noch keine Board-Meldung';
  let storageWarning = '';
  let resetHandled = false;

  function validPlayers(players) {
    return Array.isArray(players) && players.length >= 2 && players.length <= 8
      && players.every((p) => p && typeof p.name === 'string' && p.marks && typeof p.marks === 'object'
        && Number.isFinite(p.score) && p.score >= 0
        && Object.values(p.marks).every((m) => Number.isInteger(m) && m >= 0 && m <= 3));
  }

  function loadState() {
    const base = defaultState();
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved || !validPlayers(saved.players)) return base;
      const loaded = { ...base, ...saved, connected: false, schemaVersion: 2 };
      loaded.inputMode = saved.inputMode === 'test' ? 'test' : 'board';
      loaded.boardHost = typeof saved.boardHost === 'string' ? saved.boardHost : DEFAULT_BOARD_HOST;
      if (saved.schemaVersion !== 2 && (!saved.boardHost || saved.boardHost === 'autodarts.local')) {
        loaded.boardHost = DEFAULT_BOARD_HOST;
        loaded.notice = 'Die bisherige Standardadresse wurde auf diesen PC (localhost) umgestellt.';
      }
      loaded.bullMode = ['always', 'never', 'random'].includes(saved.bullMode) ? saved.bullMode : 'random';
      loaded.targetCount = 7;
      const validGame = Array.isArray(saved.targets) && saved.targets.length === 7
        && new Set(saved.targets).size === 7 && saved.targets.every((n) => Number.isInteger(n) && ((n >= 1 && n <= 20) || n === 25))
        && Number.isInteger(saved.currentPlayer) && saved.currentPlayer >= 0 && saved.currentPlayer < saved.players.length
        && (saved.winner === null || (Number.isInteger(saved.winner) && saved.winner >= 0 && saved.winner < saved.players.length));
      if (saved.screen !== 'game' || !validGame) {
        loaded.screen = 'setup';
        loaded.visit = null;
        loaded.winner = null;
        loaded.currentPlayer = 0;
        loaded.turnDarts = 0;
      } else if (saved.schemaVersion !== 2 || !validVisit(saved.visit, saved.players.length, saved.currentPlayer)) {
        // A 0.1 game has no pre-visit snapshot: keep scores, but never guess its missing darts.
        loaded.visit = null;
        loaded.legacyVisit = true;
        loaded.notice = 'Spielstand übernommen. Diese alte Aufnahme kann nicht rekonstruiert werden: Aufnahme abschließen oder ein neues Spiel starten.';
      }
      loaded.boardGate = loaded.screen === 'game' ? 'sync' : 'await-empty';
      if (saved.schemaVersion === 2 && saved.boardGate === 'finished' && loaded.winner !== null) loaded.boardGate = 'finished';
      if (loaded.inputMode === 'test' && loaded.visit) loaded.boardGate = 'ready';
      delete loaded.history;
      delete loaded.lastProcessedFingerprint;
      return loaded;
    } catch (error) {
      console.warn('[Random Cutthroat] Could not load state', error);
      base.notice = 'Gespeicherter Spielstand konnte nicht geladen werden.';
      return base;
    }
  }

  function validVisit(visit, playerCount, playerIndex) {
    return visit && validPlayers(visit.base?.players) && visit.base.players.length === playerCount
      && visit.base.currentPlayer === playerIndex && Array.isArray(visit.throws) && visit.throws.length <= 3
      && visit.throws.every((s) => normalizeSegment(s)) && visit.overrides && typeof visit.overrides === 'object'
      && Object.entries(visit.overrides).every(([i, s]) => /^\d$/.test(i) && Number(i) < visit.throws.length && (s === null || normalizeSegment(s)));
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, connected: false }));
      storageWarning = '';
    } catch (error) {
      storageWarning = 'Spielstand kann nicht gespeichert werden. Dieses Browserfenster geöffnet lassen.';
      console.warn('[Random Cutthroat] Could not save state', error);
    }
  }

  function update() { saveState(); render(); }
  function shuffle(values) {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
  function generateTargets(mode = state.bullMode, count = 7) {
    const numbers = Array.from({ length: 20 }, (_, i) => i + 1);
    const targets = mode === 'always' ? [...shuffle(numbers).slice(0, count - 1), 25]
      : shuffle(mode === 'never' ? numbers : [...numbers, 25]).slice(0, count);
    return targets.sort((a, b) => a - b);
  }
  function targetLabel(target) { return target === 25 ? 'BULL' : String(target); }
  function targetValue(target) { return target; }
  function getMarks(player, target) { return Math.max(0, Math.min(3, Number(player.marks?.[target] || 0))); }
  function allClosed(player) { return state.targets.length > 0 && state.targets.every((t) => getMarks(player, t) === 3); }
  function checkWinner(playerIndex) {
    const player = state.players[playerIndex];
    if (player && allClosed(player) && state.players.every((other) => player.score <= other.score)) {
      state.winner = playerIndex;
      return true;
    }
    return false;
  }

  function normalizeSegment(segment) {
    if (!segment || typeof segment !== 'object') return null;
    let number;
    let multiplier;
    if (segment.number != null && segment.multiplier != null && segment.number !== '' && segment.multiplier !== '') {
      if (!['number', 'string'].includes(typeof segment.number) || !['number', 'string'].includes(typeof segment.multiplier)) return null;
      number = Number(segment.number);
      multiplier = Number(segment.multiplier);
    } else {
      const name = String(segment.name || '').toUpperCase().trim();
      const bull = { BULL: 1, SB: 1, SBULL: 1, BULLSEYE: 2, DB: 2, DBULL: 2 };
      const match = /^([SDT])(\d{1,2})$/.exec(name);
      if (Object.hasOwn(bull, name)) { number = 25; multiplier = bull[name]; }
      else if (['MISS', 'M0', 'S0', 'OUTSIDE'].includes(name)) { number = 0; multiplier = 0; }
      else if (match) { number = Number(match[2]); multiplier = { S: 1, D: 2, T: 3 }[match[1]]; }
      else return null;
    }
    if (!Number.isInteger(number) || !Number.isInteger(multiplier)) return null;
    if (number === 0 && multiplier === 0) return { number: 0, multiplier: 0, name: 'MISS' };
    if (!((number >= 1 && number <= 20) || number === 25) || multiplier < 1 || multiplier > (number === 25 ? 2 : 3)) return null;
    return { number, multiplier, name: `${['', 'S', 'D', 'T'][multiplier]}${number}` };
  }

  function beginVisit() {
    state.visit = { base: { players: clone(state.players), currentPlayer: state.currentPlayer }, throws: [], overrides: {} };
    state.turnDarts = 0;
    state.legacyVisit = false;
  }
  function effectiveThrow(index) {
    return Object.hasOwn(state.visit.overrides, index) ? state.visit.overrides[index] : state.visit.throws[index];
  }
  function scoreSegment(segment) {
    if (!segment || state.winner !== null || !state.targets.includes(segment.number)) return;
    const player = state.players[state.currentPlayer];
    const total = getMarks(player, segment.number) + segment.multiplier;
    player.marks[segment.number] = Math.min(3, total);
    const penalty = Math.max(0, total - 3) * targetValue(segment.number);
    state.players.forEach((opponent, i) => {
      if (i !== state.currentPlayer && getMarks(opponent, segment.number) < 3) opponent.score += penalty;
    });
    checkWinner(state.currentPlayer);
  }
  function replayVisit() {
    state.players = clone(state.visit.base.players);
    state.currentPlayer = state.visit.base.currentPlayer;
    state.winner = null;
    state.turnDarts = state.visit.throws.length;
    state.visit.throws.forEach((_, i) => scoreSegment(effectiveThrow(i)));
  }
  function reconcileVisit(throws) {
    if (!state.visit) beginVisit();
    // Local corrections survive duplicate snapshots, but a changed board slot supersedes them.
    for (const key of Object.keys(state.visit.overrides)) {
      if (!throws[key] || JSON.stringify(throws[key]) !== JSON.stringify(state.visit.throws[key])) delete state.visit.overrides[key];
    }
    state.visit.throws = clone(throws);
    replayVisit();
  }
  function processThrow(segment, source = 'test') {
    if (source !== 'test' || state.inputMode !== 'test' || state.screen !== 'game' || state.legacyVisit || state.winner !== null || state.turnDarts >= 3) return;
    const normalized = normalizeSegment(segment);
    if (!normalized) return;
    if (!state.visit) beginVisit();
    state.visit.throws.push(normalized);
    replayVisit();
    update();
  }
  function nextPlayer() {
    if (state.screen !== 'game' || state.winner !== null) return;
    // A manual change waits for the physical takeout; repeated clicks cannot skip players.
    if (state.inputMode === 'board' && state.boardGate === 'await-empty') return;
    state.currentPlayer = (state.currentPlayer + 1) % state.players.length;
    state.turnSerial += 1;
    beginVisit();
    state.boardGate = state.inputMode === 'board' ? 'await-empty' : 'ready';
    state.notice = '';
    update();
  }
  function undo() {
    if (state.screen !== 'game' || !state.visit || state.legacyVisit || state.boardGate === 'finished') return;
    if (state.inputMode === 'test') {
      state.visit.throws.pop();
      delete state.visit.overrides[state.visit.throws.length];
    }
    else {
      if (state.boardGate !== 'ready' || takingOut) return;
      const index = state.visit.throws.findLastIndex((_, i) => effectiveThrow(i) !== null);
      if (index < 0) return;
      // Keep the physical slot occupied so the next snapshot cannot add this dart again.
      state.visit.overrides[index] = null;
    }
    replayVisit();
    update();
  }
  function correctThrow(index, value) {
    if (!state.visit || state.legacyVisit || state.boardGate !== 'ready' || takingOut || !Number.isInteger(index) || index < 0 || index >= state.visit.throws.length) return;
    if (value === 'board') delete state.visit.overrides[index];
    else {
      const segment = value === 'ignore' ? null : normalizeSegment({ name: value });
      if (segment === null && value !== 'ignore') return;
      state.visit.overrides[index] = segment;
    }
    replayVisit();
    update();
  }
  function startGame() {
    const inputs = [...document.querySelectorAll(`#${APP_ID}-player-list input[data-player-name]`)];
    if (inputs.length < 2 || inputs.length > 8) return;
    state.players = inputs.map((input, i) => ({ name: input.value.trim() || `Spieler ${i + 1}`, marks: {}, score: 0 }));
    state.targets = generateTargets();
    state.currentPlayer = 0;
    state.turnSerial = 0;
    state.winner = null;
    state.screen = 'game';
    state.notice = '';
    beginVisit();
    state.boardGate = state.inputMode === 'board' ? 'await-empty' : 'ready';
    takingOut = false;
    if (state.inputMode === 'board') connectBoard(true);
    else disconnectBoard();
    update();
  }
  function newGame() {
    state.screen = 'setup';
    state.winner = null;
    state.visit = null;
    state.turnDarts = 0;
    state.legacyVisit = false;
    state.notice = '';
    state.boardGate = 'await-empty';
    update();
  }
  function addPlayer() {
    if (state.players.length >= 8) return;
    state.players.push({ name: `Spieler ${state.players.length + 1}`, marks: {}, score: 0 });
    update();
  }
  function removePlayer() { if (state.players.length > 2) { state.players.pop(); update(); } }

  function boardWsUrl() {
    const raw = String(state.boardHost || DEFAULT_BOARD_HOST).trim();
    const explicit = /^[a-z][a-z\d+.-]*:\/\//i.test(raw);
    const authority = (explicit ? raw.slice(raw.indexOf('://') + 3) : raw).split(/[/?#]/)[0];
    const explicitPort = /:(\d+)$/.exec(authority)?.[1];
    const url = new URL(explicit ? raw : `http://${raw}`);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Bitte eine HTTP-, HTTPS-, WS- oder WSS-Adresse ohne Zugangsdaten eingeben.');
    if (!explicit) url.protocol = url.port === '3181' ? 'https:' : 'http:';
    const secure = ['https:', 'wss:'].includes(url.protocol);
    url.protocol = secure ? 'wss:' : 'ws:';
    if (explicitPort) url.port = explicitPort;
    else if (!url.port) url.port = secure ? '3181' : '3180';
    if (!['/', '/api/events', '/api/events/'].includes(url.pathname)) throw new Error('Bitte nur die Board-Adresse oder /api/events angeben.');
    url.pathname = '/api/events';
    url.search = '?type=state';
    return url.toString();
  }
  function disconnectBoard() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const previous = socket;
    socket = null; // Invalidate handlers before asynchronous close/error events can arrive.
    if (previous) { try { previous.close(); } catch (_) { /* already closed */ } }
    state.connected = false;
    lastBoard = null;
    takingOut = false;
    resetHandled = false;
    connectionStatus = state.inputMode === 'test' ? 'Testmodus – ohne Kameras' : 'Nicht verbunden';
  }
  function blockForSync(message) {
    if (state.screen === 'game' && state.inputMode === 'board' && !['await-empty', 'finished'].includes(state.boardGate)) {
      state.boardGate = 'sync';
      state.notice = message;
    }
  }
  function connectBoard(force = false) {
    if (state.inputMode !== 'board') return;
    if (force) {
      blockForSync('Verbindung neu gestartet. Aktuelle Aufnahme prüfen und unten synchronisieren.');
      disconnectBoard();
    }
    if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
    clearTimeout(reconnectTimer);
    lastBoard = null;
    let active;
    try {
      active = new WebSocket(boardWsUrl());
      socket = active;
      connectionStatus = 'Verbindung wird aufgebaut …';
    } catch (error) {
      state.connected = false;
      connectionStatus = `Verbindung nicht möglich: ${error.message}`;
      update();
      return;
    }
    active.addEventListener('open', () => {
      if (socket !== active) return;
      state.connected = true;
      connectionStatus = 'Verbindung offen; Board-Meldungen werden geprüft';
      update();
    });
    active.addEventListener('message', (event) => {
      if (socket === active && state.inputMode === 'board') handleBoardMessage(event.data);
    });
    active.addEventListener('close', () => {
      if (socket !== active) return;
      socket = null;
      state.connected = false;
      lastBoard = null;
      takingOut = false;
      connectionStatus = 'Verbindung unterbrochen. Neuer Versuch in 3 Sekunden.';
      blockForSync('Während der Unterbrechung können Würfe oder Spielerwechsel fehlen. Aufnahme nach dem Verbinden prüfen.');
      update();
      reconnectTimer = setTimeout(() => connectBoard(), 3000);
    });
    active.addEventListener('error', () => {
      if (socket !== active) return;
      state.connected = false;
      lastBoard = null;
      blockForSync('Verbindungsfehler. Aufnahme nach dem Verbinden prüfen.');
      connectionStatus = 'Board nicht erreichbar: Adresse, Autodarts Desktop, Browser-Netzwerkfreigabe und gegebenenfalls Zertifikat prüfen.';
      update();
    });
    render();
  }

  function parseBoardState(data) {
    if (!data || typeof data !== 'object') return null;
    const count = data.numThrows ?? (Array.isArray(data.throws) ? data.throws.length : null);
    if (!Number.isInteger(count) || count < 0 || count > 3) return null;
    const rawThrows = data.throws ?? (count === 0 ? [] : null);
    if (!Array.isArray(rawThrows) || rawThrows.length !== count) return null;
    const throws = rawThrows.map((t) => normalizeSegment(t?.segment));
    if (throws.some((t) => t === null)) return null;
    return { throws, event: String(data.event || ''), status: String(data.status || ''), running: data.running !== false };
  }
  function boardOperational(board) {
    return board?.running && !/^(Starting|Stopped|Stopping|Calibration)/i.test(board.event)
      && !/^(Starting|Stopped|Stopping|Calibrating)/i.test(board.status);
  }
  function handleBoardMessage(raw) {
    if (state.inputMode !== 'board') return;
    let packet;
    try { packet = JSON.parse(raw); } catch (_) { return; }
    if (!packet || typeof packet !== 'object' || (packet.type && packet.type !== 'state')) return;
    const data = packet.data ?? packet;
    const board = parseBoardState(data);
    lastEvent = String(data?.event || data?.status || 'Zustand');
    if (!board) {
      lastBoard = null;
      connectionStatus = 'Unvollständige oder ungültige Board-Meldung; keine Punkte übernommen.';
      render();
      return;
    }
    lastBoard = board;
    connectionStatus = board.running ? 'Board meldet Daten' : 'Erkennung ist angehalten';
    if (state.screen !== 'game' || state.boardGate === 'finished') { render(); return; }
    if (!boardOperational(board)) {
      blockForSync('Die Erkennung wurde angehalten oder neu gestartet. Board und Aufnahme vor dem Fortsetzen prüfen.');
      update();
      return;
    }
    if (board.event === 'Takeout finished' && board.throws.length === 0) takingOut = false;
    if (board.event === 'Takeout started' || board.status === 'Takeout in progress') { takingOut = true; render(); return; }
    if (state.boardGate === 'sync') { render(); return; }
    if (board.event !== 'Manual reset') resetHandled = false;
    if (board.event === 'Manual reset') {
      if (resetHandled) return;
      resetHandled = true;
      // Roll back this visit only. The physical board must be cleared explicitly before reuse.
      if (state.visit && !state.legacyVisit) { state.visit.throws = []; state.visit.overrides = {}; replayVisit(); }
      state.boardGate = 'sync';
      state.notice = 'Board zurückgesetzt. Aktuelle Aufnahme zurückgenommen. Darts herausziehen und mit leerem Board fortsetzen.';
      takingOut = false;
      update();
      return;
    }
    if (state.boardGate === 'await-empty') {
      if (board.throws.length === 0 && !takingOut) state.boardGate = 'ready';
      if (board.event === 'Takeout finished' && board.throws.length === 0) { takingOut = false; state.boardGate = 'ready'; }
      update();
      return;
    }
    if (board.event === 'Takeout finished') {
      if (board.throws.length !== 0) { render(); return; }
      takingOut = false;
      if (state.winner !== null) state.boardGate = 'finished';
      else if (state.visit?.throws.length) { nextPlayer(); state.boardGate = 'ready'; }
      update();
      return;
    }
    if (takingOut) { render(); return; }
    if (board.throws.length < (state.visit?.throws.length || 0) && !/correct|undo|remove/i.test(board.event)) {
      blockForSync('Die Wurfanzahl ist unerwartet gesunken. Aufnahme prüfen; möglicherweise fehlt der Spielerwechsel.');
      update();
      return;
    }
    if (JSON.stringify(state.visit?.throws) !== JSON.stringify(board.throws)) {
      reconcileVisit(board.throws);
      update();
    }
  }
  function resumeBoard() {
    if (state.boardGate !== 'sync' || !state.connected || !boardOperational(lastBoard) || state.legacyVisit || takingOut) return;
    if (lastBoard.throws.length === 0 && state.visit?.throws.length) return; // User must finish the scored visit instead.
    reconcileVisit(lastBoard.throws);
    state.boardGate = 'ready';
    state.notice = '';
    update();
  }


  function injectStyles() {
    if (document.getElementById(`${APP_ID}-style`)) return;
    const style = document.createElement('style');
    style.id = `${APP_ID}-style`;
    style.textContent = `
      #${APP_ID}-launcher{position:fixed;right:18px;bottom:18px;z-index:2147483646;border:0;border-radius:999px;padding:12px 16px;font:700 14px/1 system-ui,-apple-system,sans-serif;cursor:pointer;background:#16181d;color:#fff;box-shadow:0 8px 30px #0007}
      #${APP_ID}-panel{position:fixed;inset:12px;z-index:2147483645;background:rgba(14,16,20,.97);color:#f5f7fa;border:1px solid #ffffff22;border-radius:20px;box-shadow:0 24px 80px #000b;overflow:auto;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;backdrop-filter:blur(18px)}
      #${APP_ID}-panel.${APP_ID}-hidden{display:none}
      #${APP_ID}-panel *{box-sizing:border-box}
      .${APP_ID}-wrap{max-width:1200px;margin:0 auto;padding:18px}
      .${APP_ID}-top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}
      .${APP_ID}-title{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:800}
      .${APP_ID}-badge{font-size:11px;padding:4px 8px;border-radius:999px;background:#ffffff12;color:#bfc6d0}
      .${APP_ID}-dot{width:9px;height:9px;border-radius:50%;display:inline-block;background:#e24a4a}.connected .${APP_ID}-dot{background:#40c878}
      .${APP_ID}-actions{display:flex;flex-wrap:wrap;gap:8px}
      #${APP_ID}-panel button,#${APP_ID}-panel input,#${APP_ID}-panel select{font:inherit}
      #${APP_ID}-panel button:disabled{opacity:.45;cursor:not-allowed}
      #${APP_ID}-panel select{max-width:100%;background:#171a20;color:#fff;border:1px solid #ffffff35;border-radius:8px;padding:8px}
      .${APP_ID}-btn{border:1px solid #ffffff25;background:#20242b;color:#fff;border-radius:12px;padding:10px 13px;cursor:pointer;font-weight:700}
      .${APP_ID}-btn:hover{background:#2a3039}.primary{background:#f08a24;border-color:#f08a24;color:#151515}.primary:hover{background:#ff9a35}.danger{border-color:#d85b5b66}
      .${APP_ID}-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
      .${APP_ID}-card{background:#ffffff0a;border:1px solid #ffffff18;border-radius:16px;padding:16px}
      .${APP_ID}-card h3{margin:0 0 12px;font-size:15px;color:#cbd2dc}
      .${APP_ID}-seg{display:flex;gap:8px;flex-wrap:wrap}
      .${APP_ID}-seg button{border:1px solid #ffffff22;background:#171a20;color:#cfd5dd;border-radius:10px;padding:9px 12px;cursor:pointer}.${APP_ID}-seg button.active{background:#f08a24;color:#171717;border-color:#f08a24;font-weight:800}
      .${APP_ID}-players{display:grid;gap:8px}.${APP_ID}-player-row{display:flex;gap:8px}.${APP_ID}-player-row input,.${APP_ID}-input{width:100%;border:1px solid #ffffff1f;background:#0f1115;color:#fff;border-radius:10px;padding:10px 12px;outline:none}
      .${APP_ID}-hint{font-size:12px;color:#9ca5b2;line-height:1.45;margin-top:8px}
      .${APP_ID}-targets{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 18px}.${APP_ID}-target{min-width:54px;text-align:center;border-radius:13px;padding:10px 12px;background:#20252d;border:1px solid #ffffff1c;font-size:18px;font-weight:900}
      .${APP_ID}-scoreboard{width:100%;border-collapse:separate;border-spacing:0 7px}.${APP_ID}-scoreboard th{font-size:13px;color:#929daa;padding:6px 8px}.${APP_ID}-scoreboard td{background:#ffffff09;border-top:1px solid #ffffff12;border-bottom:1px solid #ffffff12;padding:11px 8px;text-align:center;font-weight:800}.${APP_ID}-scoreboard td:first-child{border-radius:11px 0 0 11px;border-left:1px solid #ffffff12;text-align:left}.${APP_ID}-scoreboard td:last-child{border-radius:0 11px 11px 0;border-right:1px solid #ffffff12}.${APP_ID}-scoreboard .active-player{background:#f08a2422;border-color:#f08a2470}.${APP_ID}-marks{font-size:22px;letter-spacing:1px}.${APP_ID}-closed{color:#61d990}.${APP_ID}-score{font-size:25px}.${APP_ID}-turn{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:8px 0 14px;padding:12px 14px;background:#ffffff0b;border:1px solid #ffffff18;border-radius:14px}.${APP_ID}-dartdots{display:flex;gap:6px}.${APP_ID}-dartdot{width:12px;height:12px;border-radius:50%;border:2px solid #b3bac4}.${APP_ID}-dartdot.used{background:#f08a24;border-color:#f08a24}
      .${APP_ID}-winner{margin:10px 0 16px;padding:16px;border-radius:16px;background:#45c98020;border:1px solid #45c98066;font-size:20px;font-weight:900;text-align:center}
      .${APP_ID}-test{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.${APP_ID}-test button{padding:7px 9px;font-size:12px}
      @media(max-width:760px){#${APP_ID}-panel{inset:6px}.${APP_ID}-wrap{padding:12px}.${APP_ID}-grid2{grid-template-columns:1fr}.${APP_ID}-top{align-items:flex-start}.${APP_ID}-scoreboard{font-size:12px}.${APP_ID}-scoreboard td{padding:9px 4px}.${APP_ID}-score{font-size:18px}.${APP_ID}-marks{font-size:18px}.${APP_ID}-target{min-width:45px;padding:8px 9px}}
    `;
    document.head.appendChild(style);
  }

  function ensureUi() {
    injectStyles();

    if (!document.getElementById(`${APP_ID}-launcher`)) {
      const launcher = document.createElement('button');
      launcher.id = `${APP_ID}-launcher`;
      launcher.textContent = '🎯 Random Cutthroat';
      launcher.addEventListener('click', () => {
        state.minimized = false;
        saveState();
        render();
      });
      document.body.appendChild(launcher);
    }

    if (!document.getElementById(`${APP_ID}-panel`)) {
      const panel = document.createElement('section');
      panel.id = `${APP_ID}-panel`;
      document.body.appendChild(panel);
    }
  }

  function setupHtml() {
    const playerRows = state.players.map((player, index) => `
      <div class="${APP_ID}-player-row">
        <input data-player-name="${index}" value="${escapeHtml(player.name)}" aria-label="Spieler ${index + 1}">
      </div>
    `).join('');

    return `
      <div class="${APP_ID}-grid2">
        <div class="${APP_ID}-card">
          <h3>Spieler</h3>
          <div id="${APP_ID}-player-list" class="${APP_ID}-players">${playerRows}</div>
          <div class="${APP_ID}-actions" style="margin-top:10px">
            <button class="${APP_ID}-btn" data-action="add-player">+ Spieler</button>
            <button class="${APP_ID}-btn" data-action="remove-player" ${state.players.length <= 2 ? 'disabled' : ''}>− Spieler</button>
          </div>
        </div>
        <div class="${APP_ID}-card">
          <h3>Bull</h3>
          <div class="${APP_ID}-seg">
            ${['always','never','random'].map((mode) => `<button data-bull="${mode}" class="${state.bullMode === mode ? 'active' : ''}">${mode === 'always' ? 'Immer' : mode === 'never' ? 'Nie' : 'Zufällig'}</button>`).join('')}
          </div>
          <div class="${APP_ID}-hint">Es werden 7 verschiedene Ziele aus 1–20 gezogen. Bei „Zufällig“ nimmt Bull gleichberechtigt an der Ziehung teil.</div>
        </div>
        <div class="${APP_ID}-card">
          <h3>Board Manager</h3>
          <div class="${APP_ID}-seg" style="margin-bottom:12px">
            <button data-mode="board" class="${state.inputMode === 'board' ? 'active' : ''}">Mit Kameras</button>
            <button data-mode="test" class="${state.inputMode === 'test' ? 'active' : ''}">Ohne Kameras testen</button>
          </div>
          <input id="${APP_ID}-host" class="${APP_ID}-input" value="${escapeHtml(state.boardHost)}" placeholder="http://localhost:3180" ${state.inputMode === 'test' ? 'disabled' : ''}>
          <div class="${APP_ID}-hint">Kameras am selben PC: <b>http://localhost:3180</b>. Auf einem anderen Gerät die Adresse des Kamera-PCs eingeben. HTTPS/WSS über Port 3181 nur verwenden, wenn dort angeboten und das Zertifikat im Browser gültig ist. Im Testmodus werden keine Board-Meldungen verarbeitet.</div>
        </div>
        <div class="${APP_ID}-card">
          <h3>Regeln v${VERSION}</h3>
          <div class="${APP_ID}-hint" style="font-size:13px;margin-top:0">3 Marks schließen ein Ziel. Single=1, Double=2, Triple=3. Überzählige Marks geben Strafpunkte an jeden Gegner, der das Ziel noch nicht geschlossen hat. Gewonnen hat, wer alle 7 Ziele geschlossen hat und den niedrigsten (oder geteilten niedrigsten) Punktestand besitzt.</div>
        </div>
      </div>
      <div class="${APP_ID}-actions" style="margin-top:16px;justify-content:flex-end">
        <button class="${APP_ID}-btn primary" data-action="start">Ziele auslosen & starten</button>
      </div>
    `;
  }

  function gameHtml() {
    const headers = state.players.map((player, index) => `<th>${escapeHtml(player.name)}${index === state.currentPlayer ? ' 🎯' : ''}</th>`).join('');
    const targetRows = state.targets.map((target) => {
      const cells = state.players.map((player, index) => {
        const marks = getMarks(player, target);
        const cls = `${index === state.currentPlayer ? 'active-player ' : ''}${marks >= 3 ? `${APP_ID}-closed` : ''}`;
        return `<td class="${cls}"><span class="${APP_ID}-marks">${MARKS[marks]}</span></td>`;
      }).join('');
      return `<tr><td>${targetLabel(target)}</td>${cells}</tr>`;
    }).join('');

    const scoreCells = state.players.map((player, index) => `<td class="${index === state.currentPlayer ? 'active-player' : ''}"><span class="${APP_ID}-score">${player.score}</span></td>`).join('');
    const darts = [0,1,2].map((i) => `<span class="${APP_ID}-dartdot ${i < state.turnDarts ? 'used' : ''}"></span>`).join('');
    const winner = state.winner !== null ? `<div class="${APP_ID}-winner">🏆 ${escapeHtml(state.players[state.winner].name)} gewinnt!</div>` : '';
    const visitEditable = state.boardGate === 'ready' && !takingOut && !state.legacyVisit;
    const canUndo = visitEditable && state.visit?.throws.some((_, i) => effectiveThrow(i) !== null);
    const choices = ['MISS', ...Array.from({ length: 20 }, (_, i) => i + 1).flatMap((n) => ['S', 'D', 'T'].map((m) => `${m}${n}`)), 'S25', 'D25'];
    const corrections = (state.visit?.throws || []).map((segment, i) => {
      const selected = Object.hasOwn(state.visit.overrides, i) ? (effectiveThrow(i)?.name || 'ignore') : 'board';
      return `<label>Dart ${i + 1}: <select data-correct="${i}" aria-label="Dart ${i + 1} korrigieren" ${visitEditable ? '' : 'disabled'}>
        <option value="board" ${selected === 'board' ? 'selected' : ''}>${escapeHtml(segment.name)} (Original)</option>
        <option value="ignore" ${selected === 'ignore' ? 'selected' : ''}>Gestrichen</option>
        ${choices.map((value) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${value}</option>`).join('')}
      </select></label>`;
    }).join(' ');
    const canResume = state.connected && boardOperational(lastBoard) && !state.legacyVisit && !takingOut
      && (lastBoard.throws.length > 0 || !state.visit?.throws.length);

    return `
      ${winner}
      ${state.inputMode === 'board' && state.boardGate === 'await-empty' ? `<div class="${APP_ID}-hint" role="status">Bitte das Board leeren. Die Wertung beginnt nach einer leeren Board-Meldung.</div>` : ''}
      ${state.inputMode === 'board' && state.boardGate === 'sync' ? `<div class="${APP_ID}-card" role="status">
        <b>Aufnahme synchronisieren</b>
        <p>${lastBoard ? `Board meldet: ${lastBoard.throws.map((s) => escapeHtml(s.name)).join(', ') || 'keine Darts'}.` : 'Auf eine gültige Board-Meldung warten.'}</p>
        <div class="${APP_ID}-hint">Nur fortsetzen, wenn die gemeldeten Darts zur aktuellen Aufnahme gehören. Bei bereits entnommenen Darts die Aufnahme abschließen. Neue Würfe bleiben bis dahin gesperrt.</div>
        <button class="${APP_ID}-btn" data-action="resume" ${canResume ? '' : 'disabled'}>${lastBoard?.throws.length ? 'Aufnahme für aktuellen Spieler übernehmen' : 'Mit leerem Board fortsetzen'}</button>
      </div>` : ''}
      <div class="${APP_ID}-turn">
        <div><b>Am Board:</b> ${escapeHtml(state.players[state.currentPlayer]?.name || '')}</div>
        <div class="${APP_ID}-dartdots">${darts}</div>
      </div>
      <div class="${APP_ID}-targets">${state.targets.map((t) => `<div class="${APP_ID}-target">${targetLabel(t)}</div>`).join('')}</div>
      <div style="overflow:auto">
        <table class="${APP_ID}-scoreboard">
          <thead><tr><th>Ziel</th>${headers}</tr></thead>
          <tbody>
            ${targetRows}
            <tr><td>Punkte</td>${scoreCells}</tr>
          </tbody>
        </table>
      </div>
      <div class="${APP_ID}-actions" style="margin-top:14px">
        <button class="${APP_ID}-btn" data-action="undo" ${canUndo ? '' : 'disabled'}>${state.inputMode === 'test' ? '↶ Undo' : 'Letzten Dart streichen'}</button>
        <button class="${APP_ID}-btn" data-action="next" ${state.winner !== null || (state.inputMode === 'board' && state.boardGate === 'await-empty') ? 'disabled' : ''}>${state.boardGate === 'sync' ? 'Aufnahme abschließen' : 'Nächster Spieler'}</button>
        <button class="${APP_ID}-btn danger" data-action="new-game">Neues Spiel</button>
      </div>
      <div class="${APP_ID}-test">${corrections}</div>
      ${state.inputMode === 'board' ? `<div class="${APP_ID}-hint">Korrekturen gelten nur für dieses Spiel. Ein gestrichener Dart bleibt als geworfener Dart belegt. Bei Fehlwürfen außerhalb des Boards im Board Manager einen MISS ergänzen.</div>` : ''}
      ${state.inputMode === 'test' ? `<details open data-details="tests" style="margin-top:14px;color:#9ca5b2">
        <summary style="cursor:pointer">Testwürfe (ohne Board)</summary>
        <div class="${APP_ID}-test">
          ${state.targets.flatMap((target) => (target === 25 ? [1,2] : [1,2,3]).map((m) => `<button class="${APP_ID}-btn" data-test-target="${target}" data-test-m="${m}" ${state.turnDarts >= 3 || state.winner !== null || state.legacyVisit ? 'disabled' : ''}>${m === 1 ? 'S' : m === 2 ? 'D' : 'T'}${targetLabel(target)}</button>`)).join('')}
          <button class="${APP_ID}-btn" data-test-target="0" data-test-m="0" ${state.turnDarts >= 3 || state.winner !== null || state.legacyVisit ? 'disabled' : ''}>MISS</button>
        </div>
      </details>` : ''}
    `;
  }

  function render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      ensureUi();
      const panel = document.getElementById(`${APP_ID}-panel`);
      const launcher = document.getElementById(`${APP_ID}-launcher`);
      if (!panel || !launcher) return;

      // Status events may arrive while a player edits a name/address or opens a selector.
      // Input handlers save drafts immediately; defer replacement while a select has focus.
      if (panel.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
      const focused = panel.contains(document.activeElement) ? document.activeElement : null;
      const focusId = focused?.id;
      const focusPlayer = focused?.dataset.playerName;
      const selection = focused?.tagName === 'INPUT' ? [focused.selectionStart, focused.selectionEnd] : null;
      const detailStates = [...panel.querySelectorAll('details[data-details]')].map((el) => [el.dataset.details, el.open]);

      panel.classList.toggle(`${APP_ID}-hidden`, state.minimized);
      launcher.style.display = state.minimized ? 'block' : 'none';

      panel.innerHTML = `
        <div class="${APP_ID}-wrap ${state.connected ? 'connected' : ''}">
          <div class="${APP_ID}-top">
            <div class="${APP_ID}-title">🎯 Random Cutthroat <span class="${APP_ID}-badge">v${VERSION}</span></div>
            <div class="${APP_ID}-actions">
              <span class="${APP_ID}-badge"><span class="${APP_ID}-dot"></span> ${state.inputMode === 'test' ? 'Testmodus' : state.connected ? 'Board verbunden' : 'Board offline'}</span>
              ${state.inputMode === 'board' ? `<button class="${APP_ID}-btn" data-action="connect">Verbinden</button>` : ''}
              <button class="${APP_ID}-btn" data-action="minimize">×</button>
            </div>
          </div>
          ${state.notice || storageWarning ? `<div class="${APP_ID}-hint" role="status">${escapeHtml(state.notice)} ${escapeHtml(storageWarning)}</div>` : ''}
          ${state.screen === 'game' ? gameHtml() : setupHtml()}
          ${state.inputMode === 'board' ? `<details data-details="diagnostics" style="margin-top:16px"><summary>Verbindungsdiagnose</summary><div class="${APP_ID}-hint">${escapeHtml(connectionStatus)}<br>Adresse: ${escapeHtml(state.boardHost)}<br>Letztes Ereignis: ${escapeHtml(lastEvent)}<br>Gemeldete Darts: ${lastBoard ? lastBoard.throws.length : '–'}</div></details>` : ''}
        </div>
      `;

      bindUi(panel);
      for (const [key, open] of detailStates) { const detail = panel.querySelector(`[data-details="${key}"]`); if (detail) detail.open = open; }
      const replacement = focusId ? document.getElementById(focusId) : focusPlayer != null ? panel.querySelector(`[data-player-name="${focusPlayer}"]`) : null;
      if (replacement && selection) { replacement.focus(); replacement.setSelectionRange(...selection); }
    });
  }

  function bindUi(panel) {
    panel.querySelectorAll('[data-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        if (state.screen !== 'setup') return;
        state.inputMode = button.dataset.mode === 'test' ? 'test' : 'board';
        disconnectBoard();
        if (state.inputMode === 'board') connectBoard();
        update();
      });
    });
    panel.querySelectorAll('[data-correct]').forEach((select) => {
      select.addEventListener('change', () => { select.blur(); correctThrow(Number(select.dataset.correct), select.value); });
      select.addEventListener('blur', () => render());
    });
    panel.querySelectorAll('[data-bull]').forEach((button) => {
      button.addEventListener('click', () => {
        state.bullMode = button.dataset.bull;
        saveState();
        render();
      });
    });

    panel.querySelectorAll('[data-player-name]').forEach((input) => {
      input.addEventListener('input', () => {
        const index = Number(input.dataset.playerName);
        if (state.players[index]) state.players[index].name = input.value;
        saveState();
      });
    });

    const host = panel.querySelector(`#${APP_ID}-host`);
    if (host) {
      host.addEventListener('input', () => {
        state.boardHost = host.value;
        saveState();
      });
    }

    panel.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.action;
        if (action === 'add-player') addPlayer();
        if (action === 'remove-player') removePlayer();
        if (action === 'start') {
          if (host) state.boardHost = host.value.trim() || DEFAULT_BOARD_HOST;
          startGame();
        }
        if (action === 'undo') undo();
        if (action === 'next') nextPlayer();
        if (action === 'resume') resumeBoard();
        if (action === 'new-game') newGame();
        if (action === 'connect') {
          if (host) state.boardHost = host.value.trim() || DEFAULT_BOARD_HOST;
          saveState();
          connectBoard(true);
        }
        if (action === 'minimize') {
          state.minimized = true;
          saveState();
          render();
        }
      });
    });

    panel.querySelectorAll('[data-test-target]').forEach((button) => {
      button.addEventListener('click', () => {
        const number = Number(button.dataset.testTarget);
        const multiplier = Number(button.dataset.testM);
        processThrow({ number, multiplier, name: number ? `${multiplier === 1 ? 'S' : multiplier === 2 ? 'D' : 'T'}${targetLabel(number)}` : 'MISS' }, 'test');
      });
    });
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function boot() {
    ensureUi();
    render();
    connectBoard(false);

    const observer = new MutationObserver(() => {
      if (!document.getElementById(`${APP_ID}-panel`) || !document.getElementById(`${APP_ID}-launcher`)) {
        render();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();

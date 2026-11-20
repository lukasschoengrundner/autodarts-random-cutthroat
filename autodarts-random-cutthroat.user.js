// ==UserScript==
// @name         Autodarts – Cricket Random Cutthroat
// @namespace    https://github.com/lukasschoengrundner/autodarts-random-cutthroat
// @version      0.4.2
// @description  Cricket Random Cutthroat overlay for Autodarts. Local games or encrypted online rooms with a friend.
// @author       Lukas Schöngrundner
// @match        https://play.autodarts.com/*
// @match        https://play.autodarts.io/*
// @updateURL    https://raw.githubusercontent.com/lukasschoengrundner/autodarts-random-cutthroat/main/autodarts-random-cutthroat.user.js
// @downloadURL  https://raw.githubusercontent.com/lukasschoengrundner/autodarts-random-cutthroat/main/autodarts-random-cutthroat.user.js
// @require      https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const APP_ID = 'ad-rcc';
  const STORAGE_KEY = 'autodarts-random-cutthroat:v1';
  const NETWORK_STORAGE_KEY = 'autodarts-random-cutthroat:network:v1';
  const DEFAULT_BOARD_HOST = 'http://localhost:3180';
  const VERSION = '0.4.2';
  const ONLINE_PROTOCOL = 1;
  const ROOM_PREFIX = 'ad-rcc-';
  const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const SHARED_STATE_KEYS = [
    'schemaVersion', 'screen', 'bullMode', 'targetCount', 'targets', 'players', 'currentPlayer',
    'turnDarts', 'turnSerial', 'winner', 'boardGate', 'visit', 'previousVisit', 'legacyVisit', 'notice',
  ];
  const MARKS = ['–', '/', 'X', '⊗'];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const defaultState = () => ({
    schemaVersion: 2, screen: 'setup', bullMode: 'random', targetCount: 7, targets: [],
    players: [1, 2].map((i) => ({ name: `Spieler ${i}`, marks: {}, score: 0 })),
    currentPlayer: 0, turnDarts: 0, turnSerial: 0, winner: null,
    boardHost: DEFAULT_BOARD_HOST, inputMode: 'board', connected: false,
    boardGate: 'await-empty', visit: null, previousVisit: null, legacyVisit: false, minimized: false, notice: '',
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
  let lastRawBoardMessage = null;
  let lastForwardedBoardKey = null;

  let network = loadNetwork();
  let peer = null;
  let peerConnection = null;
  let peerGeneration = 0;
  let networkRetryTimer = null;
  let networkStatus = network.role === 'local' ? 'Lokales Spiel' : 'Online-Verbindung wird vorbereitet';
  let networkRevision = 0;
  let remoteBoard = null;
  let remoteHostInputMode = 'board';
  let remoteProfile = {
    clientId: '', name: 'Freund', inputMode: 'board', boardConnected: false,
    lastEvent: 'Noch keine Board-Meldung',
  };

  function randomToken(length, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789') {
    const bytes = new Uint8Array(length);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return [...bytes].map((value) => alphabet[value % alphabet.length]).join('');
  }

  function normalizeRoomCode(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6);
  }

  function randomRoomCode() { return randomToken(6, ROOM_ALPHABET); }
  function roomPeerId(code) { return `${ROOM_PREFIX}${normalizeRoomCode(code).toLowerCase()}`; }
  function sanitizeName(value, fallback = 'Spieler') {
    const name = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
    return name || fallback;
  }

  function loadNetwork() {
    const base = {
      role: 'local', roomCode: '', clientId: randomToken(16), connected: false,
      hostSession: '', appliedSession: '', appliedRevision: -1,
    };
    try {
      const saved = JSON.parse(localStorage.getItem(NETWORK_STORAGE_KEY) || 'null');
      if (!saved || !['local', 'host', 'guest'].includes(saved.role)) return base;
      return {
        ...base,
        role: saved.role,
        roomCode: normalizeRoomCode(saved.roomCode),
        clientId: /^[a-z0-9]{8,32}$/i.test(saved.clientId || '') ? saved.clientId : base.clientId,
      };
    } catch (_) {
      return base;
    }
  }

  function saveNetwork() {
    try {
      localStorage.setItem(NETWORK_STORAGE_KEY, JSON.stringify({
        role: network.role, roomCode: network.roomCode, clientId: network.clientId,
      }));
    } catch (_) { /* The game itself still works without saved reconnect preferences. */ }
  }

  function sharedStateSnapshot() {
    return {
      ...Object.fromEntries(SHARED_STATE_KEYS.map((key) => [key, clone(state[key])])),
      hostInputMode: state.inputMode,
      takingOut: Boolean(takingOut),
    };
  }

  function validSharedState(value) {
    if (!value || typeof value !== 'object' || !validPlayers(value.players)) return false;
    if (!['setup', 'game'].includes(value.screen) || !['always', 'never', 'random'].includes(value.bullMode)) return false;
    if (!Number.isInteger(value.currentPlayer) || value.currentPlayer < 0 || value.currentPlayer >= value.players.length) return false;
    if (!Number.isInteger(value.turnDarts) || value.turnDarts < 0 || value.turnDarts > 3) return false;
    if (!Number.isInteger(value.turnSerial) || value.turnSerial < 0) return false;
    if (value.winner !== null && (!Number.isInteger(value.winner) || value.winner < 0 || value.winner >= value.players.length)) return false;
    if (!['await-empty', 'ready', 'sync', 'review', 'finished'].includes(value.boardGate)
      || !['board', 'test'].includes(value.hostInputMode) || typeof value.takingOut !== 'boolean') return false;
    if (value.screen === 'setup') return Array.isArray(value.targets);
    if (!Array.isArray(value.targets) || value.targets.length !== 7 || new Set(value.targets).size !== 7
      || !value.targets.every((target) => Number.isInteger(target) && ((target >= 1 && target <= 20) || target === 25))) return false;
    if (!value.legacyVisit && !validVisit(value.visit, value.players.length, value.currentPlayer)) return false;
    return value.previousVisit === null || validTurnSnapshot(value.previousVisit, value.players.length);
  }

  function applySharedStateSnapshot(snapshot) {
    if (!validSharedState(snapshot)) return false;
    const local = {
      boardHost: state.boardHost, inputMode: state.inputMode, connected: state.connected,
      minimized: state.minimized,
    };
    const shared = clone(snapshot);
    remoteHostInputMode = shared.hostInputMode;
    delete shared.hostInputMode;
    takingOut = shared.takingOut;
    delete shared.takingOut;
    Object.assign(state, shared, local);
    saveState();
    render();
    return true;
  }

  function localPlayerIndex() {
    if (network.role === 'host') return 0;
    if (network.role === 'guest') return 1;
    return state.currentPlayer;
  }

  function isLocalTurn() {
    return network.role === 'local' || state.currentPlayer === localPlayerIndex();
  }

  function actorInputMode(actorIndex = state.currentPlayer) {
    if (network.role === 'host' && actorIndex === 1) return remoteProfile.inputMode;
    if (network.role === 'guest' && actorIndex === 0) return remoteHostInputMode;
    return state.inputMode;
  }

  function actorBoard(actorIndex = state.currentPlayer) {
    if (network.role === 'guest' && actorIndex === 0) return null;
    return network.role === 'host' && actorIndex === 1 ? remoteBoard : lastBoard;
  }

  function actorBoardConnected(actorIndex = state.currentPlayer) {
    if (network.role === 'guest' && actorIndex === 0) return false;
    return network.role === 'host' && actorIndex === 1 ? remoteProfile.boardConnected : state.connected;
  }

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
      loaded.previousVisit = validTurnSnapshot(saved.previousVisit, loaded.players.length) ? saved.previousVisit : null;
      if (loaded.screen !== 'game') loaded.previousVisit = null;
      delete loaded.history;
      delete loaded.lastProcessedFingerprint;
      return loaded;
    } catch (error) {
      console.warn('[Cricket Random Cutthroat] Could not load state', error);
      base.notice = 'Gespeicherter Spielstand konnte nicht geladen werden.';
      return base;
    }
  }

  function validVisit(visit, playerCount, playerIndex) {
    return visit && validPlayers(visit.base?.players) && visit.base.players.length === playerCount
      && visit.base.currentPlayer === playerIndex && Array.isArray(visit.throws) && visit.throws.length <= 3
      && visit.throws.every((s) => normalizeSegment(s))
      && (visit.boardThrows === undefined || (Array.isArray(visit.boardThrows) && visit.boardThrows.length <= 3 && visit.boardThrows.every((s) => normalizeSegment(s)))) && visit.overrides && typeof visit.overrides === 'object'
      && Object.entries(visit.overrides).every(([i, s]) => /^\d$/.test(i) && Number(i) < visit.throws.length && (s === null || normalizeSegment(s)));
  }

  function validTurnSnapshot(snapshot, playerCount) {
    return snapshot && validPlayers(snapshot.players) && snapshot.players.length === playerCount
      && Number.isInteger(snapshot.currentPlayer) && snapshot.currentPlayer >= 0 && snapshot.currentPlayer < playerCount
      && Number.isInteger(snapshot.turnSerial) && snapshot.turnSerial >= 0
      && (snapshot.winner === null || (Number.isInteger(snapshot.winner) && snapshot.winner >= 0 && snapshot.winner < playerCount))
      && validVisit(snapshot.visit, playerCount, snapshot.currentPlayer);
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, connected: false }));
      storageWarning = '';
    } catch (error) {
      storageWarning = 'Spielstand kann nicht gespeichert werden. Dieses Browserfenster geöffnet lassen.';
      console.warn('[Cricket Random Cutthroat] Could not save state', error);
    }
  }

  function update(options = {}) {
    saveState();
    render();
    if (network.role === 'host' && options.broadcast !== false) broadcastState();
  }

  function sendConnection(connection, message) {
    if (!connection?.open) return false;
    try {
      connection.send(message);
      return true;
    } catch (error) {
      console.warn('[Cricket Random Cutthroat] Online message failed', error);
      return false;
    }
  }

  function broadcastState() {
    if (network.role !== 'host' || !network.connected || !peerConnection?.open) return;
    sendConnection(peerConnection, {
      type: 'state', protocol: ONLINE_PROTOCOL, version: VERSION,
      sessionId: network.hostSession, revision: ++networkRevision,
      state: sharedStateSnapshot(),
    });
  }

  function sendGuestMessage(message) {
    if (network.role !== 'guest') return false;
    return sendConnection(peerConnection, { ...message, protocol: ONLINE_PROTOCOL, clientId: network.clientId });
  }

  function destroyPeerRuntime() {
    peerGeneration += 1;
    clearTimeout(networkRetryTimer);
    networkRetryTimer = null;
    const connection = peerConnection;
    const activePeer = peer;
    peerConnection = null;
    peer = null;
    network.connected = false;
    lastForwardedBoardKey = null;
    if (connection) { try { connection.close(); } catch (_) { /* already closed */ } }
    if (activePeer) { try { activePeer.destroy(); } catch (_) { /* already destroyed */ } }
    remoteBoard = null;
    remoteProfile = {
      clientId: '', name: state.players[1]?.name || 'Freund', inputMode: 'board', boardConnected: false,
      lastEvent: 'Noch keine Board-Meldung',
    };
  }

  function useLocalMode() {
    destroyPeerRuntime();
    network.role = 'local';
    network.roomCode = '';
    network.hostSession = '';
    network.appliedSession = '';
    network.appliedRevision = -1;
    networkStatus = 'Lokales Spiel';
    saveNetwork();
    render();
  }

  function prepareGuestMode() {
    destroyPeerRuntime();
    network.role = 'guest';
    network.roomCode = '';
    network.appliedSession = '';
    network.appliedRevision = -1;
    networkStatus = 'Raumcode des Hosts eingeben.';
    while (state.players.length < 2) state.players.push({ name: `Spieler ${state.players.length + 1}`, marks: {}, score: 0 });
    saveNetwork();
    render();
  }

  async function copyRoomCode() {
    if (!network.roomCode) return;
    try {
      await navigator.clipboard.writeText(network.roomCode);
      networkStatus = `Raumcode ${network.roomCode} kopiert`;
    } catch (_) {
      networkStatus = `Raumcode: ${network.roomCode}`;
    }
    render();
  }

  function peerConstructor() {
    return typeof globalThis.Peer === 'function' ? globalThis.Peer : null;
  }

  function schedulePeerReconnect(callback, generation) {
    clearTimeout(networkRetryTimer);
    networkRetryTimer = setTimeout(() => {
      if (generation === peerGeneration) callback();
    }, 3000);
  }

  function createOnlineRoom(code = randomRoomCode()) {
    const PeerClient = peerConstructor();
    if (!PeerClient) {
      networkStatus = 'Online-Bibliothek konnte nicht geladen werden. Seite neu laden und Tampermonkey prüfen.';
      render();
      return;
    }
    destroyPeerRuntime();
    network.role = 'host';
    network.roomCode = normalizeRoomCode(code) || randomRoomCode();
    network.hostSession = randomToken(12);
    network.appliedSession = '';
    network.appliedRevision = -1;
    networkRevision = 0;
    networkStatus = `Raum ${network.roomCode} wird erstellt …`;
    saveNetwork();
    const generation = peerGeneration;
    let activePeer;
    try {
      activePeer = new PeerClient(roomPeerId(network.roomCode), { debug: 1 });
      peer = activePeer;
    } catch (error) {
      networkStatus = `Online-Raum konnte nicht erstellt werden: ${error.message}`;
      render();
      return;
    }
    activePeer.on('open', () => {
      if (peer !== activePeer || generation !== peerGeneration) return;
      networkStatus = `Raum ${network.roomCode} ist offen – auf Freund warten`;
      render();
    });
    activePeer.on('connection', (connection) => {
      if (peer !== activePeer || generation !== peerGeneration) { connection.close(); return; }
      bindHostConnection(connection, generation);
    });
    activePeer.on('disconnected', () => {
      if (peer !== activePeer || generation !== peerGeneration) return;
      networkStatus = 'Verbindung zum Vermittlungsdienst unterbrochen – neuer Versuch …';
      render();
      schedulePeerReconnect(() => { try { activePeer.reconnect(); } catch (_) { /* retry via status button */ } }, generation);
    });
    activePeer.on('error', (error) => {
      if (peer !== activePeer || generation !== peerGeneration) return;
      networkStatus = error?.type === 'unavailable-id'
        ? 'Dieser Raumcode ist bereits belegt. Bitte einen neuen Raum erstellen.'
        : `Online-Fehler: ${error?.message || error?.type || 'unbekannt'}`;
      render();
    });
    render();
  }

  function bindHostConnection(connection, generation) {
    // Reserve the only guest slot immediately. Two simultaneous connection
    // attempts must not be able to replace each other before either is open.
    if (peerConnection) {
      connection.on('open', () => {
        sendConnection(connection, { type: 'error', protocol: ONLINE_PROTOCOL, message: 'Raum ist bereits voll.' });
        connection.close();
      });
      return;
    }
    peerConnection = connection;
    connection.on('open', () => {
      if (peerConnection !== connection || generation !== peerGeneration) return;
      networkStatus = 'Freund verbunden – Anmeldung wird geprüft …';
      render();
    });
    connection.on('data', (message) => {
      if (peerConnection === connection && generation === peerGeneration) handleHostData(message);
    });
    connection.on('close', () => {
      if (peerConnection !== connection || generation !== peerGeneration) return;
      peerConnection = null;
      network.connected = false;
      remoteProfile.boardConnected = false;
      remoteBoard = null;
      networkStatus = `Freund getrennt – Raum ${network.roomCode} bleibt offen`;
      blockForSync('Online-Verbindung zum aktuellen Spieler unterbrochen. Auf die Wiederverbindung warten.', 1);
      update({ broadcast: false });
    });
    connection.on('error', (error) => {
      if (peerConnection !== connection || generation !== peerGeneration) return;
      peerConnection = null;
      network.connected = false;
      remoteProfile.boardConnected = false;
      remoteBoard = null;
      networkStatus = `Verbindungsfehler zum Freund: ${error?.message || 'unbekannt'}`;
      blockForSync('Online-Verbindung zum aktuellen Spieler unterbrochen. Auf die Wiederverbindung warten.', 1);
      try { connection.close(); } catch (_) { /* already closed */ }
      update({ broadcast: false });
    });
  }

  function joinOnlineRoom(code) {
    const roomCode = normalizeRoomCode(code);
    if (roomCode.length !== 6) {
      networkStatus = 'Bitte den sechsstelligen Raumcode eingeben.';
      render();
      return;
    }
    const PeerClient = peerConstructor();
    if (!PeerClient) {
      networkStatus = 'Online-Bibliothek konnte nicht geladen werden. Seite neu laden und Tampermonkey prüfen.';
      render();
      return;
    }
    destroyPeerRuntime();
    network.role = 'guest';
    network.roomCode = roomCode;
    network.appliedSession = '';
    network.appliedRevision = -1;
    networkStatus = `Raum ${roomCode} wird gesucht …`;
    saveNetwork();
    const generation = peerGeneration;
    let activePeer;
    try {
      activePeer = new PeerClient(undefined, { debug: 1 });
      peer = activePeer;
    } catch (error) {
      networkStatus = `Online-Verbindung konnte nicht gestartet werden: ${error.message}`;
      render();
      return;
    }
    activePeer.on('open', () => {
      if (peer === activePeer && generation === peerGeneration) connectGuestToHost(generation);
    });
    activePeer.on('disconnected', () => {
      if (peer !== activePeer || generation !== peerGeneration) return;
      networkStatus = 'Vermittlungsdienst getrennt – Verbindung wird wiederhergestellt …';
      network.connected = false;
      render();
      schedulePeerReconnect(() => { try { activePeer.reconnect(); } catch (_) { connectGuestToHost(generation); } }, generation);
    });
    activePeer.on('error', (error) => {
      if (peer !== activePeer || generation !== peerGeneration) return;
      if (error?.type === 'peer-unavailable') {
        const pending = peerConnection;
        peerConnection = null;
        network.connected = false;
        if (pending) { try { pending.close(); } catch (_) { /* already closed */ } }
        networkStatus = `Raum ${network.roomCode} wurde noch nicht gefunden – neuer Versuch …`;
        schedulePeerReconnect(() => connectGuestToHost(generation), generation);
      } else {
        networkStatus = `Online-Fehler: ${error?.message || error?.type || 'unbekannt'}`;
      }
      render();
    });
    render();
  }

  function connectGuestToHost(generation = peerGeneration) {
    if (network.role !== 'guest' || !peer || generation !== peerGeneration) return;
    if (peerConnection) return;
    let connection;
    try {
      connection = peer.connect(roomPeerId(network.roomCode), { reliable: true, serialization: 'json' });
      peerConnection = connection;
    } catch (error) {
      networkStatus = `Beitritt fehlgeschlagen: ${error.message}`;
      render();
      return;
    }
    connection.on('open', () => {
      if (peerConnection !== connection || generation !== peerGeneration) return;
      network.connected = true;
      lastForwardedBoardKey = null;
      networkStatus = `Mit Raum ${network.roomCode} verbunden`;
      sendGuestProfile('hello');
      render();
    });
    connection.on('data', (message) => {
      if (peerConnection === connection && generation === peerGeneration) handleGuestData(message);
    });
    connection.on('close', () => {
      if (peerConnection !== connection || generation !== peerGeneration) return;
      peerConnection = null;
      network.connected = false;
      networkStatus = `Verbindung zu Raum ${network.roomCode} getrennt – neuer Versuch …`;
      render();
      schedulePeerReconnect(() => connectGuestToHost(generation), generation);
    });
    connection.on('error', (error) => {
      if (peerConnection !== connection || generation !== peerGeneration) return;
      peerConnection = null;
      network.connected = false;
      networkStatus = `Verbindungsfehler: ${error?.message || 'unbekannt'} – neuer Versuch …`;
      try { connection.close(); } catch (_) { /* already closed */ }
      render();
      schedulePeerReconnect(() => connectGuestToHost(generation), generation);
    });
  }

  function localOnlineName() {
    const index = network.role === 'guest' ? 1 : 0;
    return sanitizeName(state.players[index]?.name, network.role === 'guest' ? 'Freund' : 'Host');
  }

  function forwardGuestBoard() {
    if (network.role !== 'guest' || !network.connected || !isLocalTurn()
      || state.screen !== 'game' || state.inputMode !== 'board' || !lastRawBoardMessage) return;
    const key = JSON.stringify([network.appliedSession, state.turnSerial, state.currentPlayer, lastRawBoardMessage]);
    if (key === lastForwardedBoardKey) return;
    // Mark before sending: receiving the resulting state must not echo it back.
    lastForwardedBoardKey = key;
    if (!sendGuestMessage({ type: 'board', raw: lastRawBoardMessage })) lastForwardedBoardKey = null;
  }

  function sendGuestProfile(type = 'profile') {
    sendGuestMessage({
      type, name: localOnlineName(), inputMode: state.inputMode,
      boardConnected: Boolean(state.connected), version: VERSION,
    });
  }

  function rejectGuest(message) {
    const rejected = peerConnection;
    sendConnection(rejected, { type: 'error', protocol: ONLINE_PROTOCOL, message });
    peerConnection = null;
    network.connected = false;
    remoteProfile.boardConnected = false;
    networkStatus = `${message} Raum ${network.roomCode} bleibt offen.`;
    if (rejected) { try { rejected.close(); } catch (_) { /* already closed */ } }
    render();
  }

  function handleHostData(message) {
    if (!message || typeof message !== 'object' || message.protocol !== ONLINE_PROTOCOL) return;
    if (message.type === 'hello') {
      const clientId = String(message.clientId || '');
      if (!/^[a-z0-9]{8,32}$/i.test(clientId)) {
        rejectGuest('Ungültige Online-Anmeldung.');
        return;
      }
      if (state.screen === 'game' && remoteProfile.clientId && remoteProfile.clientId !== clientId) {
        rejectGuest('Dieses laufende Spiel gehört bereits einem anderen Mitspieler.');
        return;
      }
      const knownRunningGuest = state.screen === 'game' && remoteProfile.clientId === clientId;
      remoteProfile.clientId = clientId;
      remoteProfile.boardConnected = Boolean(message.boardConnected);
      while (state.players.length < 2) state.players.push({ name: 'Freund', marks: {}, score: 0 });
      if (state.screen === 'setup') {
        remoteProfile.name = sanitizeName(message.name, 'Freund');
        remoteProfile.inputMode = message.inputMode === 'test' ? 'test' : 'board';
        state.players = state.players.slice(0, 2);
        state.players[1].name = remoteProfile.name;
      } else {
        if (!knownRunningGuest) remoteProfile.inputMode = message.inputMode === 'test' ? 'test' : 'board';
        remoteProfile.name = state.players[1].name;
      }
      network.connected = true;
      networkStatus = `${remoteProfile.name} ist verbunden`;
      sendConnection(peerConnection, {
        type: 'welcome', protocol: ONLINE_PROTOCOL, version: VERSION,
        sessionId: network.hostSession, roomCode: network.roomCode,
      });
      update();
      return;
    }
    if (!network.connected || message.clientId !== remoteProfile.clientId) return;
    if (message.type === 'profile') {
      remoteProfile.boardConnected = Boolean(message.boardConnected);
      if (state.screen === 'setup') {
        remoteProfile.name = sanitizeName(message.name, remoteProfile.name);
        remoteProfile.inputMode = message.inputMode === 'test' ? 'test' : 'board';
        if (state.players[1]) state.players[1].name = remoteProfile.name;
      }
      update();
      return;
    }
    if (message.type === 'board-status') {
      remoteProfile.boardConnected = Boolean(message.connected);
      if (!remoteProfile.boardConnected) {
        remoteBoard = null;
        blockForSync('Board-Verbindung des Freundes wurde unterbrochen. Nach dem Verbinden die Aufnahme prüfen.', 1);
      }
      update();
      return;
    }
    if (message.type === 'board' && typeof message.raw === 'string' && message.raw.length <= 200000) {
      if (state.currentPlayer === 1 && remoteProfile.inputMode === 'board') handleBoardMessage(message.raw, 1);
      return;
    }
    if (message.type === 'action') handleRemoteAction(message);
    if (message.type === 'request-state') broadcastState();
  }

  function handleGuestData(message) {
    if (!message || typeof message !== 'object' || message.protocol !== ONLINE_PROTOCOL) return;
    if (message.type === 'error') {
      networkStatus = sanitizeName(message.message, 'Online-Verbindung abgelehnt.');
      render();
      return;
    }
    if (message.type === 'welcome') {
      network.connected = true;
      networkStatus = `Mit Raum ${network.roomCode} verbunden`;
      if (message.sessionId !== network.appliedSession) {
        network.appliedSession = String(message.sessionId || '');
        network.appliedRevision = -1;
      }
      sendGuestMessage({ type: 'request-state' });
      render();
      return;
    }
    if (message.type !== 'state' || typeof message.sessionId !== 'string' || !Number.isInteger(message.revision)) return;
    if (message.sessionId !== network.appliedSession) {
      network.appliedSession = message.sessionId;
      network.appliedRevision = -1;
    }
    if (message.revision <= network.appliedRevision || !applySharedStateSnapshot(message.state)) return;
    network.appliedRevision = message.revision;
    network.connected = true;
    networkStatus = `Mit Raum ${network.roomCode} verbunden`;
    if (!isLocalTurn() || state.screen !== 'game') lastForwardedBoardKey = null;
    forwardGuestBoard();
    if (isLocalTurn() && state.inputMode === 'test' && state.boardGate === 'await-empty') {
      sendGuestMessage({ type: 'action', action: 'ready' });
    }
  }

  function handleRemoteAction(message) {
    if (network.role !== 'host' || state.screen !== 'game' || state.currentPlayer !== 1) return;
    const action = String(message.action || '');
    if (action === 'test-throw' && remoteProfile.inputMode === 'test') {
      processThrow(message.segment, 'test', 1);
      return;
    }
    if (action === 'ready' && remoteProfile.inputMode === 'test' && state.boardGate === 'await-empty') {
      state.boardGate = 'ready';
      state.notice = '';
      update();
      return;
    }
    if (action === 'next') nextPlayer();
    if (action === 'previous') previousPlayer();
    if (action === 'reset-visit') resetVisit();
    if (action === 'undo') undo();
    if (action === 'resume') resumeBoard(1);
    if (action === 'correct') correctThrow(Number(message.index), String(message.value || ''));
  }

  function dispatchGameAction(action, payload = {}) {
    if (network.role === 'guest') {
      if (!network.connected || state.currentPlayer !== 1) return;
      sendGuestMessage({ type: 'action', action, ...payload });
      return;
    }
    if (action === 'next') nextPlayer();
    if (action === 'previous') previousPlayer();
    if (action === 'reset-visit') resetVisit();
    if (action === 'undo') undo();
    if (action === 'resume') resumeBoard(network.role === 'host' ? state.currentPlayer : localPlayerIndex());
    if (action === 'correct') correctThrow(Number(payload.index), String(payload.value || ''));
    if (action === 'test-throw') processThrow(payload.segment, 'test', localPlayerIndex());
  }
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
    return orderedTargets(targets);
  }
  function orderedTargets(targets = state.targets) {
    return [...targets].sort((a, b) => a === b ? 0 : a === 25 ? 1 : b === 25 ? -1 : b - a);
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
    state.visit = { base: { players: clone(state.players), currentPlayer: state.currentPlayer }, throws: [], overrides: {}, boardThrows: [] };
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
    const previousRaw = state.visit.boardThrows ?? state.visit.throws;
    // Manual additions are independent of the camera's shorter list. A real
    // change to an observed slot still supersedes that slot's correction.
    for (const key of Object.keys(state.visit.overrides)) {
      if (JSON.stringify(throws[key]) !== JSON.stringify(previousRaw[key])) delete state.visit.overrides[key];
    }
    state.visit.boardThrows = clone(throws);
    const length = Math.max(throws.length, ...Object.keys(state.visit.overrides).map((i) => Number(i) + 1));
    state.visit.throws = Array.from({ length }, (_, i) => throws[i] || { number: 0, multiplier: 0, name: 'MISS' });
    replayVisit();
  }

  function processThrow(segment, source = 'test', actorIndex = localPlayerIndex()) {
    if (source !== 'test' || actorInputMode(actorIndex) !== 'test' || actorIndex !== state.currentPlayer
      || state.screen !== 'game' || state.legacyVisit || state.winner !== null || state.turnDarts >= 3) return;
    const normalized = normalizeSegment(segment);
    if (!normalized) return;
    if (!state.visit) beginVisit();
    state.visit.throws.push(normalized);
    replayVisit();
    update();
  }
  function snapshotCurrentTurn() {
    return {
      players: clone(state.players), currentPlayer: state.currentPlayer, visit: clone(state.visit),
      turnDarts: state.turnDarts, turnSerial: state.turnSerial, winner: state.winner,
    };
  }
  function nextPlayer() {
    if (state.screen !== 'game' || state.winner !== null) return;
    // A manual change waits for the physical takeout; repeated clicks cannot skip players.
    if (actorInputMode(state.currentPlayer) === 'board' && state.boardGate === 'await-empty') return;
    // Returning from review reuses the latest empty state of the shared local board.
    const reviewedBoardIsEmpty = state.boardGate === 'review' && network.role === 'local'
      && state.connected && boardOperational(lastBoard) && lastBoard.throws.length === 0
      && lastBoard.event !== 'Manual reset' && !takingOut;
    if (state.visit && !state.legacyVisit) state.previousVisit = snapshotCurrentTurn();
    state.currentPlayer = (state.currentPlayer + 1) % state.players.length;
    state.turnSerial += 1;
    resetHandled = false;
    beginVisit();
    state.boardGate = actorInputMode(state.currentPlayer) === 'board' && !reviewedBoardIsEmpty ? 'await-empty' : 'ready';
    state.notice = '';
    update();
    if (network.role === 'host' && state.currentPlayer === 0 && state.inputMode === 'board' && lastRawBoardMessage) {
      handleBoardMessage(lastRawBoardMessage, 0);
    }
  }
  function previousPlayer() {
    if (state.screen !== 'game' || !validTurnSnapshot(state.previousVisit, state.players.length) || takingOut) return;
    if (state.visit?.throws?.length) {
      state.notice = 'Der aktuelle Spieler hat bereits Würfe. Diese Aufnahme zuerst zurücksetzen oder korrigieren.';
      update();
      return;
    }
    const snapshot = clone(state.previousVisit);
    state.players = snapshot.players;
    state.currentPlayer = snapshot.currentPlayer;
    state.visit = snapshot.visit;
    state.turnDarts = snapshot.turnDarts;
    state.turnSerial = snapshot.turnSerial;
    state.winner = snapshot.winner;
    state.previousVisit = null;
    state.legacyVisit = false;
    takingOut = false;
    state.boardGate = actorInputMode(state.currentPlayer) === 'board' ? 'review' : 'ready';
    state.notice = 'Vorherige Aufnahme geöffnet. Würfe korrigieren oder zurücksetzen und danach mit „Nächster Spieler“ fortfahren.';
    update();
  }
  function resetVisit() {
    if (state.screen !== 'game' || !state.visit || state.legacyVisit || takingOut || !['ready', 'review'].includes(state.boardGate)) return;
    if (actorInputMode(state.currentPlayer) === 'test') {
      state.visit.throws = [];
      state.visit.overrides = {};
      replayVisit();
      state.notice = 'Aktuelle Würfe zurückgesetzt.';
    } else {
      state.visit.throws.forEach((_, i) => { state.visit.overrides[i] = null; });
      replayVisit();
      state.notice = 'Wertung dieser Aufnahme zurückgesetzt. Erkannte Wurfplätze bleiben belegt und können unten einzeln korrigiert werden.';
    }
    update();
  }
  function undo() {
    if (state.screen !== 'game' || !state.visit || state.legacyVisit || state.boardGate === 'finished') return;
    if (actorInputMode(state.currentPlayer) === 'test') {
      state.visit.throws.pop();
      delete state.visit.overrides[state.visit.throws.length];
    }
    else {
      if (!['ready', 'review'].includes(state.boardGate) || takingOut) return;
      const index = state.visit.throws.findLastIndex((_, i) => effectiveThrow(i) !== null);
      if (index < 0) return;
      // Keep the physical slot occupied so the next snapshot cannot add this dart again.
      state.visit.overrides[index] = null;
    }
    replayVisit();
    update();
  }
  function correctThrow(index, value) {
    if (!state.visit || state.legacyVisit || !['ready', 'review'].includes(state.boardGate) || takingOut || !Number.isInteger(index) || index < 0 || index >= 3) return;
    if (actorInputMode() === 'board' && state.visit.boardThrows === undefined) state.visit.boardThrows = clone(state.visit.throws);
    if (value === 'board') {
      if (index >= state.visit.throws.length) return;
      delete state.visit.overrides[index];
    }
    else {
      const segment = value === 'ignore' ? null : normalizeSegment({ name: value });
      if (segment === null && value !== 'ignore') return;
      while (state.visit.throws.length <= index) {
        const slot = state.visit.throws.length;
        state.visit.throws.push({ number: 0, multiplier: 0, name: 'MISS' });
        state.visit.overrides[slot] = null;
      }
      state.visit.overrides[index] = segment;
    }
    replayVisit();
    update();
  }
  function startGame() {
    if (network.role === 'guest' || (network.role === 'host' && !network.connected)) return;
    const inputs = [...document.querySelectorAll(`#${APP_ID}-player-list input[data-player-name]`)];
    if (inputs.length < 2 || inputs.length > 8) return;
    state.players = inputs.map((input, i) => ({ name: input.value.trim() || `Spieler ${i + 1}`, marks: {}, score: 0 }));
    if (network.role === 'host') {
      state.players = state.players.slice(0, 2);
      state.players[0].name = sanitizeName(state.players[0].name, 'Host');
      state.players[1].name = sanitizeName(remoteProfile.name, 'Freund');
    }
    state.targets = generateTargets();
    state.currentPlayer = 0;
    state.turnSerial = 0;
    state.winner = null;
    state.previousVisit = null;
    state.screen = 'game';
    state.notice = '';
    beginVisit();
    // Starting explicitly confirms an empty board. Keep a healthy connection
    // and its empty snapshot; don't discard the first visit waiting for an event
    // that an event-only Board Manager may never send. Known old darts still block.
    state.boardGate = state.inputMode === 'board' && lastBoard?.throws.length ? 'await-empty' : 'ready';
    takingOut = false;
    if (state.inputMode === 'board') {
      try { if (socket && socket.url !== boardWsUrl()) disconnectBoard(); }
      catch (_) { disconnectBoard(); } // connectBoard reports invalid addresses in the UI.
      connectBoard();
    }
    else disconnectBoard();
    update();
  }
  function newGame() {
    if (network.role === 'guest') return;
    state.screen = 'setup';
    state.winner = null;
    state.visit = null;
    state.previousVisit = null;
    state.turnDarts = 0;
    state.legacyVisit = false;
    state.notice = '';
    state.boardGate = 'await-empty';
    update();
  }
  function addPlayer() {
    if (network.role !== 'local' || state.players.length >= 8) return;
    state.players.push({ name: `Spieler ${state.players.length + 1}`, marks: {}, score: 0 });
    update();
  }
  function removePlayer() { if (network.role === 'local' && state.players.length > 2) { state.players.pop(); update(); } }

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
    lastRawBoardMessage = null;
    takingOut = false;
    resetHandled = false;
    connectionStatus = state.inputMode === 'test' ? 'Testmodus – ohne Kameras' : 'Nicht verbunden';
    if (network.role === 'guest') sendGuestMessage({ type: 'board-status', connected: false });
  }
  function blockForSync(message, actorIndex = localPlayerIndex()) {
    if (actorIndex !== state.currentPlayer) return;
    if (state.screen === 'game' && actorInputMode(actorIndex) === 'board' && !['await-empty', 'finished', 'review'].includes(state.boardGate)) {
      state.boardGate = 'sync';
      state.notice = message;
    }
  }
  function connectBoard(force = false) {
    if (state.inputMode !== 'board') return;
    if (force) {
      if (network.role !== 'guest') {
        blockForSync('Verbindung neu gestartet. Aktuelle Aufnahme prüfen und unten synchronisieren.', network.role === 'host' ? 0 : state.currentPlayer);
      }
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
      if (network.role === 'guest') {
        sendGuestMessage({ type: 'board-status', connected: true });
        sendGuestProfile();
      }
      update();
    });
    active.addEventListener('message', (event) => {
      if (socket !== active || state.inputMode !== 'board') return;
      lastRawBoardMessage = String(event.data || '');
      if (network.role === 'guest') {
        inspectLocalBoardMessage(lastRawBoardMessage);
        forwardGuestBoard();
      } else {
        handleBoardMessage(lastRawBoardMessage, network.role === 'host' ? 0 : state.currentPlayer);
      }
    });
    active.addEventListener('close', () => {
      if (socket !== active) return;
      socket = null;
      state.connected = false;
      lastBoard = null;
      lastRawBoardMessage = null;
      takingOut = false;
      connectionStatus = 'Verbindung unterbrochen. Neuer Versuch in 3 Sekunden.';
      if (network.role === 'guest') sendGuestMessage({ type: 'board-status', connected: false });
      else blockForSync('Während der Unterbrechung können Würfe oder Spielerwechsel fehlen. Aufnahme nach dem Verbinden prüfen.', network.role === 'host' ? 0 : state.currentPlayer);
      update();
      reconnectTimer = setTimeout(() => connectBoard(), 3000);
    });
    active.addEventListener('error', () => {
      if (socket !== active) return;
      state.connected = false;
      lastBoard = null;
      lastRawBoardMessage = null;
      if (network.role === 'guest') sendGuestMessage({ type: 'board-status', connected: false });
      else blockForSync('Verbindungsfehler. Aufnahme nach dem Verbinden prüfen.', network.role === 'host' ? 0 : state.currentPlayer);
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
  function inspectLocalBoardMessage(raw) {
    let packet;
    try { packet = JSON.parse(raw); } catch (_) { return; }
    if (!packet || typeof packet !== 'object' || (packet.type && packet.type !== 'state')) return;
    const data = packet.data ?? packet;
    const board = parseBoardState(data);
    lastEvent = String(data?.event || data?.status || 'Zustand');
    if (!board) {
      lastBoard = null;
      connectionStatus = 'Unvollständige oder ungültige Board-Meldung; keine Punkte übernommen.';
    } else {
      lastBoard = board;
      connectionStatus = board.running ? 'Board meldet Daten' : 'Erkennung ist angehalten';
    }
    render();
  }
  function handleBoardMessage(raw, actorIndex = localPlayerIndex()) {
    if (actorIndex !== state.currentPlayer || actorInputMode(actorIndex) !== 'board') return;
    let packet;
    try { packet = JSON.parse(raw); } catch (_) { return; }
    if (!packet || typeof packet !== 'object' || (packet.type && packet.type !== 'state')) return;
    const data = packet.data ?? packet;
    const board = parseBoardState(data);
    if (network.role === 'host' && actorIndex === 1) {
      remoteProfile.lastEvent = String(data?.event || data?.status || 'Zustand');
      remoteProfile.boardConnected = true;
      remoteBoard = board;
    } else {
      lastEvent = String(data?.event || data?.status || 'Zustand');
      lastBoard = board;
    }
    if (!board) {
      if (!(network.role === 'host' && actorIndex === 1)) connectionStatus = 'Unvollständige oder ungültige Board-Meldung; keine Punkte übernommen.';
      render();
      return;
    }
    if (!(network.role === 'host' && actorIndex === 1)) connectionStatus = board.running ? 'Board meldet Daten' : 'Erkennung ist angehalten';
    if (state.screen !== 'game' || state.boardGate === 'finished') { render(); return; }
    if (state.boardGate === 'review' && network.role !== 'local') { render(); return; }
    if (!boardOperational(board)) {
      blockForSync('Die Erkennung wurde angehalten oder neu gestartet. Board und Aufnahme vor dem Fortsetzen prüfen.', actorIndex);
      update();
      return;
    }
    if (board.event === 'Takeout finished' && board.throws.length === 0) takingOut = false;
    if (board.event === 'Takeout started' || board.status === 'Takeout in progress') { takingOut = true; update(); return; }
    if (state.boardGate === 'sync' || state.boardGate === 'review') { render(); return; }
    if (board.event !== 'Manual reset') resetHandled = false;
    if (board.event === 'Manual reset') {
      if (resetHandled) return;
      resetHandled = true;
      // Roll back this visit only. The physical board must be cleared explicitly before reuse.
      if (state.visit && !state.legacyVisit) { state.visit.throws = []; state.visit.overrides = {}; state.visit.boardThrows = []; replayVisit(); }
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
      else if (state.visit?.throws.length) {
        nextPlayer();
        // Only local players share the board just emptied. The online opponent
        // must confirm their own board is empty before any cached darts can count.
        if (network.role === 'local') state.boardGate = 'ready';
      }
      update();
      return;
    }
    if (takingOut) { render(); return; }
    if (board.throws.length < ((state.visit?.boardThrows ?? state.visit?.throws)?.length || 0) && !/correct|undo|remove/i.test(board.event)) {
      blockForSync('Die Wurfanzahl ist unerwartet gesunken. Aufnahme prüfen; möglicherweise fehlt der Spielerwechsel.', actorIndex);
      update();
      return;
    }
    if (JSON.stringify(state.visit?.boardThrows ?? state.visit?.throws) !== JSON.stringify(board.throws)) {
      reconcileVisit(board.throws);
      update();
    }
  }
  function resumeBoard(actorIndex = localPlayerIndex()) {
    const board = actorBoard(actorIndex);
    if (actorIndex !== state.currentPlayer || state.boardGate !== 'sync' || !actorBoardConnected(actorIndex)
      || !boardOperational(board) || state.legacyVisit || takingOut) return;
    if (board.throws.length === 0 && state.visit?.throws.length) return; // User must finish the scored visit instead.
    reconcileVisit(board.throws);
    state.boardGate = 'ready';
    state.notice = '';
    update();
  }


  function remainingMarks(player, target) {
    return Math.max(0, 3 - getMarks(player, target));
  }

  function dartboardSvg() {
    const order = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
    const current = state.players[state.currentPlayer];
    const targetSet = new Set(state.targets);
    const cx = 260;
    const cy = 260;
    const polar = (r, deg) => {
      const rad = deg * Math.PI / 180;
      return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
    };
    const sectorPath = (r1, r2, startDeg, endDeg) => {
      const [a1x, a1y] = polar(r2, startDeg);
      const [a2x, a2y] = polar(r2, endDeg);
      const [b2x, b2y] = polar(r1, endDeg);
      const [b1x, b1y] = polar(r1, startDeg);
      return `M ${a1x.toFixed(2)} ${a1y.toFixed(2)} A ${r2} ${r2} 0 0 1 ${a2x.toFixed(2)} ${a2y.toFixed(2)} L ${b2x.toFixed(2)} ${b2y.toFixed(2)} A ${r1} ${r1} 0 0 0 ${b1x.toFixed(2)} ${b1y.toFixed(2)} Z`;
    };

    const wedges = order.map((number, i) => {
      const center = -90 + i * 18;
      const start = center - 9;
      const end = center + 9;
      const even = i % 2 === 0;
      const base = even ? '#f3ead9' : '#26313b';
      const ring = even ? '#c63f3a' : '#2c8a52';
      const isTarget = targetSet.has(number);
      const closed = isTarget && current && getMarks(current, number) >= 3;
      const overlay = isTarget ? `<path d="${sectorPath(34, 190, start, end)}" fill="${closed ? 'rgba(22,163,74,.18)' : 'rgba(245,158,11,.24)'}" stroke="${closed ? '#16a34a' : '#f59e0b'}" stroke-width="${closed ? 2 : 4}"/>` : '';
      return `
        <path d="${sectorPath(34, 190, start, end)}" fill="${base}" stroke="#d9dee7" stroke-width="1"/>
        <path d="${sectorPath(112, 126, start, end)}" fill="${ring}" stroke="#e7ebf0" stroke-width="1"/>
        <path d="${sectorPath(174, 190, start, end)}" fill="${ring}" stroke="#e7ebf0" stroke-width="1"/>
        ${overlay}`;
    }).join('');

    const numbers = order.map((number, i) => {
      const angle = -90 + i * 18;
      const [x, y] = polar(220, angle);
      const isTarget = targetSet.has(number);
      const closed = isTarget && current && getMarks(current, number) >= 3;
      const size = isTarget && !closed ? 30 : isTarget ? 23 : 17;
      const fill = isTarget && !closed ? '#b45309' : closed ? '#16a34a' : '#667085';
      const weight = isTarget ? 900 : 700;
      return `<text x="${x.toFixed(1)}" y="${(y + 6).toFixed(1)}" text-anchor="middle" font-size="${size}" font-weight="${weight}" fill="${fill}">${number}</text>`;
    }).join('');

    const bullTarget = targetSet.has(25);
    const bullClosed = bullTarget && current && getMarks(current, 25) >= 3;
    const bullStroke = bullTarget ? (bullClosed ? '#16a34a' : '#f59e0b') : '#d9dee7';
    return `
      <svg class="${APP_ID}-board-svg" viewBox="0 0 520 520" role="img" aria-label="Dartscheibe mit hervorgehobenen Cricket-Zielen">
        <circle cx="260" cy="260" r="246" fill="#ffffff" stroke="#dce2ea" stroke-width="3"/>
        <circle cx="260" cy="260" r="196" fill="#111827" stroke="#111827" stroke-width="2"/>
        ${wedges}
        <circle cx="260" cy="260" r="34" fill="#2c8a52" stroke="#eef1f5" stroke-width="2"/>
        <circle cx="260" cy="260" r="15" fill="#c63f3a" stroke="${bullStroke}" stroke-width="${bullTarget ? 5 : 2}"/>
        ${bullTarget ? `<circle cx="260" cy="260" r="39" fill="none" stroke="${bullStroke}" stroke-width="${bullClosed ? 3 : 5}"/>` : ''}
        ${numbers}
      </svg>`;
  }

  function injectStyles() {
    if (document.getElementById(`${APP_ID}-style`)) return;
    const style = document.createElement('style');
    style.id = `${APP_ID}-style`;
    style.textContent = `
      :root{--${APP_ID}-bg:#f4f7fb;--${APP_ID}-text:#172033;--${APP_ID}-muted:#697386;--${APP_ID}-line:#dfe5ec;--${APP_ID}-accent:#f59e0b;--${APP_ID}-green:#16a34a}
      #${APP_ID}-launcher{position:fixed;right:18px;bottom:18px;z-index:2147483646;border:1px solid #dfe5ec;border-radius:999px;padding:13px 18px;font:800 14px/1 system-ui,-apple-system,sans-serif;cursor:pointer;background:#fff;color:#172033;box-shadow:0 10px 32px #25324a33}
      #${APP_ID}-panel{position:fixed;inset:10px;z-index:2147483645;background:var(--${APP_ID}-bg);color:var(--${APP_ID}-text);border:1px solid #d7dee7;border-radius:22px;box-shadow:0 24px 80px #23324a33;overflow:auto;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      #${APP_ID}-panel.${APP_ID}-hidden{display:none}#${APP_ID}-panel *{box-sizing:border-box}
      .${APP_ID}-wrap{max-width:1500px;margin:0 auto;padding:18px 22px 28px}
      .${APP_ID}-top{position:sticky;top:0;z-index:4;display:flex;align-items:center;justify-content:space-between;gap:12px;margin:-18px -22px 18px;padding:15px 22px;background:#f4f7fbf2;border-bottom:1px solid #e1e6ed;backdrop-filter:blur(14px)}
      .${APP_ID}-title{display:flex;align-items:center;gap:10px;font-size:22px;font-weight:900;color:#172033}
      .${APP_ID}-badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:6px 10px;border-radius:999px;background:#fff;color:#5d6878;border:1px solid #dfe5ec;font-weight:800}
      .${APP_ID}-dot{width:9px;height:9px;border-radius:50%;display:inline-block;background:#dc4c4c}.connected .${APP_ID}-dot{background:#22a95a}
      .${APP_ID}-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
      #${APP_ID}-panel button,#${APP_ID}-panel input,#${APP_ID}-panel select{font:inherit}#${APP_ID}-panel button:disabled{opacity:.42;cursor:not-allowed}
      #${APP_ID}-panel select{max-width:100%;background:#fff;color:#172033;border:1px solid #cfd7e2;border-radius:10px;padding:8px 10px}
      .${APP_ID}-btn{border:1px solid #cfd7e2;background:#fff;color:#263449;border-radius:12px;padding:10px 13px;cursor:pointer;font-weight:800;box-shadow:0 1px 2px #23324a0d}
      .${APP_ID}-btn:hover{background:#f8fafc}.primary{background:#f59e0b;border-color:#f59e0b;color:#402b00}.primary:hover{background:#fbbf24}.danger{color:#a73535;border-color:#e7b7b7;background:#fffafa}
      .${APP_ID}-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
      .${APP_ID}-card{background:#fff;border:1px solid #dde4ec;border-radius:18px;padding:17px;box-shadow:0 4px 18px #23324a0b}
      .${APP_ID}-card h3{margin:0 0 12px;font-size:15px;color:#4a5668}.${APP_ID}-seg{display:flex;gap:8px;flex-wrap:wrap}
      .${APP_ID}-seg button{border:1px solid #d4dce6;background:#fff;color:#586476;border-radius:10px;padding:9px 12px;cursor:pointer}.${APP_ID}-seg button.active{background:#fff0c7;color:#7a4a00;border-color:#f3b94c;font-weight:900}
      .${APP_ID}-players{display:grid;gap:8px}.${APP_ID}-player-row{display:flex;gap:8px}.${APP_ID}-player-row input,.${APP_ID}-input{width:100%;border:1px solid #cfd7e2;background:#fff;color:#172033;border-radius:10px;padding:10px 12px;outline:none}.${APP_ID}-player-row input:focus,.${APP_ID}-input:focus{border-color:#f59e0b;box-shadow:0 0 0 3px #f59e0b22}
      .${APP_ID}-hint{font-size:12px;color:#697386;line-height:1.5;margin-top:8px}
      .${APP_ID}-room-code{font-size:34px;font-weight:950;letter-spacing:.18em;color:#172033;background:#f8fafc;border:1px dashed #aeb9c8;border-radius:14px;padding:12px 16px;text-align:center;margin:10px 0}
      .${APP_ID}-network-status{padding:10px 12px;border-radius:11px;background:#eef4fb;border:1px solid #d8e4f2;color:#40516a;font-size:13px;margin-top:10px}
      .${APP_ID}-online-dot{width:9px;height:9px;border-radius:50%;display:inline-block;background:#dc4c4c}.online-connected .${APP_ID}-online-dot{background:#22a95a}
      .${APP_ID}-game-layout{display:grid;grid-template-columns:minmax(330px,.82fr) minmax(520px,1.7fr);gap:18px;align-items:start}
      .${APP_ID}-board-card{position:sticky;top:76px;background:#fff;border:1px solid #dde4ec;border-radius:22px;padding:16px;box-shadow:0 8px 28px #23324a12}
      .${APP_ID}-status{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:13px 14px;border-radius:14px;background:#eef4fb;border:1px solid #d8e4f2;margin-bottom:12px}.${APP_ID}-status strong{font-size:18px}.${APP_ID}-status.takeout{background:#fff3d8;border-color:#f6ca6a}.${APP_ID}-status.sync{background:#fff0f0;border-color:#efb6b6}.${APP_ID}-status.review{background:#eef6ff;border-color:#9fc8f4}
      .${APP_ID}-board-wrap{display:flex;justify-content:center;align-items:center}.${APP_ID}-board-svg{display:block;width:min(100%,470px);height:auto;filter:drop-shadow(0 8px 13px #23324a18)}
      .${APP_ID}-legend{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:6px;font-size:12px;color:#697386}.${APP_ID}-legend span{display:inline-flex;align-items:center;gap:5px}.${APP_ID}-swatch{width:10px;height:10px;border-radius:3px;display:inline-block;background:#f59e0b}.${APP_ID}-swatch.closed{background:#16a34a}
      .${APP_ID}-visit{margin-top:13px;padding-top:13px;border-top:1px solid #e5e9ef}.${APP_ID}-visit-title{font-size:12px;font-weight:900;color:#697386;text-transform:uppercase;letter-spacing:.06em}.${APP_ID}-throw-row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px}.${APP_ID}-throw{display:flex;align-items:center;justify-content:center;min-height:54px;border-radius:13px;background:#f7f9fc;border:1px solid #dde4ec;font-size:22px;font-weight:900;color:#23324a}.${APP_ID}-throw.used{background:#fff5df;border-color:#f5c968;color:#8a5200}
      .${APP_ID}-game-main{display:grid;gap:14px}.${APP_ID}-player-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.${APP_ID}-player-card{background:#fff;border:1px solid #dde4ec;border-radius:16px;padding:13px 14px;min-width:0}.${APP_ID}-player-card.active{border:2px solid #f59e0b;background:#fff8e8;box-shadow:0 5px 18px #f59e0b1f}.${APP_ID}-player-name{font-size:16px;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.${APP_ID}-player-score{font-size:32px;font-weight:950;line-height:1;margin-top:7px;color:#172033}.${APP_ID}-player-progress{font-size:12px;color:#697386;margin-top:6px}
      .${APP_ID}-needed-card{background:#fff;border:1px solid #dde4ec;border-radius:20px;padding:16px}.${APP_ID}-needed-head{display:flex;justify-content:space-between;align-items:end;gap:10px;margin-bottom:12px}.${APP_ID}-needed-head h2{margin:0;font-size:20px}.${APP_ID}-needed-head span{font-size:12px;color:#697386}
      .${APP_ID}-targets{display:grid;grid-template-columns:repeat(7,minmax(86px,1fr));gap:9px;margin:0}.${APP_ID}-target{position:relative;min-height:104px;border-radius:16px;padding:10px;background:#fff4d6;border:2px solid #f2bd52;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center}.${APP_ID}-target.closed{background:#f2f5f7;border-color:#d9e0e8;color:#8993a3}.${APP_ID}-target-number{font-size:42px;line-height:.95;font-weight:950;letter-spacing:-.04em}.${APP_ID}-target.open .${APP_ID}-target-number{font-size:50px;color:#9a5b00}.${APP_ID}-target-mark{font-size:24px;line-height:1;margin-top:7px;font-weight:900}.${APP_ID}-target-remaining{font-size:11px;font-weight:800;margin-top:6px;color:#697386}.${APP_ID}-target.open .${APP_ID}-target-remaining{color:#9a5b00}
      .${APP_ID}-score-card{background:#fff;border:1px solid #dde4ec;border-radius:20px;padding:12px 14px 14px;overflow:auto}.${APP_ID}-score-card h3{margin:3px 2px 8px;font-size:15px;color:#4a5668}
      .${APP_ID}-scoreboard{width:100%;border-collapse:separate;border-spacing:0 6px;min-width:520px}.${APP_ID}-scoreboard th{font-size:13px;color:#697386;padding:6px 8px}.${APP_ID}-scoreboard td{background:#f8fafc;border-top:1px solid #e3e8ef;border-bottom:1px solid #e3e8ef;padding:10px 8px;text-align:center;font-weight:850}.${APP_ID}-scoreboard td:first-child{border-radius:11px 0 0 11px;border-left:1px solid #e3e8ef;text-align:left}.${APP_ID}-scoreboard td:last-child{border-radius:0 11px 11px 0;border-right:1px solid #e3e8ef}.${APP_ID}-scoreboard .active-player{background:#fff5df;border-color:#f1c970}.${APP_ID}-marks{font-size:25px;letter-spacing:1px}.${APP_ID}-closed{color:#16a34a}.${APP_ID}-score{font-size:26px}.${APP_ID}-row-target{font-size:20px;font-weight:950;color:#657185}.${APP_ID}-row-target.needed{font-size:29px;color:#9a5b00;background:#fff7e8;border-color:#f4cf84}
      .${APP_ID}-winner{margin:10px 0 16px;padding:18px;border-radius:18px;background:#eaf8ef;border:1px solid #8bd0a2;font-size:23px;font-weight:950;text-align:center;color:#176a34}
      .${APP_ID}-test{display:flex;flex-wrap:wrap;gap:7px;margin-top:9px}.${APP_ID}-test button{padding:8px 10px;font-size:12px}
      @media(max-width:1050px){.${APP_ID}-game-layout{grid-template-columns:1fr}.${APP_ID}-board-card{position:relative;top:auto}.${APP_ID}-board-svg{width:min(100%,390px)}.${APP_ID}-targets{grid-template-columns:repeat(4,minmax(80px,1fr))}}
      @media(max-width:760px){#${APP_ID}-panel{inset:4px;border-radius:14px}.${APP_ID}-wrap{padding:12px}.${APP_ID}-top{margin:-12px -12px 12px;padding:12px}.${APP_ID}-grid2{grid-template-columns:1fr}.${APP_ID}-top{align-items:flex-start}.${APP_ID}-title{font-size:18px}.${APP_ID}-targets{grid-template-columns:repeat(2,minmax(0,1fr))}.${APP_ID}-target{min-height:86px}.${APP_ID}-target-number,.${APP_ID}-target.open .${APP_ID}-target-number{font-size:38px}.${APP_ID}-player-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.${APP_ID}-scoreboard{font-size:12px}.${APP_ID}-scoreboard td{padding:9px 5px}.${APP_ID}-row-target.needed{font-size:24px}}
    `;
    document.head.appendChild(style);
  }


  function ensureUi() {
    injectStyles();

    if (!document.getElementById(`${APP_ID}-launcher`)) {
      const launcher = document.createElement('button');
      launcher.id = `${APP_ID}-launcher`;
      launcher.textContent = '🎯 Cricket Random Cutthroat';
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
    const setupPlayers = network.role === 'local' ? state.players : state.players.slice(0, 2);
    const editableIndex = network.role === 'guest' ? 1 : 0;
    const playerRows = setupPlayers.map((player, index) => `
      <div class="${APP_ID}-player-row">
        <input data-player-name="${index}" value="${escapeHtml(player.name)}" aria-label="Spieler ${index + 1}"
          ${network.role !== 'local' && index !== editableIndex ? 'disabled' : ''}>
      </div>
    `).join('');

    const onlineCard = network.role === 'host' ? `
      <div class="${APP_ID}-room-code">${escapeHtml(network.roomCode || '------')}</div>
      <div class="${APP_ID}-actions">
        <button class="${APP_ID}-btn" data-action="copy-room" ${network.roomCode ? '' : 'disabled'}>Code kopieren</button>
        <button class="${APP_ID}-btn" data-action="online-host">Neuer Code</button>
        <button class="${APP_ID}-btn danger" data-action="online-local">Online verlassen</button>
      </div>
      <div class="${APP_ID}-network-status">${escapeHtml(networkStatus)}</div>
      <div class="${APP_ID}-hint">Diesen Code dem Freund schicken. Der Raum ist für genau zwei Spieler ausgelegt.</div>
    ` : network.role === 'guest' ? `
      <input id="${APP_ID}-room" class="${APP_ID}-input" value="${escapeHtml(network.roomCode)}" maxlength="6" placeholder="Raumcode" autocomplete="off">
      <div class="${APP_ID}-actions" style="margin-top:10px">
        <button class="${APP_ID}-btn primary" data-action="online-join">Raum beitreten</button>
        <button class="${APP_ID}-btn danger" data-action="online-local">Online verlassen</button>
      </div>
      <div class="${APP_ID}-network-status">${escapeHtml(networkStatus)}</div>
      <div class="${APP_ID}-hint">Der Host startet das Spiel, sobald die Verbindung steht.</div>
    ` : `<div class="${APP_ID}-hint" style="font-size:13px;margin-top:0">Lokal spielen oder einen privaten Raum für einen Freund öffnen. Die Spielstände werden im Online-Modus direkt und verschlüsselt zwischen beiden Browsern übertragen.</div>`;

    const startDisabled = network.role === 'guest' || (network.role === 'host' && !network.connected);
    const startLabel = network.role === 'guest' ? 'Host startet das Spiel'
      : network.role === 'host' && !network.connected ? 'Auf Freund warten' : 'Ziele auslosen & starten';

    return `
      <div class="${APP_ID}-grid2">
        <div class="${APP_ID}-card">
          <h3>Spielart</h3>
          <div class="${APP_ID}-seg">
            <button data-action="online-local" class="${network.role === 'local' ? 'active' : ''}">Lokal</button>
            <button data-action="online-host" class="${network.role === 'host' ? 'active' : ''}">Online hosten</button>
            <button data-action="online-guest-mode" class="${network.role === 'guest' ? 'active' : ''}">Online beitreten</button>
          </div>
          ${onlineCard}
        </div>
        <div class="${APP_ID}-card">
          <h3>Spieler</h3>
          <div id="${APP_ID}-player-list" class="${APP_ID}-players">${playerRows}</div>
          ${network.role === 'local' ? `<div class="${APP_ID}-actions" style="margin-top:10px">
            <button class="${APP_ID}-btn" data-action="add-player">+ Spieler</button>
            <button class="${APP_ID}-btn" data-action="remove-player" ${state.players.length <= 2 ? 'disabled' : ''}>− Spieler</button>
          </div>` : `<div class="${APP_ID}-hint">${network.role === 'host' ? 'Oben: du. Unten: dein verbundener Freund.' : 'Oben: Host. Unten: du.'}</div>`}
        </div>
        <div class="${APP_ID}-card">
          <h3>Bull</h3>
          <div class="${APP_ID}-seg">
            ${['always','never','random'].map((mode) => `<button data-bull="${mode}" class="${state.bullMode === mode ? 'active' : ''}" ${network.role === 'guest' ? 'disabled' : ''}>${mode === 'always' ? 'Immer' : mode === 'never' ? 'Nie' : 'Zufällig'}</button>`).join('')}
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
      ${state.inputMode === 'board' ? `<p class="${APP_ID}-hint">Vor dem Start alle Darts herausziehen. Mit Start bestätigst du ein leeres Board.</p>` : ''}
      <div class="${APP_ID}-actions" style="margin-top:16px;justify-content:flex-end">
        <button class="${APP_ID}-btn primary" data-action="start" ${startDisabled ? 'disabled' : ''}>${startLabel}</button>
      </div>
    `;
  }

  function gameHtml() {
    const current = state.players[state.currentPlayer];
    const currentMode = actorInputMode(state.currentPlayer);
    const activeBoard = actorBoard(state.currentPlayer);
    const localMayAct = network.role !== 'guest' || (network.connected && isLocalTurn());
    const statusClass = state.boardGate === 'sync' ? 'sync' : state.boardGate === 'review' ? 'review' : (takingOut || state.turnDarts >= 3 ? 'takeout' : '');
    const statusText = state.winner !== null ? `${state.players[state.winner].name} gewinnt!`
      : state.boardGate === 'sync' ? 'Aufnahme synchronisieren'
      : state.boardGate === 'review' ? 'Vorherigen Spieler korrigieren'
      : currentMode === 'board' && state.boardGate === 'await-empty' ? 'Board leeren'
      : takingOut || state.turnDarts >= 3 ? 'Darts herausziehen'
      : `${current?.name || 'Spieler'} ist dran`;

    const headers = state.players.map((player, index) => `<th>${escapeHtml(player.name)}${index === state.currentPlayer ? ' 🎯' : ''}</th>`).join('');
    const targetRows = orderedTargets().map((target) => {
      const cells = state.players.map((player, index) => {
        const marks = getMarks(player, target);
        const cls = `${index === state.currentPlayer ? 'active-player ' : ''}${marks >= 3 ? `${APP_ID}-closed` : ''}`;
        return `<td class="${cls}"><span class="${APP_ID}-marks">${MARKS[marks]}</span></td>`;
      }).join('');
      const needed = current && remainingMarks(current, target) > 0;
      return `<tr><td class="${APP_ID}-row-target ${needed ? 'needed' : ''}">${targetLabel(target)}</td>${cells}</tr>`;
    }).join('');

    const scoreCells = state.players.map((player, index) => `<td class="${index === state.currentPlayer ? 'active-player' : ''}"><span class="${APP_ID}-score">${player.score}</span></td>`).join('');
    const winner = state.winner !== null ? `<div class="${APP_ID}-winner">🏆 ${escapeHtml(state.players[state.winner].name)} gewinnt!</div>` : '';
    const visitEditable = localMayAct && ['ready', 'review'].includes(state.boardGate) && !takingOut && !state.legacyVisit;
    const canUndo = visitEditable && state.visit?.throws.some((_, i) => effectiveThrow(i) !== null);
    const canReset = visitEditable && Boolean(state.visit?.throws?.length);
    const canPrevious = Boolean(state.previousVisit) && !takingOut && !state.legacyVisit && !state.visit?.throws?.length;
    const choices = ['MISS', ...Array.from({ length: 20 }, (_, i) => i + 1).flatMap((n) => ['S', 'D', 'T'].map((m) => `${m}${n}`)), 'S25', 'D25'];
    const corrections = [0, 1, 2].map((i) => {
      const segment = currentMode === 'board' && state.visit?.boardThrows
        ? state.visit.boardThrows[i] : state.visit?.throws[i];
      const selected = Object.hasOwn(state.visit?.overrides || {}, i) ? (effectiveThrow(i)?.name || 'ignore') : 'board';
      return `<label>Dart ${i + 1}: <select data-correct="${i}" aria-label="Dart ${i + 1} korrigieren" ${visitEditable ? '' : 'disabled'}>
        <option value="board" ${selected === 'board' ? 'selected' : ''}>${segment ? `${escapeHtml(segment.name)} (Original)` : 'Nicht erkannt / noch nicht geworfen'}</option>
        <option value="ignore" ${selected === 'ignore' ? 'selected' : ''}>Gestrichen</option>
        ${choices.map((value) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${value}</option>`).join('')}
      </select></label>`;
    }).join(' ');
    const canResume = localMayAct && actorBoardConnected(state.currentPlayer) && boardOperational(activeBoard) && !state.legacyVisit && !takingOut
      && (activeBoard.throws.length > 0 || !state.visit?.throws.length);

    const playerCards = state.players.map((player, index) => {
      const closed = state.targets.filter((target) => getMarks(player, target) >= 3).length;
      return `<div class="${APP_ID}-player-card ${index === state.currentPlayer ? 'active' : ''}">
        <div class="${APP_ID}-player-name">${index === state.currentPlayer ? '🎯 ' : ''}${escapeHtml(player.name)}</div>
        <div class="${APP_ID}-player-score">${player.score}</div>
        <div class="${APP_ID}-player-progress">${closed}/7 Ziele geschlossen</div>
      </div>`;
    }).join('');

    const targetCards = orderedTargets().map((target) => {
      const marks = current ? getMarks(current, target) : 0;
      const remaining = Math.max(0, 3 - marks);
      const closed = remaining === 0;
      return `<div class="${APP_ID}-target ${closed ? 'closed' : 'open'}">
        <div class="${APP_ID}-target-number">${targetLabel(target)}</div>
        <div class="${APP_ID}-target-mark">${MARKS[marks]}</div>
        <div class="${APP_ID}-target-remaining">${closed ? 'geschlossen' : `noch ${remaining} ${remaining === 1 ? 'Mark' : 'Marks'}`}</div>
      </div>`;
    }).join('');

    const throws = [0, 1, 2].map((i) => {
      const segment = state.visit && i < state.visit.throws.length ? effectiveThrow(i) : null;
      return `<div class="${APP_ID}-throw ${i < state.turnDarts ? 'used' : ''}">${escapeHtml(segment?.name || '—')}</div>`;
    }).join('');

    return `
      ${winner}
      ${currentMode === 'board' && state.boardGate === 'sync' ? `<div class="${APP_ID}-card" role="status" style="margin-bottom:14px">
        <b>Aufnahme synchronisieren</b>
        <p>${activeBoard ? `Board meldet: ${activeBoard.throws.map((s) => escapeHtml(s.name)).join(', ') || 'keine Darts'}.` : 'Auf eine gültige Board-Meldung warten.'}</p>
        <div class="${APP_ID}-hint">Nur fortsetzen, wenn die gemeldeten Darts zur aktuellen Aufnahme gehören. Bei bereits entnommenen Darts die Aufnahme abschließen.</div>
        <button class="${APP_ID}-btn" data-action="resume" ${canResume ? '' : 'disabled'}>${activeBoard?.throws.length ? 'Aufnahme für aktuellen Spieler übernehmen' : 'Mit leerem Board fortsetzen'}</button>
      </div>` : ''}
      <div class="${APP_ID}-game-layout">
        <section class="${APP_ID}-board-card">
          <div class="${APP_ID}-status ${statusClass}" role="status">
            <strong>${escapeHtml(statusText)}</strong>
            <span>${state.turnDarts}/3 Darts</span>
          </div>
          <div class="${APP_ID}-board-wrap">${dartboardSvg()}</div>
          <div class="${APP_ID}-legend"><span><i class="${APP_ID}-swatch"></i>noch benötigt</span><span><i class="${APP_ID}-swatch closed"></i>geschlossen</span></div>
          <div class="${APP_ID}-visit">
            <div class="${APP_ID}-visit-title">Aktuelle Aufnahme</div>
            <div class="${APP_ID}-throw-row">${throws}</div>
            <div class="${APP_ID}-test">${corrections}</div>
          </div>
        </section>
        <section class="${APP_ID}-game-main">
          <div class="${APP_ID}-player-strip">${playerCards}</div>
          <div class="${APP_ID}-needed-card">
            <div class="${APP_ID}-needed-head"><h2>Noch benötigt – ${escapeHtml(current?.name || '')}</h2><span>3 Marks schließen ein Ziel</span></div>
            <div class="${APP_ID}-targets">${targetCards}</div>
          </div>
          <div class="${APP_ID}-score-card">
            <h3>Spielstand</h3>
            <table class="${APP_ID}-scoreboard">
              <thead><tr><th>Ziel</th>${headers}</tr></thead>
              <tbody>${targetRows}<tr><td class="${APP_ID}-row-target">Punkte</td>${scoreCells}</tr></tbody>
            </table>
          </div>
        </section>
      </div>
      <div class="${APP_ID}-actions" style="margin-top:14px">
        <button class="${APP_ID}-btn" data-action="previous" ${canPrevious && localMayAct ? '' : 'disabled'}>← Vorheriger Spieler</button>
        <button class="${APP_ID}-btn" data-action="reset-visit" ${canReset ? '' : 'disabled'}>Würfe zurücksetzen</button>
        <button class="${APP_ID}-btn" data-action="undo" ${canUndo ? '' : 'disabled'}>${currentMode === 'test' ? '↶ Undo' : 'Letzten Dart streichen'}</button>
        <button class="${APP_ID}-btn" data-action="next" ${!localMayAct || state.winner !== null || (currentMode === 'board' && state.boardGate === 'await-empty') ? 'disabled' : ''}>${state.boardGate === 'sync' ? 'Aufnahme abschließen' : 'Nächster Spieler'}</button>
        <button class="${APP_ID}-btn danger" data-action="new-game" ${network.role === 'guest' ? 'disabled' : ''}>Neues Spiel</button>
      </div>
      ${currentMode === 'board' ? `<div class="${APP_ID}-hint">Korrekturen gelten nur für dieses Spiel. Ein gestrichener Dart bleibt als geworfener Dart belegt. Fehlende Darts über Dart 1/2/3 ergänzen, auch MISS. Bei nachträglicher Kameraerkennung wird der betreffende Platz neu abgeglichen.</div>` : ''}
      ${isLocalTurn() && state.inputMode === 'test' ? `<details open data-details="tests" style="margin-top:14px;color:#697386">
        <summary style="cursor:pointer">Testwürfe (ohne Board)</summary>
        <div class="${APP_ID}-test">
          ${orderedTargets().flatMap((target) => (target === 25 ? [1,2] : [1,2,3]).map((m) => `<button class="${APP_ID}-btn" data-test-target="${target}" data-test-m="${m}" ${state.turnDarts >= 3 || state.winner !== null || state.legacyVisit ? 'disabled' : ''}>${m === 1 ? 'S' : m === 2 ? 'D' : 'T'}${targetLabel(target)}</button>`)).join('')}
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
        <div class="${APP_ID}-wrap ${state.connected ? 'connected' : ''} ${network.connected ? 'online-connected' : ''}">
          <div class="${APP_ID}-top">
            <div class="${APP_ID}-title">🎯 Cricket Random Cutthroat <span class="${APP_ID}-badge">v${VERSION}</span></div>
            <div class="${APP_ID}-actions">
              <span class="${APP_ID}-badge"><span class="${APP_ID}-dot"></span> ${state.inputMode === 'test' ? 'Testmodus' : state.connected ? 'Board verbunden' : 'Board offline'}</span>
              ${network.role !== 'local' ? `<span class="${APP_ID}-badge"><span class="${APP_ID}-online-dot"></span> ${network.connected ? `Online ${escapeHtml(network.roomCode)}` : escapeHtml(network.role === 'host' ? 'Raum wartet' : 'Online getrennt')}</span>` : ''}
              ${network.role !== 'local' && state.screen === 'game' ? `<button class="${APP_ID}-btn" data-action="online-local">Online verlassen</button>` : ''}
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
        if (network.role === 'guest') sendGuestProfile();
        update();
      });
    });
    panel.querySelectorAll('[data-correct]').forEach((select) => {
      select.addEventListener('change', () => {
        select.blur();
        dispatchGameAction('correct', { index: Number(select.dataset.correct), value: select.value });
      });
      select.addEventListener('blur', () => render());
    });
    panel.querySelectorAll('[data-bull]').forEach((button) => {
      button.addEventListener('click', () => {
        if (network.role === 'guest') return;
        state.bullMode = button.dataset.bull;
        update();
      });
    });

    panel.querySelectorAll('[data-player-name]').forEach((input) => {
      input.addEventListener('input', () => {
        const index = Number(input.dataset.playerName);
        if (state.players[index]) state.players[index].name = input.value;
        saveState();
        if (network.role === 'guest' && index === 1) sendGuestProfile();
        if (network.role === 'host' && index === 0) broadcastState();
      });
    });

    const host = panel.querySelector(`#${APP_ID}-host`);
    if (host) {
      host.addEventListener('input', () => {
        state.boardHost = host.value;
        saveState();
      });
    }

    const room = panel.querySelector(`#${APP_ID}-room`);
    if (room) {
      room.addEventListener('input', () => {
        const normalized = normalizeRoomCode(room.value);
        if (room.value !== normalized) room.value = normalized;
        network.roomCode = normalized;
        saveNetwork();
      });
    }

    panel.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.action;
        if (action === 'online-local') useLocalMode();
        if (action === 'online-host') createOnlineRoom();
        if (action === 'online-guest-mode') prepareGuestMode();
        if (action === 'online-join') joinOnlineRoom(room?.value || network.roomCode);
        if (action === 'copy-room') copyRoomCode();
        if (action === 'add-player') addPlayer();
        if (action === 'remove-player') removePlayer();
        if (action === 'start') {
          if (host) state.boardHost = host.value.trim() || DEFAULT_BOARD_HOST;
          startGame();
        }
        if (action === 'previous') dispatchGameAction('previous');
        if (action === 'reset-visit') dispatchGameAction('reset-visit');
        if (action === 'undo') dispatchGameAction('undo');
        if (action === 'next') dispatchGameAction('next');
        if (action === 'resume') dispatchGameAction('resume');
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
        dispatchGameAction('test-throw', {
          segment: { number, multiplier, name: number ? `${multiplier === 1 ? 'S' : multiplier === 2 ? 'D' : 'T'}${targetLabel(number)}` : 'MISS' },
        });
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
    if (network.role === 'host' && network.roomCode) createOnlineRoom(network.roomCode);
    if (network.role === 'guest' && network.roomCode) joinOnlineRoom(network.roomCode);

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


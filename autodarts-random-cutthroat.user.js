// ==UserScript==
// @name         Autodarts Random Cutthroat Cricket
// @namespace    https://github.com/lukasschoengrundner/autodarts-random-cutthroat
// @version      0.1.0
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
  const DEFAULT_BOARD_HOST = 'autodarts.local';
  const VERSION = '0.1.0';
  const MARKS = ['–', '/', 'X', '⊗'];

  const defaultState = () => ({
    screen: 'setup',
    bullMode: 'random', // always | never | random
    targetCount: 7,
    targets: [],
    players: [
      { name: 'Spieler 1', marks: {}, score: 0 },
      { name: 'Spieler 2', marks: {}, score: 0 },
    ],
    currentPlayer: 0,
    turnDarts: 0,
    turnSerial: 0,
    history: [],
    winner: null,
    boardHost: DEFAULT_BOARD_HOST,
    connected: false,
    lastProcessedFingerprint: '',
    minimized: false,
  });

  let state = loadState();
  let socket = null;
  let reconnectTimer = null;
  let renderQueued = false;

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved) return defaultState();
      const base = defaultState();
      return {
        ...base,
        ...saved,
        connected: false,
        players: Array.isArray(saved.players) && saved.players.length >= 2 ? saved.players : base.players,
        history: Array.isArray(saved.history) ? saved.history.slice(-100) : [],
      };
    } catch (error) {
      console.warn('[Random Cutthroat] Could not load state', error);
      return defaultState();
    }
  }

  function saveState() {
    const safe = { ...state, connected: false };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
  }

  function shuffle(values) {
    const a = [...values];
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function generateTargets(mode = state.bullMode, count = 7) {
    const numbers = Array.from({ length: 20 }, (_, i) => i + 1);
    let targets;

    if (mode === 'always') {
      targets = [...shuffle(numbers).slice(0, count - 1), 25];
    } else if (mode === 'never') {
      targets = shuffle(numbers).slice(0, count);
    } else {
      targets = shuffle([...numbers, 25]).slice(0, count);
    }

    return targets.sort((a, b) => {
      if (a === 25) return 1;
      if (b === 25) return -1;
      return a - b;
    });
  }

  function targetLabel(target) {
    return target === 25 ? 'BULL' : String(target);
  }

  function targetValue(target) {
    return target === 25 ? 25 : target;
  }

  function getMarks(player, target) {
    return Math.max(0, Math.min(3, Number(player.marks?.[target] || 0)));
  }

  function snapshot(reason = '') {
    return {
      reason,
      players: JSON.parse(JSON.stringify(state.players)),
      currentPlayer: state.currentPlayer,
      turnDarts: state.turnDarts,
      winner: state.winner,
    };
  }

  function pushHistory(reason) {
    state.history.push(snapshot(reason));
    state.history = state.history.slice(-100);
  }

  function allClosed(player) {
    return state.targets.length > 0 && state.targets.every((target) => getMarks(player, target) >= 3);
  }

  function checkWinner(playerIndex) {
    const player = state.players[playerIndex];
    if (!player || !allClosed(player)) return false;

    const hasLowestOrTiedScore = state.players.every((other, index) => (
      index === playerIndex || player.score <= other.score
    ));

    if (hasLowestOrTiedScore) {
      state.winner = playerIndex;
      return true;
    }
    return false;
  }

  function normalizeMultiplier(segment) {
    const m = Number(segment?.multiplier);
    if (Number.isFinite(m) && m >= 0 && m <= 3) return m;

    const name = String(segment?.name || '').toUpperCase();
    if (name.startsWith('T')) return 3;
    if (name.startsWith('D') || name === 'DB' || name.includes('BULLSEYE')) return 2;
    if (name.startsWith('S') || name.includes('BULL')) return 1;
    return 0;
  }

  function normalizeNumber(segment) {
    const n = Number(segment?.number);
    if (n === 25 || (n >= 1 && n <= 20)) return n;
    const name = String(segment?.name || '').toUpperCase();
    if (name.includes('BULL')) return 25;
    const parsed = Number(name.replace(/[^0-9]/g, ''));
    return parsed >= 1 && parsed <= 20 ? parsed : 0;
  }

  function processThrow(segment, source = 'board') {
    if (state.screen !== 'game' || state.winner !== null) return;

    const number = normalizeNumber(segment);
    const multiplier = normalizeMultiplier(segment);
    const name = String(segment?.name || (number ? `${multiplier}x${number}` : 'MISS'));

    pushHistory(`${source}:${name}`);

    const player = state.players[state.currentPlayer];
    const isTarget = state.targets.includes(number);

    if (isTarget && multiplier > 0) {
      const before = getMarks(player, number);
      const total = before + multiplier;
      const newMarks = Math.min(3, total);
      const excessMarks = Math.max(0, total - 3);
      player.marks[number] = newMarks;

      if (excessMarks > 0) {
        const penalty = excessMarks * targetValue(number);
        state.players.forEach((opponent, index) => {
          if (index !== state.currentPlayer && getMarks(opponent, number) < 3) {
            opponent.score += penalty;
          }
        });
      }
    }

    state.turnDarts = Math.min(3, state.turnDarts + 1);
    checkWinner(state.currentPlayer);
    saveState();
    render();
  }

  function nextPlayer() {
    if (state.screen !== 'game' || state.winner !== null) return;
    state.currentPlayer = (state.currentPlayer + 1) % state.players.length;
    state.turnDarts = 0;
    state.turnSerial += 1;
    state.lastProcessedFingerprint = '';
    saveState();
    render();
  }

  function undo() {
    const previous = state.history.pop();
    if (!previous) return;
    state.players = previous.players;
    state.currentPlayer = previous.currentPlayer;
    state.turnDarts = previous.turnDarts;
    state.winner = previous.winner;
    saveState();
    render();
  }

  function startGame() {
    const inputs = [...document.querySelectorAll(`#${APP_ID}-player-list input[data-player-name]`)];
    const names = inputs.map((input, i) => input.value.trim() || `Spieler ${i + 1}`);
    if (names.length < 2) return;

    state.players = names.map((name) => ({ name, marks: {}, score: 0 }));
    state.targets = generateTargets(state.bullMode, state.targetCount);
    state.currentPlayer = 0;
    state.turnDarts = 0;
    state.turnSerial = 0;
    state.history = [];
    state.winner = null;
    state.screen = 'game';
    state.lastProcessedFingerprint = '';
    saveState();
    render();
    connectBoard(true);
  }

  function newGame() {
    state.screen = 'setup';
    state.winner = null;
    state.history = [];
    state.turnDarts = 0;
    saveState();
    render();
  }

  function addPlayer() {
    if (state.players.length >= 8) return;
    state.players.push({ name: `Spieler ${state.players.length + 1}`, marks: {}, score: 0 });
    saveState();
    render();
  }

  function removePlayer() {
    if (state.players.length <= 2) return;
    state.players.pop();
    saveState();
    render();
  }

  function boardWsUrl() {
    const raw = String(state.boardHost || DEFAULT_BOARD_HOST).trim();
    if (/^wss?:\/\//i.test(raw)) {
      return raw.includes('/api/events') ? raw : `${raw.replace(/\/$/, '')}/api/events?type=state`;
    }
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${url.host}/api/events?type=state`;
    }
    const host = raw.replace(/^\/+|\/+$/g, '');
    if (host.includes(':')) return `wss://${host}/api/events?type=state`;
    return `wss://${host}:3181/api/events?type=state`;
  }

  function connectBoard(force = false) {
    if (force && socket) {
      try { socket.close(); } catch (_) { /* ignore */ }
      socket = null;
    }
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

    clearTimeout(reconnectTimer);
    let url;
    try {
      url = boardWsUrl();
      socket = new WebSocket(url);
    } catch (error) {
      console.warn('[Random Cutthroat] Invalid Board Manager URL', error);
      state.connected = false;
      render();
      return;
    }

    socket.addEventListener('open', () => {
      state.connected = true;
      render();
    });

    socket.addEventListener('message', (event) => {
      handleBoardMessage(event.data);
    });

    socket.addEventListener('close', () => {
      state.connected = false;
      render();
      reconnectTimer = setTimeout(() => connectBoard(false), 3000);
    });

    socket.addEventListener('error', () => {
      state.connected = false;
      render();
    });
  }

  function handleBoardMessage(raw) {
    let packet;
    try {
      packet = JSON.parse(raw);
    } catch (_) {
      return;
    }

    if (packet?.type && packet.type !== 'state') return;
    const data = packet?.data || packet;
    const event = String(data?.event || '');

    if (event === 'Throw detected') {
      const throws = Array.isArray(data.throws) ? data.throws : [];
      const latest = throws[throws.length - 1];
      if (!latest?.segment) return;

      const fingerprint = `${state.turnSerial}|${data.numThrows ?? throws.length}|${throws.map((t) => t?.segment?.name || '?').join(',')}`;
      if (fingerprint === state.lastProcessedFingerprint) return;
      state.lastProcessedFingerprint = fingerprint;
      processThrow(latest.segment, 'board');
      return;
    }

    if (event === 'Takeout finished' && state.turnDarts > 0) {
      nextPlayer();
    }
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
      #${APP_ID}-panel button,#${APP_ID}-panel input{font:inherit}
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
          <input id="${APP_ID}-host" class="${APP_ID}-input" value="${escapeHtml(state.boardHost)}" placeholder="autodarts.local">
          <div class="${APP_ID}-hint">Standard: <b>autodarts.local</b> → WSS Port 3181. Bei selbstsigniertem Zertifikat zuerst https://HOST:3181 im Browser öffnen und Zertifikat bestätigen.</div>
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

    return `
      ${winner}
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
        <button class="${APP_ID}-btn" data-action="undo" ${state.history.length ? '' : 'disabled'}>↶ Undo</button>
        <button class="${APP_ID}-btn" data-action="next">Nächster Spieler</button>
        <button class="${APP_ID}-btn danger" data-action="new-game">Neues Spiel</button>
      </div>
      <details style="margin-top:14px;color:#9ca5b2">
        <summary style="cursor:pointer">Testwürfe (ohne Board)</summary>
        <div class="${APP_ID}-test">
          ${state.targets.flatMap((target) => [1,2,3].map((m) => `<button class="${APP_ID}-btn" data-test-target="${target}" data-test-m="${m}">${m === 1 ? 'S' : m === 2 ? 'D' : 'T'}${targetLabel(target)}</button>`)).join('')}
          <button class="${APP_ID}-btn" data-test-target="0" data-test-m="0">MISS</button>
        </div>
      </details>
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

      panel.classList.toggle(`${APP_ID}-hidden`, state.minimized);
      launcher.style.display = state.minimized ? 'block' : 'none';

      panel.innerHTML = `
        <div class="${APP_ID}-wrap ${state.connected ? 'connected' : ''}">
          <div class="${APP_ID}-top">
            <div class="${APP_ID}-title">🎯 Random Cutthroat <span class="${APP_ID}-badge">v${VERSION}</span></div>
            <div class="${APP_ID}-actions">
              <span class="${APP_ID}-badge"><span class="${APP_ID}-dot"></span> ${state.connected ? 'Board verbunden' : 'Board offline'}</span>
              <button class="${APP_ID}-btn" data-action="connect">Verbinden</button>
              <button class="${APP_ID}-btn" data-action="minimize">×</button>
            </div>
          </div>
          ${state.screen === 'game' ? gameHtml() : setupHtml()}
        </div>
      `;

      bindUi(panel);
    });
  }

  function bindUi(panel) {
    panel.querySelectorAll('[data-bull]').forEach((button) => {
      button.addEventListener('click', () => {
        state.bullMode = button.dataset.bull;
        saveState();
        render();
      });
    });

    panel.querySelectorAll('[data-player-name]').forEach((input) => {
      input.addEventListener('change', () => {
        const index = Number(input.dataset.playerName);
        if (state.players[index]) state.players[index].name = input.value.trim() || `Spieler ${index + 1}`;
        saveState();
      });
    });

    const host = panel.querySelector(`#${APP_ID}-host`);
    if (host) {
      host.addEventListener('change', () => {
        state.boardHost = host.value.trim() || DEFAULT_BOARD_HOST;
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

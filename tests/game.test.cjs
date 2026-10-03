const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = readFileSync(path.join(__dirname, '..', 'autodarts-random-cutthroat.user.js'), 'utf8');
// Access the unmodified production functions inside an isolated VM; no test hook is shipped in the userscript.
const instrumented = script.replace("  if (document.readyState === 'loading') {", `
  globalThis.api = {
    state: () => state, diagnostics: () => ({ connectionStatus, storageWarning, lastEvent }),
    network: () => network, remoteProfile: () => remoteProfile,
    generateTargets, normalizeSegment, beginVisit, processThrow, handleBoardMessage, nextPlayer,
    undo, correctThrow, previousPlayer, resetVisit, boardWsUrl, connectBoard, disconnectBoard, resumeBoard, saveState,
    setupHtml, gameHtml, startGame, newGame, normalizeRoomCode, sharedStateSnapshot, validSharedState,
    applySharedStateSnapshot, handleHostData, handleGuestData, dispatchGameAction, useLocalMode, prepareGuestMode,
    actorInputMode, actorBoard, orderedTargets,
    wire: (connection) => { peerConnection = connection; },
  };
  if (document.readyState === 'loading') {`);
assert.notEqual(instrumented, script);

function harness(saved, options = {}) {
  const sockets = [];
  const timers = new Map();
  const errors = [];
  let timerId = 0;
  const storage = new Map();
  if (saved) storage.set('autodarts-random-cutthroat:v1', JSON.stringify(saved));
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor(url) {
      if (options.socketThrows) throw new Error('Blocked by browser');
      this.url = url; this.readyState = 0; this.listeners = {}; sockets.push(this);
    }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    close() { this.readyState = 2; }
    emit(type, event = {}) {
      if (type === 'open') this.readyState = 1;
      if (type === 'close') this.readyState = 3;
      for (const fn of this.listeners[type] ?? []) fn(event);
    }
  }
  const context = vm.createContext({
    URL, console: { warn: (...values) => errors.push(values) }, WebSocket: Socket,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { if (options.storageThrows) throw new Error('Quota exceeded'); storage.set(key, value); },
    },
    document: { readyState: 'loading', addEventListener: () => {}, querySelectorAll: () => [{ value: 'Alice' }, { value: 'Bob' }] },
    requestAnimationFrame: () => {},
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(instrumented, context);
  const api = context.api;
  return { api, s: api.state(), sockets, errors,
    saved: () => JSON.parse(storage.get('autodarts-random-cutthroat:v1')),
    retry: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((fn) => fn()); },
    send: (throws = [], event = 'Throw detected', extras = {}) => api.handleBoardMessage(packet(throws, event, extras)),
  };
}
const segment = (number, multiplier = 1) => ({ number, multiplier, name: number ? `${['','S','D','T'][multiplier]}${number}` : 'MISS' });
const packet = (throws = [], event = 'Throw detected', extras = {}) => JSON.stringify({ type: 'state', data: {
  running: true, status: 'Throw', event, numThrows: throws.length, throws: throws.map((s) => ({ segment: s })), ...extras,
} });
function game(mode = 'board', options = {}) {
  const h = harness(null, options);
  h.s.screen = 'game'; h.s.inputMode = mode; h.s.targets = [1, 5, 16, 17, 18, 20, 25];
  h.api.beginVisit();
  if (mode === 'board') {
    h.api.connectBoard(); h.sockets[0].emit('open'); h.send([]);
  } else h.s.boardGate = 'ready';
  return h;
}
const scores = (h) => JSON.stringify(h.s.players);

test('target selection produces seven distinct valid targets for all bull modes', () => {
  const { api } = harness();
  for (let i = 0; i < 1000; i++) for (const mode of ['always', 'never', 'random']) {
    const targets = api.generateTargets(mode);
    assert.equal(targets.length, 7); assert.equal(new Set(targets).size, 7);
    assert(targets.every((n) => (n >= 1 && n <= 20) || n === 25));
    if (mode === 'always') assert(targets.includes(25));
    if (mode === 'never') assert(!targets.includes(25));
  }
});
test('all legal segments and name-only bull representations normalize', () => {
  const { api } = harness();
  for (let n = 1; n <= 20; n++) for (let m = 1; m <= 3; m++) assert.equal(api.normalizeSegment(segment(n, m)).multiplier, m);
  for (const name of ['SB', 'SBULL', 'BULL', 'S25']) assert.equal(api.normalizeSegment({ name }).multiplier, 1);
  for (const name of ['DB', 'DBULL', 'BULLSEYE', 'D25']) assert.equal(api.normalizeSegment({ name }).multiplier, 2);
  assert.equal(api.normalizeSegment({ name: 'MISS' }).number, 0);
});
test('invalid segments, fractional marks and triple bull are rejected', () => {
  const { api } = harness();
  for (const value of [null, {}, segment(25, 3), segment(21), segment(18, 1.5), segment(0, 1), segment(18, 0), segment(-1), { number: true, multiplier: 1 }, { name: 'whatever' }]) assert.equal(api.normalizeSegment(value), null);
});
test('cutthroat overflow penalizes each open opponent only', () => {
  const h = game('test');
  h.s.players.push({ name: 'Closed', marks: { 18: 3 }, score: 0 }, { name: 'Open', marks: {}, score: 0 });
  h.s.players[0].marks[18] = 2; h.api.beginVisit();
  h.api.processThrow(segment(18, 3));
  assert.equal(h.s.players[0].marks[18], 3);
  assert.equal(h.s.players[1].score, 36); assert.equal(h.s.players[2].score, 0); assert.equal(h.s.players[3].score, 36);
});
test('bull overflow uses 25 points per excess mark', () => {
  const h = game('test'); h.s.players[0].marks[25] = 2; h.api.beginVisit();
  h.api.processThrow(segment(25, 2)); assert.equal(h.s.players[1].score, 25);
});
test('normal three-dart visit and repeated takeout advance exactly once', () => {
  const h = game(); const darts = [segment(18), segment(18, 2), segment(20)];
  for (let i = 1; i <= 3; i++) h.send(darts.slice(0, i));
  const before = scores(h); h.send(darts); assert.equal(scores(h), before); assert.equal(h.s.turnDarts, 3);
  h.send([], 'Takeout finished'); h.send([], 'Takeout finished');
  assert.equal(h.s.currentPlayer, 1); assert.equal(h.s.turnSerial, 1); assert.equal(h.s.turnDarts, 0);
});
test('missed intermediate event recovers every dart in the snapshot', () => {
  const h = game(); const darts = [segment(18), segment(20), segment(5)];
  h.send(darts.slice(0, 1)); h.send(darts);
  assert.equal(h.s.turnDarts, 3); for (const n of [18, 20, 5]) assert.equal(h.s.players[0].marks[n], 1);
});
test('first full visit after a confirmed empty board counts all darts', () => {
  const h = game(); h.send([segment(18), segment(20), segment(5)]);
  assert.equal(h.s.turnDarts, 3);
});
test('a changed slot replaces its score, including opponent penalties', () => {
  const h = game(); h.s.players[0].marks[18] = 3; h.api.beginVisit();
  h.send([segment(18, 3), segment(20)]); assert.equal(h.s.players[1].score, 54);
  h.send([segment(5), segment(20)]);
  assert.equal(h.s.players[1].score, 0); assert.equal(h.s.players[0].marks[5], 1); assert.equal(h.s.turnDarts, 2);
});
test('unknown correction event with a coherent snapshot is reconciled', () => {
  const h = game(); h.send([segment(20)]); h.send([segment(18)], 'Throw corrected');
  assert.equal(h.s.players[0].marks[20], undefined); assert.equal(h.s.players[0].marks[18], 1); assert.equal(h.s.turnDarts, 1);
});
test('board correction that removes a dart replays the remaining visit', () => {
  const h = game(); h.send([segment(18), segment(20)]); h.send([segment(18)], 'Throw removed');
  assert.equal(h.s.turnDarts, 1); assert.equal(h.s.players[0].marks[20], undefined);
  h.send([], 'Throw corrected'); assert.equal(h.s.turnDarts, 0); assert.equal(h.s.players[0].marks[18], undefined);
});
test('unexpected count decrease requires synchronization instead of guessing a new player', () => {
  const h = game(); h.send([segment(18), segment(20)]); const before = scores(h);
  h.send([segment(5)]); assert.equal(h.s.boardGate, 'sync'); assert.equal(scores(h), before);
  h.api.resumeBoard(); assert.equal(h.s.boardGate, 'ready'); assert.equal(h.s.turnDarts, 1); assert.equal(h.s.players[0].marks[5], 1);
});
test('invalid or partial snapshots never change score or count', () => {
  const h = game(); h.send([segment(18)]); const before = scores(h);
  for (const raw of ['invalid', 'null', '{}', packet([segment(20)], 'Throw detected', { numThrows: 2 }), packet([segment(25, 3)]), packet([segment(1), segment(2), segment(3), segment(4)])]) h.api.handleBoardMessage(raw);
  assert.equal(scores(h), before); assert.equal(h.s.turnDarts, 1);
});
test('non-state packets are ignored and zero-throw state may omit throws', () => {
  const h = game(); h.api.handleBoardMessage(JSON.stringify({ type: 'camera', data: { numThrows: 1, throws: [{ segment: segment(20) }] } }));
  assert.equal(h.s.turnDarts, 0);
  h.s.boardGate = 'await-empty'; h.api.handleBoardMessage(JSON.stringify({ type: 'state', data: { numThrows: 0, event: 'Takeout finished' } }));
  assert.equal(h.s.boardGate, 'ready');
});
test('all misses and non-target hits still consume three physical darts', () => {
  const h = game(); h.send([segment(0, 0), segment(2), segment(0, 0)]);
  assert.equal(h.s.turnDarts, 3); assert.equal(Object.keys(h.s.players[0].marks).length, 0);
  h.send([], 'Takeout finished'); assert.equal(h.s.currentPlayer, 1);
});
test('a fourth test dart cannot modify score', () => {
  const h = game('test'); for (let i = 0; i < 3; i++) h.api.processThrow(segment(18));
  const before = scores(h); h.api.processThrow(segment(18, 3));
  assert.equal(scores(h), before); assert.equal(h.s.turnDarts, 3);
});
test('manual next ignores old snapshots and takeout does not switch twice', () => {
  const h = game(); h.send([segment(18)]); h.api.nextPlayer(); h.api.nextPlayer();
  h.send([segment(18)]); assert.equal(h.s.players[1].marks[18], undefined); assert.equal(h.s.currentPlayer, 1);
  h.send([], 'Takeout finished'); assert.equal(h.s.currentPlayer, 1); assert.equal(h.s.boardGate, 'ready');
  h.send([segment(18)]); assert.equal(h.s.players[1].marks[18], 1);
});
test('takeout-in-progress snapshots cannot remove or change scored darts', () => {
  const h = game(); h.send([segment(18), segment(20), segment(5)]); const before = scores(h);
  h.send([segment(18), segment(20)], 'Takeout started', { status: 'Takeout in progress' });
  h.send([segment(18)]); h.send([]);
  assert.equal(scores(h), before); assert.equal(h.s.turnDarts, 3);
  h.send([], 'Takeout finished'); assert.equal(h.s.currentPlayer, 1);
});
test('manual reset rolls back the current visit and requires an explicit empty-board confirmation', () => {
  const h = game(); h.s.players[0].marks[18] = 3; h.api.beginVisit();
  h.send([segment(18, 3)]); h.send([], 'Manual reset');
  assert.equal(h.s.players[1].score, 0); assert.equal(h.s.players[0].marks[18], 3); assert.equal(h.s.turnDarts, 0); assert.equal(h.s.boardGate, 'sync');
  h.api.resumeBoard(); h.send([], 'Manual reset'); assert.equal(h.s.boardGate, 'ready');
  h.send([segment(18, 3)]); assert.equal(h.s.players[1].score, 54); assert.equal(h.s.turnDarts, 1);
});
test('board undo removes marks but keeps its occupied slot across repeated snapshots', () => {
  const h = game(); h.send([segment(18)]); h.api.undo(); h.send([segment(18)]);
  assert.equal(h.s.players[0].marks[18], undefined); assert.equal(h.s.turnDarts, 1);
  h.send([segment(18), segment(20)]);
  assert.equal(h.s.players[0].marks[18], undefined); assert.equal(h.s.players[0].marks[20], 1); assert.equal(h.s.turnDarts, 2);
});
test('local correction survives snapshots; a changed board slot supersedes it', () => {
  const h = game(); h.send([segment(20)]); h.api.correctThrow(0, 'T18'); h.send([segment(20)]);
  assert.equal(h.s.players[0].marks[18], 3); assert.equal(h.s.players[0].marks[20], undefined);
  h.send([segment(5)]); assert.equal(h.s.players[0].marks[18], undefined); assert.equal(h.s.players[0].marks[5], 1);
});
test('local correction may be reverted to the original board value', () => {
  const h = game(); h.send([segment(20)]); h.api.correctThrow(0, 'MISS'); assert.equal(h.s.players[0].marks[20], undefined);
  h.api.correctThrow(0, 'board'); assert.equal(h.s.players[0].marks[20], 1);
});
test('test undo makes room for a replacement dart and clears old overrides', () => {
  const h = game('test'); h.api.processThrow(segment(18)); h.api.correctThrow(0, 'T20'); h.api.undo(); h.api.processThrow(segment(5));
  assert.equal(h.s.turnDarts, 1); assert.equal(h.s.players[0].marks[5], 1); assert.equal(h.s.players[0].marks[20], undefined);
});
test('winner requires every target closed and lowest or tied score', () => {
  for (const [score, wins] of [[0, true], [1, false]]) {
    const h = game('test'); h.s.players[0].score = score;
    for (const target of h.s.targets) h.s.players[0].marks[target] = 3;
    h.s.players[0].marks[25] = 1; h.api.beginVisit(); h.api.processThrow(segment(25, 2));
    assert.equal(h.s.winner, wins ? 0 : null);
  }
});
test('correcting a winning dart can revoke the provisional winner before takeout', () => {
  const h = game(); for (const target of h.s.targets) h.s.players[0].marks[target] = 3;
  h.s.players[0].marks[25] = 1; h.api.beginVisit(); h.send([segment(25, 2)]);
  assert.equal(h.s.winner, 0); h.send([segment(25)]); assert.equal(h.s.winner, null);
  h.send([segment(25, 2)]); h.send([], 'Takeout finished');
  assert.equal(h.s.boardGate, 'finished'); const before = scores(h); h.send([segment(5)]); assert.equal(scores(h), before);
});
test('new game with already present darts waits until empty', () => {
  const h = game(); h.send([segment(18)]); h.api.startGame(); h.sockets.at(-1).emit('open');
  h.send([segment(18)]); assert.equal(h.s.turnDarts, 0); assert.equal(h.s.boardGate, 'await-empty');
  h.send([], 'Takeout finished'); h.send([segment(18)]); assert.equal(h.s.turnDarts, 1);
});
test('test mode neither opens sockets nor accepts incoming camera darts', () => {
  const h = game('test'); h.api.connectBoard(); h.send([segment(18)]);
  assert.equal(h.sockets.length, 0); assert.equal(h.s.turnDarts, 0);
  h.api.processThrow(segment(18)); assert.equal(h.s.turnDarts, 1);
});
test('board mode rejects manual test darts', () => {
  const h = game(); h.api.processThrow(segment(18)); assert.equal(h.s.turnDarts, 0);
});
test('test UI exposes no triple bull and board UI exposes no test buttons', () => {
  const h = game('test'); const html = h.api.gameHtml();
  assert.doesNotMatch(html, /data-test-target="25" data-test-m="3"/); assert.match(html, /data-test-target="25" data-test-m="2"/);
  h.s.inputMode = 'board'; assert.doesNotMatch(h.api.gameHtml(), /data-test-target=/);
});
test('URL handling supports Windows, LAN, HTTPS, IPv6 and existing endpoint URLs', () => {
  const { api, s } = harness();
  for (const [input, expected] of [
    ['localhost', 'ws://localhost:3180/api/events?type=state'], ['localhost:3180', 'ws://localhost:3180/api/events?type=state'],
    ['http://localhost:3180', 'ws://localhost:3180/api/events?type=state'], ['localhost:3181', 'wss://localhost:3181/api/events?type=state'],
    ['192.168.1.50', 'ws://192.168.1.50:3180/api/events?type=state'], ['https://board.local:3181', 'wss://board.local:3181/api/events?type=state'],
    ['ws://localhost:3180/api/events?type=other', 'ws://localhost:3180/api/events?type=state'], ['[::1]:3180', 'ws://[::1]:3180/api/events?type=state'],
    ['http://localhost:80', 'ws://localhost/api/events?type=state'], ['https://board.local:443', 'wss://board.local/api/events?type=state'],
  ]) { s.boardHost = input; assert.equal(api.boardWsUrl(), expected); }
});
test('invalid URLs are reported and do not create sockets', () => {
  const h = harness();
  for (const input of ['ftp://localhost', 'https://user:secret@localhost', 'http://localhost/not-an-api', 'http://[bad']) {
    h.s.boardHost = input; h.api.connectBoard(true); assert.equal(h.sockets.length, 0); assert.match(h.api.diagnostics().connectionStatus, /nicht möglich/);
  }
});
test('late old connection close/error/message cannot affect the replacement', () => {
  const h = game(); const old = h.sockets[0]; h.api.connectBoard(true); const current = h.sockets[1]; current.emit('open');
  old.emit('close'); old.emit('error'); old.emit('message', { data: packet([segment(18)]) }); old.emit('open'); h.retry();
  assert.equal(h.s.connected, true); assert.equal(h.s.turnDarts, 0); assert.equal(h.sockets.length, 2);
});
test('disconnection freezes the visit and reconnect requires deliberate synchronization', () => {
  const h = game(); h.send([segment(18)]); h.sockets[0].emit('close');
  assert.equal(h.s.boardGate, 'sync'); h.retry(); h.sockets[1].emit('open'); h.send([segment(18), segment(20), segment(5)]);
  assert.equal(h.s.turnDarts, 1); h.api.resumeBoard(); assert.equal(h.s.turnDarts, 3); assert.equal(h.s.currentPlayer, 0);
});
test('an empty board after reconnect cannot erase a scored visit', () => {
  const h = game(); h.send([segment(18)]); h.sockets[0].emit('close'); h.retry(); h.sockets[1].emit('open');
  h.send([], 'Takeout finished'); h.api.resumeBoard(); assert.equal(h.s.turnDarts, 1); assert.equal(h.s.boardGate, 'sync');
  h.api.nextPlayer(); h.send([], 'Takeout finished'); assert.equal(h.s.currentPlayer, 1); assert.equal(h.s.players[0].marks[18], 1);
});
test('takeout observed during synchronization does not leave resume permanently disabled', () => {
  const h = game(); h.api.connectBoard(true); h.sockets[1].emit('open');
  h.send([segment(18)], 'Takeout started'); h.send([], 'Takeout finished'); h.api.resumeBoard();
  assert.equal(h.s.boardGate, 'ready'); assert.equal(h.s.currentPlayer, 0);
});
test('a reset snapshot after reconnect preserves previous scores until user decides', () => {
  const h = game(); h.send([segment(18)]); h.api.connectBoard(true); h.sockets[1].emit('open'); h.send([], 'Manual reset');
  assert.equal(h.s.players[0].marks[18], 1); assert.equal(h.s.boardGate, 'sync');
});
test('paused/stopped detection requires synchronization and cannot score', () => {
  const h = game(); h.send([segment(18)]); h.send([], 'Stopped', { running: false });
  assert.equal(h.s.boardGate, 'sync'); h.api.resumeBoard(); assert.equal(h.s.boardGate, 'sync'); assert.equal(h.s.turnDarts, 1);
});
test('disconnect cancels retries and old events remain inert in test mode', () => {
  const h = game(); h.sockets[0].emit('close'); h.s.inputMode = 'test'; h.api.disconnectBoard(); h.retry();
  assert.equal(h.sockets.length, 1); h.sockets[0].emit('message', { data: packet([segment(18)]) }); assert.equal(h.s.turnDarts, 0);
});
test('old default host migrates; customized hosts are preserved', () => {
  const initial = harness().s;
  for (const [host, expected] of [['autodarts.local', 'http://localhost:3180'], ['192.168.1.50', '192.168.1.50']]) {
    const h = harness({ ...initial, schemaVersion: undefined, boardHost: host }); assert.equal(h.s.boardHost, expected);
  }
});
test('legacy active games keep scores and require finishing the unknown visit', () => {
  const h = game(); h.send([segment(18)]); const old = h.saved(); delete old.schemaVersion; delete old.visit;
  const restored = harness(old); assert.equal(restored.s.players[0].marks[18], 1); assert.equal(restored.s.legacyVisit, true);
  restored.api.connectBoard(); restored.sockets[0].emit('open'); restored.send([segment(20)]); restored.api.resumeBoard();
  assert.equal(restored.s.players[0].marks[20], undefined); restored.api.nextPlayer(); assert.equal(restored.s.currentPlayer, 1); assert.equal(restored.s.legacyVisit, false);
});
test('reload keeps local overrides and syncs without double-scoring', () => {
  const h = game(); h.send([segment(18)]); h.api.correctThrow(0, 'T20');
  const restored = harness(h.saved()); assert.equal(restored.s.connected, false); assert.equal(restored.s.boardGate, 'sync');
  restored.api.connectBoard(); restored.sockets[0].emit('open'); restored.send([segment(18)]); restored.api.resumeBoard();
  assert.equal(restored.s.players[0].marks[20], 3); assert.equal(restored.s.players[0].marks[18], undefined); assert.equal(restored.s.turnDarts, 1);
});
test('reload of a test game needs no camera synchronization', () => {
  const h = game('test'); h.api.processThrow(segment(18)); const restored = harness(h.saved());
  assert.equal(restored.s.boardGate, 'ready'); restored.api.processThrow(segment(20)); assert.equal(restored.s.turnDarts, 2);
});
test('corrupt saved game falls back to setup without crashing', () => {
  const h = harness({ ...game().s, currentPlayer: 100, targets: [25] }); assert.equal(h.s.screen, 'setup');
  assert.doesNotThrow(() => h.api.setupHtml());
});
test('storage failures do not interrupt scoring and show a warning', () => {
  const h = game('test', { storageThrows: true }); h.api.processThrow(segment(18));
  assert.equal(h.s.players[0].marks[18], 1); assert.match(h.api.diagnostics().storageWarning, /nicht gespeichert/);
});
test('blocked websocket constructor reports failure without throwing into the page', () => {
  const h = harness(null, { socketThrows: true }); assert.doesNotThrow(() => h.api.connectBoard());
  assert.equal(h.s.connected, false); assert.match(h.api.diagnostics().connectionStatus, /Blocked by browser/);
});
test('player names and diagnostics cannot inject markup into the overlay', () => {
  const h = game('test'); h.s.players[0].name = '<img src=x onerror=alert(1)>'; h.s.boardHost = '" onfocus="x';
  assert.doesNotMatch(h.api.gameHtml(), /<img/); assert.match(h.api.setupHtml(), /&quot;/);
});

test('online room codes are normalized and ambiguous characters are rejected', () => {
  const { api } = harness();
  assert.equal(api.normalizeRoomCode(' ab-cd 29!'), 'ABCD29');
  assert.equal(api.normalizeRoomCode('äöü'), '');
  assert.equal(api.normalizeRoomCode('123456789'), '234567');
});

test('shared online state excludes local board settings and preserves them on the guest', () => {
  const host = game('test');
  host.api.network().role = 'host';
  host.s.players[0].marks[18] = 2;
  const snapshot = host.api.sharedStateSnapshot();
  assert.equal(snapshot.inputMode, undefined);
  assert.equal(snapshot.boardHost, undefined);
  assert.equal(snapshot.connected, undefined);

  const guest = harness();
  guest.api.network().role = 'guest';
  guest.s.inputMode = 'board'; guest.s.boardHost = 'http://192.168.1.50:3180'; guest.s.connected = true;
  assert.equal(guest.api.applySharedStateSnapshot(snapshot), true);
  assert.equal(guest.s.players[0].marks[18], 2);
  assert.equal(guest.s.inputMode, 'board');
  assert.equal(guest.s.boardHost, 'http://192.168.1.50:3180');
  assert.equal(guest.s.connected, true);
  assert.equal(guest.api.actorInputMode(0), 'test');
  assert.equal(guest.api.actorInputMode(1), 'board');
  assert.equal(guest.api.actorBoard(0), null);
});

test('malformed online state is rejected without changing the local game', () => {
  const h = game('test');
  const before = scores(h);
  const malformed = h.api.sharedStateSnapshot();
  malformed.players[0].marks[18] = 99;
  assert.equal(h.api.validSharedState(malformed), false);
  assert.equal(h.api.applySharedStateSnapshot(malformed), false);
  assert.equal(scores(h), before);
});

test('host accepts remote board snapshots only while the guest is the active player', () => {
  const h = game();
  h.api.network().role = 'host';
  h.api.handleHostData({
    type: 'hello', protocol: 1, clientId: 'guestclient123', name: 'Remote', inputMode: 'board', boardConnected: true,
  });
  const remotePacket = packet([segment(18)]);
  h.api.handleHostData({ type: 'board', protocol: 1, clientId: 'guestclient123', raw: remotePacket });
  assert.equal(h.s.players[1].marks[18], undefined);

  h.s.currentPlayer = 1; h.api.beginVisit(); h.s.boardGate = 'ready';
  h.api.handleHostData({ type: 'board', protocol: 1, clientId: 'guestclient123', raw: remotePacket });
  assert.equal(h.s.players[1].marks[18], 1);
  assert.equal(h.s.players[0].marks[18], undefined);
});

test('host validates guest identity and applies remote test throws authoritatively', () => {
  const h = game('test');
  h.api.network().role = 'host';
  h.api.handleHostData({
    type: 'hello', protocol: 1, clientId: 'guestclient123', name: 'Remote', inputMode: 'test', boardConnected: false,
  });
  h.api.handleHostData({
    type: 'profile', protocol: 1, clientId: 'guestclient123', name: 'Changed', inputMode: 'board', boardConnected: true,
  });
  assert.equal(h.api.remoteProfile().inputMode, 'test');
  h.s.currentPlayer = 1; h.api.beginVisit(); h.s.boardGate = 'ready';
  const action = { type: 'action', action: 'test-throw', protocol: 1, clientId: 'guestclient123', segment: segment(20, 3) };
  h.api.handleHostData({ ...action, clientId: 'wrongclient999' });
  assert.equal(h.s.players[1].marks[20], undefined);
  h.api.handleHostData(action);
  assert.equal(h.s.players[1].marks[20], 3);
  h.api.handleHostData({
    type: 'hello', protocol: 1, clientId: 'differentclient9', name: 'Intruder', inputMode: 'board', boardConnected: true,
  });
  assert.equal(h.api.remoteProfile().clientId, 'guestclient123');
});

test('host can resume the guest board from its authoritative controls', () => {
  const h = game();
  h.api.network().role = 'host';
  h.api.handleHostData({
    type: 'hello', protocol: 1, clientId: 'guestclient123', name: 'Remote', inputMode: 'board', boardConnected: true,
  });
  h.s.currentPlayer = 1; h.api.beginVisit(); h.s.boardGate = 'sync';
  h.api.handleHostData({ type: 'board', protocol: 1, clientId: 'guestclient123', raw: packet([segment(20)]) });
  h.api.dispatchGameAction('resume');
  assert.equal(h.s.boardGate, 'ready');
  assert.equal(h.s.players[1].marks[20], 1);
});

test('guest ignores duplicate and older authoritative state revisions', () => {
  const host = game('test');
  const guest = harness();
  guest.api.network().role = 'guest';
  const first = host.api.sharedStateSnapshot();
  first.players[0].score = 10;
  guest.api.handleGuestData({ type: 'state', protocol: 1, sessionId: 'session-a', revision: 2, state: first });
  assert.equal(guest.s.players[0].score, 10);
  const stale = host.api.sharedStateSnapshot();
  stale.players[0].score = 99;
  guest.api.handleGuestData({ type: 'state', protocol: 1, sessionId: 'session-a', revision: 1, state: stale });
  assert.equal(guest.s.players[0].score, 10);
});
test('an empty Started snapshot can arm a newly started game', () => {
  const h = game(); h.s.boardGate = 'await-empty'; h.send([], 'Started');
  assert.equal(h.s.boardGate, 'ready'); h.send([segment(18)]); assert.equal(h.s.turnDarts, 1);
});
test('calibration cannot be resumed even if the server reports running true', () => {
  const h = game(); h.send([], 'Calibration started', { status: 'Calibrating', running: true });
  assert.equal(h.s.boardGate, 'sync'); h.api.resumeBoard(); assert.equal(h.s.boardGate, 'sync');
});
test('identical throws in consecutive visits count for the correct players', () => {
  const h = game(); h.send([segment(18, 3), segment(18, 3), segment(18, 3)]);
  assert.equal(h.s.players[1].score, 108); h.send([], 'Takeout finished');
  h.send([segment(18, 3), segment(18, 3), segment(18, 3)]);
  assert.equal(h.s.players[1].marks[18], 3); assert.equal(h.s.players[0].score, 0);
  h.send([], 'Manual reset'); assert.equal(h.s.players[1].marks[18], undefined); assert.equal(h.s.players[1].score, 108); assert.equal(h.s.players[0].marks[18], 3);
});


test('previous player reopens the last completed visit for correction', () => {
  const h = game('test');
  h.api.processThrow(segment(18));
  h.api.nextPlayer();
  assert.equal(h.s.currentPlayer, 1);
  assert(h.s.previousVisit);
  h.api.previousPlayer();
  assert.equal(h.s.currentPlayer, 0);
  assert.equal(h.s.turnDarts, 1);
  assert.equal(h.s.players[0].marks[18], 1);
  h.api.correctThrow(0, 'D18');
  assert.equal(h.s.players[0].marks[18], 2);
  h.api.nextPlayer();
  assert.equal(h.s.currentPlayer, 1);
  assert.equal(h.s.players[0].marks[18], 2);
});

test('previous player is not allowed after the current player has thrown', () => {
  const h = game('test');
  h.api.processThrow(segment(18));
  h.api.nextPlayer();
  h.api.processThrow(segment(20));
  h.api.previousPlayer();
  assert.equal(h.s.currentPlayer, 1);
  assert.match(h.s.notice, /bereits Würfe/);
});

test('reset visit clears a test visit and allows throwing again', () => {
  const h = game('test');
  h.api.processThrow(segment(18, 2));
  assert.equal(h.s.players[0].marks[18], 2);
  h.api.resetVisit();
  assert.equal(h.s.turnDarts, 0);
  assert.equal(h.s.visit.throws.length, 0);
  assert.equal(h.s.players[0].marks[18], undefined);
  h.api.processThrow(segment(20));
  assert.equal(h.s.players[0].marks[20], 1);
});

test('reset visit in board mode removes scoring but keeps detected dart slots for correction', () => {
  const h = game();
  h.send([segment(18)]);
  assert.equal(h.s.players[0].marks[18], 1);
  h.api.resetVisit();
  assert.equal(h.s.turnDarts, 1);
  assert.equal(h.s.visit.throws.length, 1);
  assert.equal(h.s.players[0].marks[18], undefined);
  h.send([segment(18)]);
  assert.equal(h.s.players[0].marks[18], undefined);
  h.send([segment(18, 2)], 'Throw corrected');
  assert.equal(h.s.players[0].marks[18], 2);
});



test('start preserves the empty board connection and counts the first three darts', () => {
  const h = game(); const socket = h.sockets[0];
  h.api.startGame(); h.s.targets = [1, 5, 16, 17, 18, 20, 25];
  assert.equal(h.sockets.length, 1); assert.equal(socket.readyState, 1);
  for (let n = 1; n <= 3; n++) {
    socket.emit('message', { data: packet(Array.from({ length: n }, () => segment(18))) });
    assert.equal(h.s.turnDarts, n);
  }
  assert.equal(h.s.players[0].marks[18], 3);
});

test('an event-only board can deliver its first state with the first dart after start', () => {
  const h = harness(); h.api.startGame(); h.s.targets = [1, 5, 16, 17, 18, 20, 25];
  h.sockets[0].emit('open'); h.sockets[0].emit('message', { data: packet([segment(18)]) });
  assert.equal(h.s.turnDarts, 1); assert.equal(h.s.players[0].marks[18], 1);
});

test('all three correction fields are present before any camera detection', () => {
  const h = game(); assert.equal((h.api.gameHtml().match(/data-correct=/g) || []).length, 3);
  h.api.correctThrow(0, 'T18'); h.api.correctThrow(1, 'MISS'); h.api.correctThrow(2, 'S20');
  assert.equal(h.s.turnDarts, 3); assert.equal(h.s.players[0].marks[18], 3);
  assert.equal(h.s.players[0].marks[20], 1);
  h.api.correctThrow(3, 'T20'); assert.equal(h.s.turnDarts, 3);
  h.send([]); assert.equal(h.s.turnDarts, 3); assert.equal(h.s.boardGate, 'ready');
});

test('late detection merges manual slots without losing undetected darts or double scoring', () => {
  const h = game(); h.api.correctThrow(0, 'T18'); h.api.correctThrow(1, 'S20');
  h.send([segment(18, 3)]);
  assert.equal(h.s.turnDarts, 2); assert.equal(h.s.players[0].marks[20], 1);
  h.send([segment(18, 3), segment(20)]);
  const before = scores(h); h.send([segment(18, 3), segment(20)]);
  assert.equal(scores(h), before); assert.equal(h.s.players[0].marks[20], 1);
  assert.equal(h.s.players[1].score, 0);
  h.api.correctThrow(0, 'S18'); assert.equal(h.s.players[0].marks[18], 1);
});

test('manual dart slots survive saving, restoring, and camera synchronization', () => {
  const h = game(); h.api.correctThrow(2, 'D25');
  const restored = harness(h.saved()); restored.api.connectBoard(); restored.sockets[0].emit('open');
  restored.send([segment(18)]); restored.api.resumeBoard();
  assert.equal(restored.s.boardGate, 'ready'); assert.equal(restored.s.turnDarts, 3);
  assert.equal(restored.s.players[0].marks[25], 2);
  restored.api.resetVisit(); assert.equal(restored.s.players[0].marks[25], undefined);
});

test('targets display descending with Bull last including previously saved games', () => {
  const h = game();
  assert.deepEqual([...h.api.orderedTargets()], [20, 18, 17, 16, 5, 1, 25]);
  const html = h.api.gameHtml();
  assert.deepEqual([...html.matchAll(/ad-rcc-row-target[^"]*">([^<]+)</g)].map(m => m[1]).slice(0, 7), ['20', '18', '17', '16', '5', '1', 'BULL']);
  for (const mode of ['always', 'never', 'random']) {
    const targets = h.api.generateTargets(mode);
    assert.deepEqual([...targets], [...h.api.orderedTargets(targets)]);
  }
});

function onlinePair() {
  const host = game(); host.api.network().role = 'host';
  host.api.handleHostData({ type: 'hello', protocol: 1, clientId: 'guestclient123', inputMode: 'board', boardConnected: true });
  host.s.currentPlayer = 1; host.api.beginVisit(); host.s.boardGate = 'ready';
  const guest = game(); guest.api.network().role = 'guest'; guest.api.network().clientId = 'guestclient123';
  const queue = [];
  host.api.wire({ open: true, send: m => queue.push(() => guest.api.handleGuestData(m)) });
  guest.api.wire({ open: true, send: m => queue.push(() => host.api.handleHostData(m)) });
  return { host, guest, drain() {
    let count = 0;
    while (queue.length && count++ < 100) queue.shift()();
    assert.equal(queue.length, 0, 'messages must settle instead of echoing forever');
  } };
}

test('online cached empty and takeout states do not create an echo loop', () => {
  for (const event of ['Takeout finished', 'Takeout started']) {
    const { host, guest, drain } = onlinePair();
    guest.sockets[0].emit('message', { data: packet([], event) });
    host.api.handleHostData({ type: 'request-state', protocol: 1, clientId: 'guestclient123' });
    drain();
    host.api.handleHostData({ type: 'request-state', protocol: 1, clientId: 'guestclient123' });
    drain();
  }
});

test('online player changes require the next players own board to be empty', () => {
  const { host: h } = onlinePair();
  const remote = raw => h.api.handleHostData({ type: 'board', protocol: 1, clientId: 'guestclient123', raw });
  remote(packet([segment(18)])); h.api.nextPlayer();
  h.send([]); h.send([segment(5)]); h.send([], 'Takeout finished');
  assert.equal(h.s.boardGate, 'await-empty');
  remote(packet([segment(18)])); assert.equal(h.s.turnDarts, 0);
  assert.equal(h.s.players[1].marks[18], 1);
  remote(packet([], 'Takeout finished')); remote(packet([segment(18)]));
  assert.equal(h.s.players[1].marks[18], 2);
});

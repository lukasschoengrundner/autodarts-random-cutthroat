from pathlib import Path
import json

js = Path('autodarts-random-cutthroat.user.js')
text = js.read_text()
if "const VERSION = '0.3.1';" in text:
    print('v0.3.1 already applied')
    raise SystemExit(0)

text = text.replace('// @version      0.3.0', '// @version      0.3.1', 1)
text = text.replace("const VERSION = '0.3.0';", "const VERSION = '0.3.1';", 1)
text = text.replace(
"    boardGate: 'await-empty', visit: null, legacyVisit: false, minimized: false, notice: '',\n",
"    boardGate: 'await-empty', visit: null, previousVisit: null, legacyVisit: false, minimized: false, notice: '',\n",
1)
text = text.replace(
"      delete loaded.history;\n      delete loaded.lastProcessedFingerprint;\n      return loaded;",
"      loaded.previousVisit = validTurnSnapshot(saved.previousVisit, loaded.players.length) ? saved.previousVisit : null;\n      if (loaded.screen !== 'game') loaded.previousVisit = null;\n      delete loaded.history;\n      delete loaded.lastProcessedFingerprint;\n      return loaded;",
1)
text = text.replace(
"  function saveState() {",
"  function validTurnSnapshot(snapshot, playerCount) {\n    return snapshot && validPlayers(snapshot.players) && snapshot.players.length === playerCount\n      && Number.isInteger(snapshot.currentPlayer) && snapshot.currentPlayer >= 0 && snapshot.currentPlayer < playerCount\n      && Number.isInteger(snapshot.turnSerial) && snapshot.turnSerial >= 0\n      && (snapshot.winner === null || (Number.isInteger(snapshot.winner) && snapshot.winner >= 0 && snapshot.winner < playerCount))\n      && validVisit(snapshot.visit, playerCount, snapshot.currentPlayer);\n  }\n\n  function saveState() {",
1)

old_next = '''  function nextPlayer() {\n    if (state.screen !== 'game' || state.winner !== null) return;\n    // A manual change waits for the physical takeout; repeated clicks cannot skip players.\n    if (state.inputMode === 'board' && state.boardGate === 'await-empty') return;\n    state.currentPlayer = (state.currentPlayer + 1) % state.players.length;\n    state.turnSerial += 1;\n    beginVisit();\n    state.boardGate = state.inputMode === 'board' ? 'await-empty' : 'ready';\n    state.notice = '';\n    update();\n  }\n'''
new_next = '''  function snapshotCurrentTurn() {\n    return {\n      players: clone(state.players), currentPlayer: state.currentPlayer, visit: clone(state.visit),\n      turnDarts: state.turnDarts, turnSerial: state.turnSerial, winner: state.winner,\n    };\n  }\n  function nextPlayer() {\n    if (state.screen !== 'game' || state.winner !== null) return;\n    // A manual change waits for the physical takeout; repeated clicks cannot skip players.\n    if (state.inputMode === 'board' && state.boardGate === 'await-empty') return;\n    if (state.visit && !state.legacyVisit) state.previousVisit = snapshotCurrentTurn();\n    state.currentPlayer = (state.currentPlayer + 1) % state.players.length;\n    state.turnSerial += 1;\n    beginVisit();\n    state.boardGate = state.inputMode === 'board' ? 'await-empty' : 'ready';\n    state.notice = '';\n    update();\n  }\n  function previousPlayer() {\n    if (state.screen !== 'game' || !validTurnSnapshot(state.previousVisit, state.players.length) || takingOut) return;\n    if (state.visit?.throws?.length) {\n      state.notice = 'Der aktuelle Spieler hat bereits Würfe. Diese Aufnahme zuerst zurücksetzen oder korrigieren.';\n      update();\n      return;\n    }\n    const snapshot = clone(state.previousVisit);\n    state.players = snapshot.players;\n    state.currentPlayer = snapshot.currentPlayer;\n    state.visit = snapshot.visit;\n    state.turnDarts = snapshot.turnDarts;\n    state.turnSerial = snapshot.turnSerial;\n    state.winner = snapshot.winner;\n    state.previousVisit = null;\n    state.legacyVisit = false;\n    takingOut = false;\n    state.boardGate = state.inputMode === 'board' ? 'review' : 'ready';\n    state.notice = 'Vorherige Aufnahme geöffnet. Würfe korrigieren oder zurücksetzen und danach mit „Nächster Spieler“ fortfahren.';\n    update();\n  }\n  function resetVisit() {\n    if (state.screen !== 'game' || !state.visit || state.legacyVisit || takingOut || !['ready', 'review'].includes(state.boardGate)) return;\n    if (state.inputMode === 'test') {\n      state.visit.throws = [];\n      state.visit.overrides = {};\n      replayVisit();\n      state.notice = 'Aktuelle Würfe zurückgesetzt.';\n    } else {\n      state.visit.throws.forEach((_, i) => { state.visit.overrides[i] = null; });\n      replayVisit();\n      state.notice = 'Wertung dieser Aufnahme zurückgesetzt. Erkannte Wurfplätze bleiben belegt und können unten einzeln korrigiert werden.';\n    }\n    update();\n  }\n'''
if old_next not in text:
    raise SystemExit('nextPlayer block not found')
text = text.replace(old_next, new_next, 1)

text = text.replace(
"    if (state.screen !== 'game' || !state.visit || state.legacyVisit || state.boardGate === 'finished') return;",
"    if (state.screen !== 'game' || !state.visit || state.legacyVisit || state.boardGate === 'finished') return;",
1)
text = text.replace(
"      if (state.boardGate !== 'ready' || takingOut) return;",
"      if (!['ready', 'review'].includes(state.boardGate) || takingOut) return;",
1)
text = text.replace(
"    if (!state.visit || state.legacyVisit || state.boardGate !== 'ready' || takingOut || !Number.isInteger(index) || index < 0 || index >= state.visit.throws.length) return;",
"    if (!state.visit || state.legacyVisit || !['ready', 'review'].includes(state.boardGate) || takingOut || !Number.isInteger(index) || index < 0 || index >= state.visit.throws.length) return;",
1)

text = text.replace(
"    state.winner = null;\n    state.screen = 'game';",
"    state.winner = null;\n    state.previousVisit = null;\n    state.screen = 'game';",
1)
text = text.replace(
"    state.visit = null;\n    state.turnDarts = 0;",
"    state.visit = null;\n    state.previousVisit = null;\n    state.turnDarts = 0;",
1)

text = text.replace(
"    if (state.screen === 'game' && state.inputMode === 'board' && !['await-empty', 'finished'].includes(state.boardGate)) {",
"    if (state.screen === 'game' && state.inputMode === 'board' && !['await-empty', 'finished', 'review'].includes(state.boardGate)) {",
1)
text = text.replace(
"    if (state.screen !== 'game' || state.boardGate === 'finished') { render(); return; }\n    if (!boardOperational(board)) {",
"    if (state.screen !== 'game' || state.boardGate === 'finished') { render(); return; }\n    if (state.boardGate === 'review') { render(); return; }\n    if (!boardOperational(board)) {",
1)

text = text.replace(
"    const statusClass = state.boardGate === 'sync' ? 'sync' : (takingOut || state.turnDarts >= 3 ? 'takeout' : '');",
"    const statusClass = state.boardGate === 'sync' ? 'sync' : state.boardGate === 'review' ? 'review' : (takingOut || state.turnDarts >= 3 ? 'takeout' : '');",
1)
text = text.replace(
"      : state.boardGate === 'sync' ? 'Aufnahme synchronisieren'\n      : state.inputMode === 'board' && state.boardGate === 'await-empty' ? 'Board leeren'",
"      : state.boardGate === 'sync' ? 'Aufnahme synchronisieren'\n      : state.boardGate === 'review' ? 'Vorherigen Spieler korrigieren'\n      : state.inputMode === 'board' && state.boardGate === 'await-empty' ? 'Board leeren'",
1)
text = text.replace(
"    const visitEditable = state.boardGate === 'ready' && !takingOut && !state.legacyVisit;\n    const canUndo = visitEditable && state.visit?.throws.some((_, i) => effectiveThrow(i) !== null);",
"    const visitEditable = ['ready', 'review'].includes(state.boardGate) && !takingOut && !state.legacyVisit;\n    const canUndo = visitEditable && state.visit?.throws.some((_, i) => effectiveThrow(i) !== null);\n    const canReset = visitEditable && Boolean(state.visit?.throws?.length);\n    const canPrevious = Boolean(state.previousVisit) && !takingOut && !state.legacyVisit && !state.visit?.throws?.length;",
1)
text = text.replace(
"        <button class=\"${APP_ID}-btn\" data-action=\"undo\" ${canUndo ? '' : 'disabled'}>${state.inputMode === 'test' ? '↶ Undo' : 'Letzten Dart streichen'}</button>",
"        <button class=\"${APP_ID}-btn\" data-action=\"previous\" ${canPrevious ? '' : 'disabled'}>← Vorheriger Spieler</button>\n        <button class=\"${APP_ID}-btn\" data-action=\"reset-visit\" ${canReset ? '' : 'disabled'}>Würfe zurücksetzen</button>\n        <button class=\"${APP_ID}-btn\" data-action=\"undo\" ${canUndo ? '' : 'disabled'}>${state.inputMode === 'test' ? '↶ Undo' : 'Letzten Dart streichen'}</button>",
1)
text = text.replace(
"        if (action === 'undo') undo();\n        if (action === 'next') nextPlayer();",
"        if (action === 'previous') previousPlayer();\n        if (action === 'reset-visit') resetVisit();\n        if (action === 'undo') undo();\n        if (action === 'next') nextPlayer();",
1)
text = text.replace(
".${APP_ID}-status.takeout{background:#fff3d8;border-color:#f6ca6a}.${APP_ID}-status.sync{background:#fff0f0;border-color:#efb6b6}",
".${APP_ID}-status.takeout{background:#fff3d8;border-color:#f6ca6a}.${APP_ID}-status.sync{background:#fff0f0;border-color:#efb6b6}.${APP_ID}-status.review{background:#eef6ff;border-color:#9fc8f4}",
1)

js.write_text(text)

pkg = Path('package.json')
data = json.loads(pkg.read_text())
data['version'] = '0.3.1'
pkg.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')

ch = Path('CHANGELOG.md')
c = ch.read_text()
entry = """## 0.3.1 – 2026-09-10\n\n- „Vorheriger Spieler“: Die zuletzt abgeschlossene Aufnahme kann wieder geöffnet und korrigiert werden.\n- „Würfe zurücksetzen“: Im Testmodus wird die Aufnahme geleert; im Kameramodus wird ihre Wertung zurückgenommen, ohne die physischen Wurfplätze zu verlieren.\n- Korrekturen und Undo funktionieren auch im neuen Review-Modus; Board-Ereignisse werden während der Korrektur nicht ungefragt übernommen.\n\n"""
if '## 0.3.1' not in c:
    ch.write_text(c.replace('# Changelog\n\n', '# Changelog\n\n' + entry, 1))

readme = Path('README.md')
r = readme.read_text()
r = r.replace('**Version 0.3.0:**', '**Version 0.3.1:**', 1)
if 'Vorheriger Spieler' not in r:
    marker = '## Wertung, Korrekturen und Spielerwechsel\n\n'
    extra = '- **Vorheriger Spieler** öffnet die zuletzt abgeschlossene Aufnahme erneut, solange der neue Spieler noch keinen Dart geworfen hat. Danach können Würfe korrigiert oder zurückgesetzt werden.\n- **Würfe zurücksetzen** leert die Aufnahme im Testmodus; im Kameramodus nimmt es die Wertung der erkannten Darts zurück, hält deren Wurfplätze aber für Korrekturen belegt.\n'
    r = r.replace(marker, marker + extra, 1)
readme.write_text(r)

tests = Path('tests/game.test.cjs')
t = tests.read_text()
t = t.replace(
'    undo, correctThrow, boardWsUrl, connectBoard, disconnectBoard, resumeBoard, saveState,',
'    undo, correctThrow, previousPlayer, resetVisit, boardWsUrl, connectBoard, disconnectBoard, resumeBoard, saveState,',
1)
if "previous player reopens the last completed visit" not in t:
    t += r'''

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
'''
tests.write_text(t)

// ==UserScript==
// @name         Autodarts – Random Cutthroat 1.0 (Praxistest)
// @namespace    https://github.com/lukasschoengrundner/autodarts-random-cutthroat
// @version      1.0.0-beta.1
// @description  Cricket Random Cutthroat für ein gemeinsames Board oder einen privaten Zweierraum.
// @match        https://play.autodarts.com/*
// @match        https://play.autodarts.io/*
// @updateURL    https://raw.githubusercontent.com/lukasschoengrundner/autodarts-random-cutthroat/main/v1/random-cutthroat.user.js
// @downloadURL  https://raw.githubusercontent.com/lukasschoengrundner/autodarts-random-cutthroat/main/v1/random-cutthroat.user.js
// @require      https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(() => {
  'use strict';
  const VERSION = '1.0.0-beta.1';
  const values = ['MISS', ...Array.from({length: 20}, (_, i) => ['S','D','T'].map(m => m + (i + 1))).flat(), 'S25', 'D25'];
  const compact = value => String(value ?? '').replace(/[\s_-]/g, '').toLowerCase();
  const own = (obj, key) => Object.hasOwn(obj, key);

  function hit(dart) {
    if (!dart || typeof dart !== 'object') throw Error('Trefferdaten fehlen');
    const field = dart.segment ?? dart;
    const name = String(field.segmentName ?? field.name ?? '').toUpperCase();
    if (dart.bouncer === true || name === 'MISS' || /^M(?:[0-9]|1[0-9]|20)$/.test(name)
        || (field.bed === 'Outside' && field.multiplier === 0)) return 'MISS';
    if (dart.failed === true) throw Error('Board konnte das Segment nicht bestimmen');
    const n = field.segmentNumber ?? field.number;
    const m = field.multiplier;
    let label = name;
    if (n != null && m != null) {
      if (Number(n) === 0 && Number(m) === 0) return 'MISS';
      label = ({1:'S', 2:'D', 3:'T'})[m] + String(n);
    } else if (['SB','SBULL','BULL'].includes(name)) label = 'S25';
    else if (['DB','DBULL','BULLSEYE'].includes(name)) label = 'D25';
    if (!values.includes(label)) throw Error('Unbekanntes Segment: ' + (name || label));
    return label;
  }

  function readBoard(raw) {
    const packet = JSON.parse(raw);
    if (!packet || typeof packet !== 'object' || (packet.type && packet.type !== 'state')) return null;
    const data = packet.data ?? packet;
    const darts = data.throws ?? (data.numThrows === 0 ? [] : null);
    if (!Array.isArray(darts) || darts.length > 3 || (data.numThrows != null && data.numThrows !== darts.length))
      throw Error('Wurfliste oder Anzahl ungültig');
    const event = compact(data.event), status = compact(data.status);
    const paused = data.running === false || data.connected === false ||
      [event, status].some(word => /^(starting|stopp|calibrat)/.test(word));
    let kind = 'snapshot';
    if (paused) kind = 'paused';
    else if (event === 'manualreset') kind = 'reset';
    else if (event === 'takeoutfinished' && !darts.length) kind = 'empty';
    else if (event === 'takeoutstarted' || status === 'takeoutinprogress') kind = 'pulling';
    else if (/correct|undo|remov/.test(event)) kind = 'correction';
    return {kind, darts: darts.map(hit), label: String(data.event || data.status || 'state')};
  }

  function targets(bull) {
    const pool = Array.from({length:20}, (_, i) => i+1);
    if (bull === 'random') pool.push(25);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i+1));
      [pool[i],pool[j]] = [pool[j],pool[i]];
    }
    const selected = pool.slice(0, bull === 'always' ? 6 : 7);
    return selected.filter(x => x !== 25).sort((a,b) => b-a).concat(bull === 'always' || selected.includes(25) ? [25] : []);
  }

  const freshTurn = () => ({raw: [], edits: {}});
  function slots(turn) {
    const length = Math.max(turn.raw.length, ...Object.keys(turn.edits).map(i => Number(i)+1));
    return Array.from({length}, (_, i) => own(turn.edits,i) ? turn.edits[i] : turn.raw[i] ?? null);
  }
  function createGame(names, numbers, modes) {
    return {names: [...names], numbers: [...numbers], modes: [...modes], turns: [], turn: freshTurn(),
      epoch: 1, gate: 'ready', final: false, review: false};
  }
  function validGame(g) {
    const validTurn = t => t && Array.isArray(t.raw) && t.raw.length <= 3
      && t.raw.every(v => v === null || values.includes(v))
      && t.edits && typeof t.edits === 'object' && !Array.isArray(t.edits)
      && Object.entries(t.edits).every(([i,v]) => /^[0-2]$/.test(i) && (v === null || values.includes(v)));
    return g && Array.isArray(g.names) && g.names.length >= 2 && g.names.length <= 8
      && g.names.every(n => typeof n === 'string') && Array.isArray(g.modes) && g.modes.length === g.names.length
      && g.modes.every(m => ['board','manual'].includes(m)) && Array.isArray(g.numbers)
      && new Set(g.numbers).size === 7 && g.numbers.length === 7
      && g.numbers.every(n => Number.isInteger(n) && ((n >= 1 && n <= 20) || n === 25))
      && Array.isArray(g.turns) && g.turns.every(validTurn) && validTurn(g.turn)
      && Number.isSafeInteger(g.epoch) && g.epoch >= 1 && ['ready','sync','clear','pulling'].includes(g.gate)
      && typeof g.final === 'boolean' && typeof g.review === 'boolean';
  }
  const player = g => g.turns.length % g.names.length;
  function scoreboard(g) {
    const players = g.names.map(() => ({score:0, marks:{}}));
    let winner = null;
    function apply(i, darts) {
      const active = players[i];
      for (const value of darts) {
        if (!value || value === 'MISS' || winner !== null) continue;
        const n = Number(value.slice(1));
        if (!g.numbers.includes(n)) continue;
        const total = (active.marks[n] || 0) + ({S:1,D:2,T:3})[value[0]];
        active.marks[n] = Math.min(total,3);
        for (const other of players) {
          if (other !== active && other.marks[n] !== 3) other.score += Math.max(0,total-3)*n;
        }
        if (g.numbers.every(v => active.marks[v] === 3) && players.every(p => p.score >= active.score)) winner = i;
      }
    }
    g.turns.forEach((turn,i) => apply(i % players.length, slots(turn)));
    apply(player(g), slots(g.turn));
    return {players,winner};
  }
  function finishTurn(g, gate) {
    if (scoreboard(g).winner !== null) { g.final = true; return; }
    g.turns.push(g.turn);
    g.turn = freshTurn();
    g.epoch++;
    g.review = false;
    g.gate = gate;
  }
  function replaceRaw(g, darts) {
    for (let i=0;i<3;i++) {
      if (g.turn.raw[i] !== darts[i]) delete g.turn.edits[i];
    }
    g.turn.raw = [...darts];
  }
  function acceptBoard(g, frame) {
    if (g.final || g.review || g.modes[player(g)] !== 'board') return;
    if (frame.kind === 'paused') { g.gate = 'sync'; return; }
    if (g.gate === 'sync') return;
    if (frame.kind === 'reset') { g.turn = freshTurn(); g.gate = 'sync'; return; }
    if (g.gate === 'clear') {
      if (frame.kind !== 'pulling' && !frame.darts.length) g.gate = 'ready';
      return;
    }
    if (frame.kind === 'empty') {
      if (slots(g.turn).length) finishTurn(g,'ready');
      else g.gate = 'ready';
      return;
    }
    if (g.gate === 'pulling') return;
    if (frame.kind === 'pulling') {
      // The first takeout snapshot can contain the darts missed between two camera messages.
      if (frame.darts.length > g.turn.raw.length) replaceRaw(g,frame.darts);
      g.gate = 'pulling'; return;
    }
    if (frame.darts.length < g.turn.raw.length && frame.kind !== 'correction') { g.gate = 'sync'; return; }
    replaceRaw(g,frame.darts);
  }
  function command(g, op, arg, board) {
    if (!g || g.final) return;
    const manual = g.modes[player(g)] === 'manual';
    const editable = g.gate === 'ready' || g.review;
    switch (op) {
      case 'throw':
        if (manual && editable && values.includes(arg) && slots(g.turn).length < 3 && scoreboard(g).winner === null) {
          const i = slots(g.turn).length;
          while (g.turn.raw.length < i) g.turn.raw.push(null);
          g.turn.raw.push(arg);
        }
        break;
      case 'edit': {
        if (!editable || !arg || !Number.isInteger(arg.i) || arg.i < 0 || arg.i > 2) break;
        if (arg.value === 'original') delete g.turn.edits[arg.i];
        else if (arg.value === 'ignore' || values.includes(arg.value)) g.turn.edits[arg.i] = arg.value === 'ignore' ? null : arg.value;
        break;
      }
      case 'undo': {
        if (!editable) break;
        const list = slots(g.turn);
        if (!list.length) break;
        if (manual) {
          delete g.turn.edits[list.length-1]; g.turn.raw.splice(list.length-1);
        } else {
          const i = list.findLastIndex(v => v !== null);
          if (i >= 0) g.turn.edits[i] = null;
        }
        break;
      }
      case 'reset':
        if (!editable) break;
        if (manual) g.turn = freshTurn();
        else slots(g.turn).forEach((_,i) => { g.turn.edits[i] = null; });
        break;
      case 'previous':
        if (!g.turns.length || slots(g.turn).length || g.gate === 'pulling') break;
        g.turn = g.turns.pop(); g.epoch++; g.review = true; g.gate = 'ready'; break;
      case 'next': {
        if (g.gate === 'clear' || g.gate === 'pulling') break;
        const cleared = board && ['snapshot','correction','empty'].includes(board.kind) && !board.darts.length;
        finishTurn(g,manual || cleared ? 'ready' : 'clear'); break;
      }
      case 'resume':
        if (g.gate === 'sync' && board && (['snapshot','correction','empty'].includes(board.kind) || (board.kind==='reset' && !board.darts.length))
            && (board.darts.length || !slots(g.turn).length)) {
          replaceRaw(g,board.darts); g.gate = 'ready';
        }
    }
  }
  if (typeof module === 'object' && module.exports && typeof document === 'undefined') {
    module.exports = {readBoard,targets,createGame,slots,scoreboard,acceptBoard,command,player}; return;
  }

  const STORAGE = 'random-cutthroat-v1-game';
  function saved(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  const stored = saved(STORAGE) || {};
  const legacy = saved('autodarts-random-cutthroat:v1') || {};
  const defaults = {names: legacy.players?.map(p => p.name) || ['Spieler 1','Spieler 2'],
    bull: legacy.bullMode || 'random', address: legacy.boardHost || 'http://localhost:3180',
    mode: legacy.inputMode === 'test' ? 'manual' : 'board'};
  const prefs = {...defaults,...stored.prefs};
  if (!Array.isArray(prefs.names) || prefs.names.length < 2 || prefs.names.length > 8) prefs.names = ['Spieler 1','Spieler 2'];
  let game = validGame(stored.game) ? stored.game : null, onlineGame = !!stored.online;
  if (game && !game.review && !game.final && game.modes[player(game)] === 'board') game.gate = 'sync';
  let role = 'local', peer, link, code = '', friend, remoteBoard, remoteConnected = false;
  let roundId = crypto.randomUUID(), revision = 0, received = -1;
  let socket, retry, localBoard, lastWire = null, connected = false, diagnosis = 'Noch keine Board-Meldung';
  let roomStatus = '', storageError = '', dragging = null;
  const root = document.createElement('div');
  document.documentElement.append(root);
  const ui = root.attachShadow({mode:'open'});
  const style = document.createElement('style');
  style.textContent = `
    :host{all:initial;font:16px/1.45 system-ui,sans-serif;color:#172b2b}
    *{box-sizing:border-box}section{position:fixed;inset:8px;z-index:2147483600;overflow:auto;background:#f4f6f2;border:1px solid #bfcac4;border-radius:16px;padding:clamp(12px,3vw,36px)}
    main{max-width:1080px;margin:auto}header,.line,nav,.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}header{justify-content:space-between}header h1{font-size:clamp(19px,3vw,30px);margin:0}h2{font-size:19px;margin:0 0 8px}
    article{background:white;border:1px solid #ced8d0;border-radius:14px;padding:16px;margin:12px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:12px}
    button,input,select{font:inherit;color:inherit;padding:8px 10px;border-radius:8px;border:1px solid #afc0b5;background:white;max-width:100%}
    button{cursor:pointer}button:disabled{opacity:.45;cursor:default}button:focus-visible,select:focus-visible,input:focus-visible{outline:3px solid #df9924}
    .primary,.active{background:#185743;color:white}.row{margin:5px 0;flex-wrap:nowrap}.row input{flex:1;min-width:0}.grip{width:48px;touch-action:none;cursor:grab;font-size:12px;padding:10px 2px}.drop{outline:2px solid #df9924}
    small,summary{color:#405b51}.table{overflow:auto}table{border-collapse:collapse;width:100%}td,th{text-align:center;padding:6px;border-bottom:1px solid #d9e5dd}th:first-child{text-align:left}.current{background:#e7f2eb}.closed{color:#086537;font-weight:bold}
    .darts{display:flex;gap:6px;margin:10px 0}.darts label{min-width:0;flex:1}.darts select{width:100%}.score{font-weight:bold}.badge{font-size:13px}
    #launcher{position:fixed;right:15px;bottom:16px;z-index:2147483600}.notice{color:#873e04}details{margin:10px 0}nav{margin-top:10px}
  `;
  const box = document.createElement('section');
  const main = document.createElement('main');
  const launcher = document.createElement('button');
  launcher.id = 'launcher'; launcher.textContent = '🎯 Random Cutthroat'; launcher.hidden = true;
  box.append(main); ui.append(style,box,launcher);
  const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  const btn = (op,label,disabled=false,cls='') => `<button data-op="${op}" class="${cls}" ${disabled?'disabled':''}>${esc(label)}</button>`;
  const option = (v,label,selected) => `<option value="${esc(v)}" ${v===selected?'selected':''}>${esc(label)}</option>`;
  function persist() {
    // Only the host owns the resumable online match.
    try { localStorage.setItem(STORAGE, JSON.stringify({prefs,game:role==='guest'?null:game,online:onlineGame})); storageError=''; }
    catch { storageError='Der Browser konnte die Partie nicht speichern.'; }
  }
  function send(msg) { if (link?.open) link.send(msg); }
  function publish() {
    persist();
    if (role==='host') send({op:'state',roundId,seq:++revision,game});
    draw();
  }
  function activeBoard() { return role==='host' && player(game)===1 ? remoteBoard : localBoard; }
  function turnChanged(before) {
    if (!onlineGame || game.epoch===before || game.final || game.review) return;
    const b=activeBoard();
    const up=player(game)===0?connected:remoteConnected;
    game.gate = game.modes[player(game)]==='manual' || (up && b && ['snapshot','empty','correction'].includes(b.kind) && !b.darts.length) ? 'ready' : 'clear';
  }
  function act(op,arg) {
    if (!game || (onlineGame && !link?.open)) return;
    if (role==='guest') { if (player(game)===1) send({op:'action',action:op,arg,roundId,epoch:game.epoch}); return; }
    const before=game.epoch;
    command(game,op,arg,activeBoard()); turnChanged(before); publish();
  }
  function ingest(frame,who) {
    if (!game || game.final || (onlineGame && !link?.open) || (onlineGame && player(game)!==who)) return;
    const before=game.epoch, gate=game.gate, final=game.final;
    const visit=JSON.stringify(game.turn);
    acceptBoard(game,frame); turnChanged(before);
    if (game.epoch!==before || game.gate!==gate || game.final!==final || JSON.stringify(game.turn)!==visit) publish();
  }
  function boardUrl(value) {
    const withProtocol=/^\w+:\/\//.test(value);
    const url=new URL(withProtocol?value:'http://'+value);
    if (!['http:','https:','ws:','wss:'].includes(url.protocol) || url.username || url.password || !['/','/api/events','/api/events/'].includes(url.pathname)) throw Error('Board-Adresse prüfen');
    const secure=['https:','wss:'].includes(url.protocol) || (!withProtocol && url.port==='3181');
    url.protocol=secure?'wss:':'ws:';
    if (!url.port) url.port=secure?'3181':'3180';
    url.pathname='/api/events';url.search='?type=state';url.hash='';return url.href;
  }
  function stopSocket() { clearTimeout(retry);const old=socket;socket=null;connected=false;lastWire=null;localBoard=null;if(old) old.close(); }
  function profile() { return {name:prefs.names[role==='guest'?1:0],mode:prefs.mode,connected}; }
  function boardLost() {
    if (role==='guest') send({op:'profile',profile:profile()});
    if (game && !game.final && !game.review && prefs.mode==='board' && role!=='guest' && (!onlineGame || player(game)===0)) game.gate='sync';
  }
  function connect() {
    stopSocket();
    if (prefs.mode!=='board') {diagnosis='Manuelle Eingabe';draw();return;}
    let ws;
    try { ws=new WebSocket(boardUrl(prefs.address)); socket=ws; }
    catch(error) { diagnosis=error.message;boardLost();publish();return; }
    diagnosis='Verbindung wird aufgebaut';info();
    ws.onopen=()=>{ if(socket!==ws)return;connected=true;diagnosis='Verbunden – wartet auf Board-Meldung';if(role==='guest')send({op:'profile',profile:profile()});info(); };
    ws.onmessage=({data})=>{
      if(socket!==ws)return;
      let frame;
      try {frame=readBoard(data);} catch(e){lastWire=null;localBoard=null;diagnosis=e.message;info();return;}
      if(!frame)return;
      lastWire=data;localBoard=frame;
      diagnosis=frame.label+' · '+frame.darts.length+'/3 · '+(frame.darts.join(' / ') || 'leer');
      if(role==='guest') send({op:'board',raw:data,roundId,epoch:game?.epoch});
      else ingest(frame,0);
      info();
    };
    ws.onerror=()=>{if(socket===ws){diagnosis='Verbindung zum Board fehlgeschlagen';info();}};
    ws.onclose=()=>{
      if(socket!==ws)return;
      socket=null;connected=false;lastWire=null;localBoard=null;diagnosis='Board getrennt – neuer Versuch in 3 s';
      boardLost();publish();retry=setTimeout(connect,3000);
    };
  }
  function closeRoom() {
    const old=peer;peer=null;link=null;friend=null;remoteBoard=null;remoteConnected=false;
    role='local';code='';roomStatus='';received=-1;
    if(old) old.destroy();
  }
  function attach(c) {
    if(link){c.on('open',()=>c.close());return;} link=c;
    c.on('open',()=>{ if(link!==c)return;roomStatus='Mitspieler verbunden';
      if(role==='guest')send({op:'profile',profile:profile()}); else publish();draw(); });
    c.on('data',m=>{
      if(link!==c || !m || typeof m!=='object')return;
      if(role==='guest'){
        if(m.op!=='state' || !Number.isSafeInteger(m.seq) || m.seq<=received || typeof m.roundId!=='string')return;
        if(m.game !== null && (!validGame(m.game) || m.game.names.length!==2))return;
        const changedTurn=roundId!==m.roundId || game?.epoch!==m.game?.epoch;
        received=m.seq;roundId=m.roundId;game=m.game;onlineGame=!!game;
        if (changedTurn && game && player(game)===1 && game.modes[1]==='board' && lastWire)
          send({op:'board',raw:lastWire,roundId,epoch:game.epoch});
        draw();return;
      }
      if(m.op==='profile' && ['manual','board'].includes(m.profile?.mode)){
        friend={name:String(m.profile.name||'Gast').slice(0,50),mode:m.profile.mode};
        remoteConnected=m.profile.connected===true;
        if(!remoteConnected){remoteBoard=null;if(game && player(game)===1 && game.modes[1]==='board' && !game.final)game.gate='sync';}
        publish();return;
      }
      if(m.op==='board' && typeof m.raw==='string' && m.raw.length<=20000){
        try {
          const frame=readBoard(m.raw); if(!frame)return;
          remoteBoard=frame;
          if(game && m.roundId===roundId && m.epoch===game.epoch)ingest(frame,1);
        } catch {remoteBoard=null;} return;
      }
      if(m.op==='action' && game && m.roundId===roundId && m.epoch===game.epoch && player(game)===1)act(m.action,m.arg);
    });
    c.on('close',()=>{if(link!==c)return;link=null;friend=null;remoteBoard=null;remoteConnected=false;
      roomStatus='Mitspieler getrennt. Zum Fortsetzen wieder verbinden.';
      if(role==='host' && game && !game.final && game.modes[player(game)]==='board')game.gate='sync';
      publish();});
    c.on('error',e=>{if(link===c){roomStatus=String(e.message);draw();}});
  }
  function openRoom(host) {
    const requested = (main.querySelector('#code')?.value||'').trim().toUpperCase();
    if(!host && !/^[A-F0-9]{6}$/.test(requested)){roomStatus='Sechsstelligen Raumcode eingeben.';draw();return;}
    closeRoom();role=host?'host':'guest';code=host?crypto.randomUUID().slice(0,6).toUpperCase():requested;
    roomStatus='Raum wird verbunden';const prefix='cutthroat-v1-';
    try {
      const p=new Peer(host?prefix+code:undefined);peer=p;
      p.on('open',()=>{if(peer!==p)return;if(!host)attach(p.connect(prefix+code,{reliable:true}));else {roomStatus='Warte auf Mitspieler';draw();}});
      p.on('connection',c=>{if(peer===p && host)attach(c);else c.close();});
      p.on('error',e=>{if(peer===p){roomStatus=String(e.message);draw();}});
    } catch(e){closeRoom();roomStatus='Online-Verbindung fehlgeschlagen: '+e.message;}
    draw();
  }

  function setup() {
    const editable = role==='local'?prefs.names.map((_,i)=>i):[role==='host'?0:1];
    return `<article><h2>Spieler</h2><div id="players">${editable.map(i=>`<div class="row" data-row="${i}">
      ${role==='local'?`<button class="grip" data-grip="${i}" title="Ziehen oder Pfeiltasten verwenden" aria-label="Platz ${i+1} verschieben">➳➳➳</button>`:''}
      <input data-name="${i}" maxlength="50" aria-label="Spieler ${i+1}" value="${esc(prefs.names[i])}"></div>`).join('')}</div>
      ${role==='local'?btn('add','+ Spieler',prefs.names.length>=8)+btn('remove','− Spieler',prefs.names.length<=2):''}</article>
      <article><h2>Spiel einrichten</h2><div class="line"><label>Eingabe <select id="mode">${option('board','Mit Kameras',prefs.mode)+option('manual','Ohne Kameras',prefs.mode)}</select></label>
      ${role!=='guest'?`<label>Bull <select id="bull">${['always','never','random'].map((m,i)=>option(m,['Immer','Nie','Zufällig'][i],prefs.bull)).join('')}</select></label>`:''}</div>
      ${prefs.mode==='board'?`<p><label>Board-Adresse <input id="address" value="${esc(prefs.address)}"></label> ${btn('connect','Verbinden')}</p><small>Vor dem Start alle Darts herausziehen.</small>`:''}
      <nav>${btn('start',role==='guest'?'Host startet':'Ziele auslosen & starten',role==='guest'||(role==='host'&&!friend),'primary')}</nav></article>
      <article><h2>Online zu zweit</h2>${role==='local'?`<div class="line">${btn('host','Raum erstellen')}<input id="code" maxlength="6" placeholder="Raumcode" aria-label="Raumcode">${btn('join','Beitreten')}</div>`:
      `Raum <strong>${esc(code)}</strong> · ${esc(friend?.name||'')} ${btn('leave','Raum verlassen')}`}</article>`;
  }
  const statusText={clear:'Board leeren',pulling:'Darts herausziehen',sync:'Board und Aufnahme prüfen'};
  function boardDiagram(g, marks) {
    const order=[20,1,18,4,13,6,10,15,2,17,3,19,7,16,8,11,14,9,12,5];
    const point=(angle,r)=>[120+r*Math.sin(angle*Math.PI/180),120-r*Math.cos(angle*Math.PI/180)];
    const wedges=order.map((n,i)=>{
      const angle=i*18;
      const needed=g.numbers.includes(n), closed=marks[n]===3;
      const fill=needed?(closed?'#246d52':'#f8ce75'):(i%2?'#eceee8':'#cbd3ca');
      const a=point(angle-9,91),b=point(angle+9,91),t=point(angle,104);
      return `<path d="M120 120 L${a} A91 91 0 0 1 ${b} Z" fill="${fill}" stroke="white"/>
        <text x="${t[0]}" y="${t[1]}" text-anchor="middle" dominant-baseline="central" font-size="10">${n}</text>`;
    }).join('');
    const bullFill=g.numbers.includes(25)?(marks[25]===3?'#246d52':'#f8ce75'):'#cbd3ca';
    return `<svg viewBox="0 0 240 240" style="display:block;width:min(100%,280px);margin:auto" role="img" aria-label="Ziele des aktuellen Spielers">
      ${wedges}<circle cx="120" cy="120" r="12" fill="${bullFill}" stroke="white"/></svg>`;
  }

  function playing() {
    const i=player(game), {players,winner}=scoreboard(game), darts=slots(game.turn);
    const control=(role!=='guest'||i===1) && (!onlineGame || link?.open);
    const editable=control && !game.final && (game.gate==='ready'||game.review);
    const manual=game.modes[i]==='manual';
    const heading=winner!==null?game.names[winner]+' gewinnt!':game.names[i]+' ist dran';
    const correction=(n)=>{
      const original=game.turn.raw[n];
      const selected=own(game.turn.edits,n)?game.turn.edits[n]??'ignore':'original';
      return `<label>Dart ${n+1}<select data-edit="${n}" ${editable?'':'disabled'}>${option('original',original||'Noch kein Wurf',selected)+option('ignore','Streichen',selected)+values.map(v=>option(v,v,selected)).join('')}</select></label>`;
    };
    return `<article><h2>${esc(heading)}</h2><strong>${darts.length}/3 Darts</strong> · ${esc(game.review?'Vorherige Aufnahme korrigieren':statusText[game.gate] || (game.final?'Spiel beendet':'Aufnahme '+(game.turns.length+1)))}
      <div class="darts">${[0,1,2].map(correction).join('')}</div>
      <nav>${btn('previous','← Vorheriger Spieler',!control||game.final||!game.turns.length||!!darts.length||game.gate==='pulling')}
      ${btn('undo',manual?'Letzten Wurf zurück':'Letzten Dart streichen',!editable||!darts.length)}
      ${btn('reset','Aufnahme zurücksetzen',!editable||!darts.length)}
      ${btn('next',winner!==null?'Sieg bestätigen':'Nächster Spieler',!control||game.final||['clear','pulling'].includes(game.gate),'primary')}
      ${game.gate==='sync'?btn('resume','Board-Aufnahme übernehmen',!control):''}</nav></article>
      <div class="grid"><article><h2>Ziele für ${esc(game.names[i])}</h2>${boardDiagram(game,players[i].marks)}<small>Gelb · offen &nbsp; Grün · geschlossen</small></article><article class="table"><h2>Spielstand</h2><table><thead><tr><th>Ziel</th>${game.names.map((n,j)=>`<th class="${j===i?'current':''}">${esc(n)}</th>`).join('')}</tr></thead><tbody>
      ${game.numbers.map(n=>`<tr><th>${n===25?'Bull':n}</th>${players.map((p,j)=>`<td class="${j===i?'current ':''}${p.marks[n]===3?'closed':''}">${['–','/','×','⊗'][p.marks[n]||0]}</td>`).join('')}</tr>`).join('')}
      <tr class="score"><th>Strafpunkte</th>${players.map(p=>`<td>${p.score}</td>`).join('')}</tr></tbody></table></article></div>
      ${manual && editable && winner===null && darts.length<3?`<article><h2>Testwurf</h2><nav>${values.filter(v=>v==='MISS'||game.numbers.includes(Number(v.slice(1)))).map(v=>btn('hit-'+v,v)).join('')}</nav></article>`:''}
      <nav>${role!=='guest'?btn('new','Neues Spiel'):''} ${onlineGame && role==='local'?btn('host','Raum erneut öffnen'):''}
      ${onlineGame||role!=='local'?btn('leave','Online verlassen'):''}</nav>`;
  }
  function info() {
    const hook=main.querySelector('#diagnosis');
    if(hook) hook.textContent=prefs.mode==='manual'?'Manuelle Eingabe':(connected?'Board verbunden':'Board offline')+' · '+diagnosis;
  }
  let previousMarkup='';
  function draw() {
    if(dragging)return;
    const html=`<header><h1>Cricket Random Cutthroat</h1><div class="line"><span class="badge">${VERSION}</span>${btn('hide','Minimieren')}</div></header>
      <p id="diagnosis" aria-live="polite"></p>${roomStatus||storageError?`<p class="notice">${esc([roomStatus,storageError].filter(Boolean).join(' · '))}</p>`:''}
      ${game?playing():setup()}`;
    if(html!==previousMarkup){
      const active=ui.activeElement;
      if(active?.matches('select') && game && document.hasFocus()) {info();return;}
      const selector=active?.dataset.name!==undefined?'[data-name="'+Number(active.dataset.name)+'"]':
        active?.matches('#code,#address')?'#'+active.id:null;
      const caret=selector?active.selectionStart:null,end=selector?active.selectionEnd:null;
      const draft=active?.id==='code'?active.value:null;
      main.innerHTML=html;previousMarkup=html;
      const replacement=selector && main.querySelector(selector);
      if(replacement){if(draft!==null)replacement.value=draft;replacement.focus();replacement.setSelectionRange(caret,end);}
    }
    info();
  }
  function move(from,to) {
    if(game||role!=='local'||from===to||!Number.isInteger(to)||to<0||to>=prefs.names.length)return;
    prefs.names.splice(to,0,prefs.names.splice(from,1)[0]);persist();draw();
    main.querySelector('[data-grip="'+to+'"]')?.focus();
  }
  main.onpointerdown=e=>{
    const grip=e.target.closest('[data-grip]');if(!grip || !e.isPrimary||e.button!==0)return;
    dragging={id:e.pointerId,from:Number(grip.dataset.grip)};grip.setPointerCapture(e.pointerId);
  };
  const under=e=>ui.elementFromPoint(e.clientX,e.clientY)?.closest('[data-row]');
  main.onpointermove=e=>{
    if(dragging?.id!==e.pointerId)return;
    main.querySelector('.drop')?.classList.remove('drop');under(e)?.classList.add('drop');
  };
  function endDrag(e) {
    if(dragging?.id!==e.pointerId)return;
    const from=dragging.from, row=e.type==='pointerup'?under(e):null;
    dragging=null;main.querySelector('.drop')?.classList.remove('drop');
    if(row)move(from,Number(row.dataset.row));draw();
  }
  main.onpointerup=main.onpointercancel=main.onlostpointercapture=endDrag;
  main.onkeydown=e=>{
    if(e.target.dataset.grip===undefined||!['ArrowUp','ArrowDown'].includes(e.key))return;
    e.preventDefault();const from=Number(e.target.dataset.grip);move(from,from+(e.key==='ArrowUp'?-1:1));
  };
  main.oninput=e=>{
    if(e.target.dataset.name!==undefined){prefs.names[Number(e.target.dataset.name)]=e.target.value;if(role==='guest')send({op:'profile',profile:profile()});persist();}
    if(e.target.id==='address'){prefs.address=e.target.value.trim();persist();}
  };
  main.onchange=e=>{
    const el=e.target;
    if(el.dataset.edit!==undefined){el.blur();act('edit',{i:Number(el.dataset.edit),value:el.value});}
    if(el.id==='mode'){prefs.mode=el.value;persist();connect();if(role==='guest')send({op:'profile',profile:profile()});draw();}
    if(el.id==='bull'){prefs.bull=el.value;persist();}
  };
  main.addEventListener('focusout',e=>{if(e.target.matches('select'))requestAnimationFrame(draw);});
  main.onclick=e=>{
    const button=e.target.closest('[data-op]');if(!button)return;
    const op=button.dataset.op;
    if(op==='hide'){box.hidden=true;launcher.hidden=false;return;}
    if(op==='connect'){connect();return;}
    if(op==='host'||op==='join'){openRoom(op==='host');return;}
    if(op==='leave'){
      const wasGuest=role==='guest';closeRoom();onlineGame=false;
      if(wasGuest)game=null;
      else if(game){game.modes=game.names.map(()=>prefs.mode);game.gate=prefs.mode==='board'?'sync':'ready';}
      publish();return;
    }
    if(op==='new'){if(confirm('Partie beenden und ein neues Spiel einrichten?')){game=null;onlineGame=false;roundId=crypto.randomUUID();publish();}return;}
    if(op==='add'||op==='remove'){
      if(game||role!=='local')return;
      if(op==='add' && prefs.names.length<8)prefs.names.push('Spieler '+(prefs.names.length+1));
      if(op==='remove' && prefs.names.length>2)prefs.names.pop();
      persist();draw();return;
    }
    if(op==='start'){
      if(game||role==='guest'||(role==='host'&&!friend))return;
      if(prefs.mode==='board' && (!socket || socket.url!==safeAddress()))connect();
      const names=(role==='host'?[prefs.names[0],friend.name]:prefs.names).map((n,i)=>String(n).trim()||'Spieler '+(i+1));
      onlineGame=role==='host';roundId=crypto.randomUUID();
      game=createGame(names,targets(prefs.bull),names.map((_,i)=>onlineGame&&i===1?friend.mode:prefs.mode));
      if(prefs.mode==='board' && localBoard?.darts.length)game.gate='clear';
      publish();return;
    }
    if(op.startsWith('hit-'))act('throw',op.slice(4));else act(op);
  };
  function safeAddress() {try{return boardUrl(prefs.address);}catch{return '';}}
  launcher.onclick=()=>{launcher.hidden=true;box.hidden=false;draw();};
  draw();connect();
})();

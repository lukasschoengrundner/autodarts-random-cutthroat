// Two isolated userscript instances, with queued reliable messages and controllable board sockets.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const source = readFileSync(require.resolve('../v1/random-cutthroat.user.js'),'utf8');
function devices(){
  const pending=[], peers=new Map();
  function flush(){let n=0;while(pending.length){assert(++n<200,'message loop');pending.shift()();}}
  class Peer extends EventEmitter{
    constructor(id){super();this.id=id??crypto.randomUUID();peers.set(this.id,this);pending.push(()=>this.emit('open'));}
    connect(id){
      const host=peers.get(id);assert(host);
      const a=new EventEmitter(), b=new EventEmitter();
      a.send=m=>{const copy=structuredClone(m);pending.push(()=>b.emit('data',copy));};
      b.send=m=>{const copy=structuredClone(m);pending.push(()=>a.emit('data',copy));};
      pending.push(()=>{host.emit('connection',b);a.open=b.open=true;b.emit('open');a.emit('open');});return a;
    }
  }
  function client(storage=new Map()){
    const nodes={},sockets=[],inputs={code:{value:''}};
    class Node {
      constructor(tag){nodes[tag]=this;this.innerHTML='';}
      attachShadow(){return new Node('shadow');}
      append(){} addEventListener(){}
      querySelector(selector){return selector==='#code'?inputs.code:null;}
    }
    class Socket{
      constructor(url){this.url=url;sockets.push(this);pending.push(()=>this.onopen?.());}
      close(){this.onclose?.();}
    }
    vm.runInNewContext(source,{document:{documentElement:new Node('html'),createElement:t=>new Node(t),hasFocus:()=>false},
      crypto,URL,WebSocket:Socket,Peer,localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
      requestAnimationFrame:fn=>pending.push(fn),setTimeout:()=>0,clearTimeout(){},confirm:()=>true});
    const main=nodes.main;
    return {storage,html:()=>main.innerHTML,
      click:op=>main.onclick({target:{closest:()=>({dataset:{op}})}}),
      mode:value=>main.onchange({target:{id:'mode',dataset:{},value}}),
      code:value=>{inputs.code.value=value;},
      saved:()=>JSON.parse(storage.get('random-cutthroat-v1-game')),
      wire:(event,ns)=>sockets.at(-1).onmessage({data:JSON.stringify({type:'state',data:{
        event,running:true,status:'throw',throws:ns.map(n=>({segmentName:'S'+n,segmentNumber:n,multiplier:1}))}})})};
  }
  return {client,flush,peers};
}
test('local userscript receives first socket hits, restores a visit, resyncs, and rotates players',()=>{
  const env=devices();const c=env.client();env.flush();c.click('start');c.wire('throwDetected',[17,16]);
  assert.match(c.html(),/2\/3 Darts/);
  const restored=env.client(c.storage);env.flush();assert.match(restored.html(),/Board und Aufnahme prüfen/);
  restored.wire('throwDetected',[17,16,12]);restored.click('resume');assert.match(restored.html(),/3\/3 Darts/);
  restored.wire('takeoutFinished',[]);assert.match(restored.html(),/Spieler 2 ist dran/);
});
test('two devices score their own board, ignore inactive hits, and sync the next player once',()=>{
  const env=devices(),host=env.client(),guest=env.client();env.flush();
  host.click('host');env.flush();guest.code([...env.peers.keys()][0].slice(-6));guest.click('join');env.flush();
  host.click('start');env.flush();
  guest.wire('throwDetected',[19]);env.flush();assert.equal(host.saved().game.turn.raw.length,0);
  host.wire('throwDetected',[17,16,12]);host.wire('takeoutFinished',[]);env.flush();
  assert.match(guest.html(),/Spieler 2 ist dran/);assert.equal(host.saved().game.turns.length,1);
  assert.equal(host.saved().game.gate,'clear');
  guest.wire('takeoutFinished',[]);env.flush();
  guest.wire('throwDetected',[18,19,20]);env.flush();assert.match(host.html(),/3\/3 Darts/);
  guest.wire('takeoutFinished',[]);guest.wire('takeoutFinished',[]);env.flush();
  const g=host.saved().game;assert.equal(g.turns.length,2);assert.deepEqual(g.turns[1].raw,['S18','S19','S20']);
  assert.match(guest.html(),/Spieler 1 ist dran/);
});

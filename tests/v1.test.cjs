const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createGame,targets,readBoard,slots,scoreboard,command,acceptBoard,player} = require('../v1/random-cutthroat.user.js');
const numbers = [20,19,18,17,16,12,25];
const start = (mode='board',count=2) => createGame(Array.from({length:count},(_,i)=>'Spieler '+(i+1)),numbers,Array(count).fill(mode));
const flat = n => ({segmentNumber:n,multiplier:1,segmentName:'S'+n});
const wire = (event,throws,status='throw') => JSON.stringify({type:'state',data:{running:true,event,status,throws}});
const frame = (event,darts,status) => readBoard(wire(event,darts.map(flat),status));
const emit = (g,event,darts,status) => acceptBoard(g,frame(event,darts,status));
test('first visit without an initial empty frame, duplicate updates and trailing takeout event on the next dart',()=>{
  const g=start();
  for(const list of [[17],[17],[17,16,12]])emit(g,'throwDetected',list);
  assert.deepEqual(slots(g.turn),['S17','S16','S12']);
  emit(g,'takeoutStarted',[17,16,12],'takeoutInProgress');
  emit(g,'throwDetected',[17]);
  emit(g,'takeoutFinished',[]);
  emit(g,'takeoutFinished',[]);
  emit(g,'takeoutFinished',[19]);emit(g,'throwDetected',[19]);
  assert.equal(player(g),1);assert.equal(g.turns.length,1);
  assert.deepEqual(slots(g.turn),['S19']);assert.equal(scoreboard(g).players[1].marks[19],1);
});
test('both wire formats, bull, outside, bouncers, unknown packets and partial snapshots',()=>{
  const darts=[{segment:{number:25,multiplier:2}}, {segmentName:'M14',segmentNumber:14,multiplier:0,bed:'Outside'}, {failed:true,bouncer:true}];
  assert.deepEqual(readBoard(wire('Throw detected',darts)).darts,['D25','MISS','MISS']);
  assert.equal(readBoard('{"type":"stats"}'),null);
  assert.throws(()=>readBoard(wire('throwDetected',[{}])));
  assert.throws(()=>readBoard('{"type":"state","data":{"numThrows":2,"throws":[]}}'));
  assert.throws(()=>readBoard(wire('throwDetected',[{number:25,multiplier:3}])));
});
test('manual corrections are slot-specific and board changes replace exactly the affected slot',()=>{
  const g=start();
  command(g,'edit',{i:2,value:'T20'});emit(g,'throwDetected',[17]);
  assert.deepEqual(slots(g.turn),['S17',null,'T20']);
  command(g,'edit',{i:0,value:'D17'});emit(g,'throwDetected',[17]);
  assert.equal(scoreboard(g).players[0].marks[17],2);
  emit(g,'throwDetected',[17,18,19]);
  assert.deepEqual(slots(g.turn),['D17','S18','S19']);
  command(g,'undo');emit(g,'throwDetected',[17,18,19]);assert.deepEqual(slots(g.turn),['D17','S18',null]);
  command(g,'reset');assert.deepEqual(slots(g.turn),[null,null,null]);assert.equal(scoreboard(g).players[0].marks[17],undefined);
});
test('review after a takeout counts the very next dart; manual advance with darts in board waits',()=>{
  const g=start();emit(g,'throwDetected',[17]);emit(g,'takeoutFinished',[]);
  command(g,'previous');command(g,'edit',{i:0,value:'T17'});command(g,'next',null,frame('takeoutFinished',[]));
  emit(g,'throwDetected',[16]);assert.equal(scoreboard(g).players[1].marks[16],1);
  command(g,'next',null,frame('throwDetected',[16]));emit(g,'throwDetected',[16]);command(g,'next');
  assert.equal(g.turns.length,2);assert.deepEqual(slots(g.turn),[]);
  emit(g,'takeoutFinished',[]);emit(g,'throwDetected',[12]);assert.equal(player(g),0);assert.deepEqual(slots(g.turn),['S12']);
});
test('uncertain count decrease pauses, explicit reconciliation and manual reset preserve earlier turns',()=>{
  const g=start();emit(g,'throwDetected',[17]);emit(g,'takeoutFinished',[]);emit(g,'throwDetected',[19,20]);
  emit(g,'throwDetected',[16]);assert.equal(g.gate,'sync');emit(g,'takeoutFinished',[]);assert.equal(player(g),1);
  command(g,'resume',null,frame('takeoutFinished',[]));assert.equal(g.gate,'sync');
  command(g,'resume',null,frame('throwDetected',[16]));assert.deepEqual(slots(g.turn),['S16']);
  emit(g,'manualReset',[]);assert.deepEqual(slots(g.turn),[]);assert.equal(scoreboard(g).players[0].marks[17],1);
  command(g,'resume',null,frame('manualReset',[]));assert.equal(g.gate,'ready');
});
test('random goals respect all bull settings and display order',()=>{
  for(const mode of ['random','always','never'])for(let i=0;i<100;i++){
    const ns=targets(mode);assert.equal(new Set(ns).size,7);if(mode!=='random')assert.equal(ns.includes(25),mode==='always');
    assert.deepEqual(ns.filter(n=>n!==25),ns.filter(n=>n!==25).sort((a,b)=>b-a));
  }
});
for(const count of [2,3,8])test('full local round with '+count+' players, overflow, corrections and bull finish',()=>{
  const g=start('manual',count);
  const visit=ds=>ds.forEach(d=>command(g,'throw',d));
  const cycle=()=>{command(g,'next');for(let i=1;i<count;i++){assert.equal(player(g),i);visit(['MISS','MISS','MISS']);command(g,'next');}};
  visit(['T20','T20','T19','D25']);assert.equal(slots(g.turn).length,3);
  assert(scoreboard(g).players.slice(1).every(p=>p.score===60));cycle();
  visit(['T18','T17','T16']);cycle();visit(['T12','D25','S25']);assert.equal(scoreboard(g).winner,0);
  command(g,'edit',{i:2,value:'MISS'});assert.equal(scoreboard(g).winner,null);
  command(g,'undo');command(g,'throw','S25');command(g,'next');assert.equal(g.final,true);
  assert.equal(scoreboard(g).winner,0);
});
for(const count of [2,3,8])test('complete camera game with '+count+' players and repeated takeout',()=>{
  const g=start('board',count);
  function visit(ds){
    const darts=[];
    for(const d of ds){
      const multiplier={S:1,D:2,T:3}[d[0]]??0;
      darts.push({segmentName:d,segmentNumber:multiplier?Number(d.slice(1)):0,multiplier});
      acceptBoard(g,readBoard(wire('throwDetected',darts)));
    }
    acceptBoard(g,readBoard(wire('takeoutStarted',darts,'takeoutInProgress')));
    emit(g,'takeoutFinished',[]);emit(g,'takeoutFinished',[]);
  }
  for(const ds of [['T20','T19','T18'],['T17','T16','T12'],['D25','S25']]){
    assert.equal(player(g),0);visit(ds);if(g.final)break;
    for(let i=1;i<count;i++){assert.equal(player(g),i);visit(['MISS','MISS','MISS']);}
  }
  assert.equal(g.final,true);assert.equal(scoreboard(g).winner,0);assert.equal(g.turns.length,count*2);
});

const assert=require('node:assert/strict'),H=require('../history.js');
const before={warehousePhoto:'',shelves:[{id:'s',name:'Direita',zone:{x:1,y:2,w:30,h:10},items:[{id:'i',name:'Cimento',quantity:400,unit:'un',asset:'P1',notes:'',photo:'photo:old',row:'A',start:1,span:1,updatedAt:'old'}]}]};
const next=JSON.parse(JSON.stringify(before));Object.assign(next.shelves[0].items[0],{name:'Cimento CP2',quantity:350,asset:'P2',notes:'Nova remessa',photo:'photo:new',span:2});
const events=H.diff(before,next),e=events[0];assert.equal(events.length,1);assert.equal(e.action,'update');assert.deepEqual(e.changes.find(c=>c.field==='quantity'),{field:'quantity',before:400,after:350});
for(const field of ['name','quantity','asset','notes','photo','span','location'])assert(e.changes.some(c=>c.field===field));
const timestampOnly=JSON.parse(JSON.stringify(before));timestampOnly.shelves[0].items[0].updatedAt='new';assert.equal(H.diff(before,timestampOnly).length,0);
const deleted={warehousePhoto:'',shelves:[]};assert.equal(H.diff(before,deleted).filter(e=>e.action==='delete').length,2);
const log={actorName:'Gabriel',actorEmail:'gabriel@example.com',createdAt:'2026-09-28T12:00:00Z'};
assert(H.matches(e,log,{person:'GABRIEL',field:'quantity',action:'update',from:'2026-09-28',to:'2026-09-28'}));assert(!H.matches(e,log,{field:'zone'}));assert(!H.matches(e,log,{to:'2026-09-27'}));
console.log('OK: campos, valores anteriores, exclusões, imagens, mudanças reais e filtros.');

// O Firestore pode devolver mapas com as chaves em outra ordem.
const stored=JSON.parse(JSON.stringify(before));
stored.shelves[0].zone={h:20,w:50,x:1.1,y:78};
stored.shelves.push({id:'left',name:'Esquerda',zone:{h:20,w:50,x:0.9,y:1.9},items:[]});
const quantityOnly=JSON.parse(JSON.stringify(stored));
for(const shelf of quantityOnly.shelves){const z=shelf.zone;shelf.zone={x:z.x,y:z.y,w:z.w,h:z.h};}
quantityOnly.shelves[0].items[0].quantity=350;
const quantityEvents=H.diff(stored,quantityOnly);
assert.equal(quantityEvents.length,1,'Quantidade não deve registrar mudança de posição por ordem das chaves');
assert.equal(quantityEvents[0].kind,'item');
assert.deepEqual(quantityEvents[0].changes,[{field:'quantity',before:400,after:350}]);
const reorderOnly=JSON.parse(JSON.stringify(quantityOnly));reorderOnly.shelves[0].items[0].quantity=400;
assert.equal(H.diff(stored,reorderOnly).length,0);
quantityOnly.shelves[0].zone.x=1.2;
assert(H.diff(stored,quantityOnly).some(e=>e.kind==='shelf'&&e.changes.some(c=>c.field==='zone')));

assert(H.equal({zone:{h:20,w:50,x:1.1,y:78}},{zone:{x:1.1,y:78,w:50,h:20}}));
assert(!H.equal(['a','b'],['b','a']),'Ordem de prateleiras continua relevante');
assert(!H.equal({x:1},{y:1}));
assert(!H.equal(null,{}));
const legacy=[{kind:'shelf',changes:[{field:'zone',before:{h:20,w:50,x:1.1,y:78},after:{x:1.1,y:78,w:50,h:20}}]},quantityEvents[0]];
assert.deepEqual(H.meaningfulEvents(legacy),[quantityEvents[0]]);
assert.equal(legacy.length,2,'Filtro não modifica os registros originais');
console.log('OK: regressão reproduzida e corrigida; mudanças reais preservadas e registros falsos antigos filtrados.');

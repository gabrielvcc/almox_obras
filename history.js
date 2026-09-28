/* Histórico de alterações: comparação de valores e consulta pública. */
(function(root){
  'use strict';
  const fields={name:'Nome',quantity:'Quantidade',unit:'Unidade',asset:'Patrimônio',notes:'Observações',photo:'Imagem',location:'Posição',span:'Espaço ocupado',zone:'Posição e tamanho na planta',order:'Ordem das prateleiras'};
  function equal(a,b){
    if(a===b)return true;
    if(a===null||b===null||typeof a!=='object'||typeof b!=='object')return false;
    if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((value,index)=>equal(value,b[index]));
    const keys=Object.keys(a);
    return keys.length===Object.keys(b).length&&keys.every(key=>Object.prototype.hasOwnProperty.call(b,key)&&equal(a[key],b[key]));
  }
  function meaningfulEvents(events){
    return events.map(event=>({...event,changes:event.changes.filter(change=>!equal(change.before,change.after))})).filter(event=>event.changes.length);
  }
  function diff(before,after){
    const events=[];
    function record(kind,id,title,shelfId,shelfName,oldValue,newValue,keys){
      const changes=keys.filter(key=>!equal(oldValue?.[key]??null,newValue?.[key]??null)).map(field=>({field,before:oldValue?.[field]??null,after:newValue?.[field]??null}));
      if(changes.length)events.push({kind,entityId:id,title,shelfId,shelfName,location:newValue?.location||oldValue?.location||"",action:!oldValue?'create':!newValue?'delete':'update',changes});
    }
    record('warehouse','main','Foto do galpão','','',{photo:before.warehousePhoto},{photo:after.warehousePhoto},['photo']);
    const oldShelves=new Map(before.shelves.map(s=>[s.id,s])),newShelves=new Map(after.shelves.map(s=>[s.id,s]));
    function itemValue(item,state,shelfId){
      if(!item)return null;
      const index=state.shelves.findIndex(s=>s.id===shelfId),n=index*24+item.start;
      return {...item,location:item.row+n+(item.span===2?' + '+item.row+(n+1):'')};
    }
    for(const id of new Set([...oldShelves.keys(),...newShelves.keys()])){
      const old=oldShelves.get(id),next=newShelves.get(id),shelf=next||old;
      record('shelf',id,shelf.name,id,shelf.name,old,next,['name','zone']);
      const oldItems=new Map((old?.items||[]).map(i=>[i.id,i])),newItems=new Map((next?.items||[]).map(i=>[i.id,i]));
      for(const itemId of new Set([...oldItems.keys(),...newItems.keys()])){
        const a=itemValue(oldItems.get(itemId),before,id),b=itemValue(newItems.get(itemId),after,id);
        record('item',itemId,(b||a).name,id,shelf.name,a,b,['name','quantity','unit','asset','notes','photo','location','span']);
      }
    }
    if(before.shelves.length&&after.shelves.length&& !equal(before.shelves.map(s=>s.id),after.shelves.map(s=>s.id)))record('warehouse','order','Organização do galpão','','',{order:before.shelves.map(s=>s.name)},{order:after.shelves.map(s=>s.name)},['order']);
    return events;
  }
  const normalize=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  function matches(event,log,filters){
    if(filters.kind&&event.kind!==filters.kind||filters.action&&event.action!==filters.action||filters.shelf&&event.shelfId!==filters.shelf||filters.field&&!event.changes.some(c=>c.field===filters.field))return false;
    if(filters.person&&!normalize(log.actorName+' '+log.actorEmail).includes(normalize(filters.person)))return false;
    if(filters.search&&!normalize(event.title+' '+event.shelfName+' '+JSON.stringify(event.changes)).includes(normalize(filters.search)))return false;
    const date=new Date(log.createdAt);
    const day=date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');
    return !(filters.from&&day<filters.from||filters.to&&day>filters.to);
  }
  const api={diff,matches,fields,equal,meaningfulEvents};
  if(typeof module!=='undefined'&&module.exports){module.exports=api;return;}
  root.InventoryHistory=api;
  const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let cloud,logs=[],cursor=null,more=true,loading=false,initialized=false,generation=0;
  const actions={create:'Cadastro',update:'Edição',delete:'Exclusão'},kinds={item:'Item',shelf:'Prateleira',warehouse:'Galpão'};
  function filters(){return Object.fromEntries(['kind','action','shelf','field','person','search','from','to'].map(key=>[key,$('history-'+key).value]));}
  function value(field,v){
    if(v===null||v==='')return '<span class="history-muted">Não informado</span>';
    if(field==='photo')return '<button class="text-button" data-history-photo="'+esc(v)+'">Ver imagem</button>';
    if(field==='zone')return esc('Esquerda '+v.x+'% · topo '+v.y+'% · largura '+v.w+'% · altura '+v.h+'%');
    if(field==='span')return v===2?'Módulo inteiro':'Uma posição';
    if(Array.isArray(v))return esc(v.join(' → '));
    return esc(v);
  }
  function render(){
    const f=filters();let count=0;
    $('history-list').innerHTML=logs.map(log=>{
      const events=meaningfulEvents(log.events).filter(e=>matches(e,log,f));if(!events.length)return '';count+=events.length;
      const date=new Date(log.createdAt).toLocaleString('pt-BR');
      return '<article class="history-entry"><header><div class="history-avatar">'+esc((log.actorName||log.actorEmail||'?').slice(0,1).toUpperCase())+'</div><div><strong>'+esc(log.actorName||'Usuário')+'</strong><small>'+esc(log.actorEmail)+'</small></div><time datetime="'+esc(log.createdAt)+'">'+esc(date)+'</time></header>'+events.map(e=>'<details class="history-change" open><summary><span class="history-action '+e.action+'">'+actions[e.action]+'</span><strong>'+esc(e.title)+'</strong><small>'+kinds[e.kind]+(e.kind==='item'?' · '+esc(e.shelfName)+' · '+esc(e.location||''):'')+'</small></summary><div class="history-values"><div class="history-columns"><span>Campo</span><span>Antes</span><span>Depois</span></div>'+e.changes.map(c=>'<div class="history-value"><strong>'+esc(fields[c.field]||c.field)+'</strong><div>'+value(c.field,c.before)+'</div><div>'+value(c.field,c.after)+'</div></div>').join('')+'</div></details>').join('')+'</article>';
    }).join('');
    if(!count)$('history-list').innerHTML='<div class="catalog-empty"><h2>'+(loading?'Carregando histórico…':logs.length?'Nenhuma alteração corresponde aos filtros':'Ainda não há alterações registradas')+'</h2><p>O histórico começa a partir da ativação desta função.</p></div>';
    $('history-count').textContent=count+' alteração(ões) · '+logs.length+' salvamento(s) carregado(s)';
    $('history-more').hidden=!more;$('history-more').disabled=loading;$('history-refresh').disabled=loading;
    $('history-more').textContent=loading?'Carregando…':'Carregar registros anteriores';
  }
  async function load(reset=false){
    if(loading)return;
    const token=++generation;loading=true;$('history-error').textContent='';
    if(reset){logs=[];cursor=null;more=true;}render();
    try{
      const result=await cloud.getHistory(cursor);
      if(token!==generation)return;
      logs.push(...result.entries);cursor=result.cursor;more=result.more;
      const selected=$('history-shelf').value,options=new Map();
      for(const log of logs)for(const e of log.events)if(e.shelfId)options.set(e.shelfId,e.shelfName);
      $('history-shelf').innerHTML='<option value="">Todas</option>'+[...options].map(([id,name])=>'<option value="'+esc(id)+'">'+esc(name)+'</option>').join('');$('history-shelf').value=selected;
    }catch(error){$('history-error').textContent='Não foi possível carregar o histórico. '+cloud.errorMessage(error);}
    finally{loading=false;render();}
  }
  api.open=function(service){
    cloud=service;
    if(!initialized){
      initialized=true;
      $('history-field').innerHTML='<option value="">Todos</option>'+Object.entries(fields).map(([key,label])=>'<option value="'+key+'">'+label+'</option>').join('');
      for(const key of ['kind','action','shelf','field','person','search','from','to'])$('history-'+key).addEventListener('input',render);
      $('history-more').onclick=()=>load();$('history-refresh').onclick=()=>load(true);
      $('history-clear').onclick=()=>{for(const key of ['kind','action','shelf','field','person','search','from','to'])$('history-'+key).value='';render();};
      $('history-list').onclick=async event=>{
        const button=event.target.closest('[data-history-photo]');if(!button)return;
        const dialog=$('history-photo-dialog');$('history-photo-image').hidden=true;$('history-photo-status').textContent='Carregando foto…';dialog.showModal();
        try{const src=await cloud.getPhoto(button.dataset.historyPhoto);if(!dialog.open)return;$('history-photo-image').src=src;$('history-photo-image').hidden=false;$('history-photo-status').textContent='';}catch{$('history-photo-status').textContent='Não foi possível carregar esta foto.';}
      };
      $('history-photo-close').onclick=()=>$('history-photo-dialog').close();
    }
    load(true);
  };
})(typeof globalThis!=='undefined'?globalThis:this);

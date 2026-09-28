/* Planta vetorial baseada exclusivamente no estoque e nas áreas cadastradas. */
(function (root) {
  'use strict';
  const M = typeof module !== 'undefined' && module.exports ? require('./inventory.js') : root.Inventory;
  const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function move(zone, x, y) {
    return {...zone,x:Math.round(Math.max(0,Math.min(100-zone.w,x))*10)/10,y:Math.round(Math.max(0,Math.min(100-zone.h,y))*10)/10};
  }
  function nextZone(shelves) {
    for (let y=5;y<=75;y+=30) for (let x=3;x<=55;x+=46) {
      const zone={x,y,w:42,h:22};
      if (!shelves.some(s=>x<s.zone.x+s.zone.w+2&&x+44>s.zone.x&&y<s.zone.y+s.zone.h+2&&y+24>s.zone.y)) return zone;
    }
    return {x:5,y:5,w:42,h:22};
  }
  function draw(shelves, {editing=false,selected=null,preview=false}={}) {
    const racks=shelves.map(s=>{
      const z=s.zone,w=z.w*10,h=z.h*4,used=M.used(s);
      const vertical=h>w, length=Math.max(w,h), depth=Math.min(w,h,44,Math.max(18,length*.12));
      const x=vertical?(w-depth)/2:0,y=vertical?0:(h-depth)/2;
      const bay=length/12;
      let bays='';
      for(let m=0;m<12;m++) {
        // Na planta, cada módulo agrega a ocupação de todos os andares.
        const occupied=s.items.reduce((sum,item)=>sum+(Math.floor((item.start-1)/2)===m?item.span:0),0);
        bays+='<g class="plan-bay '+(occupied?'filled':'empty')+'"><title>Módulo '+(m+1)+' · '+occupied+' de 8 posições ocupadas</title><rect class="plan-bay-floor" x="'+(m*bay+2)+'" y="3" width="'+Math.max(1,bay-4)+'" height="'+(depth-6)+'"/>';
        if(occupied) {
          const bx=m*bay+bay*.18,bw=bay*.64;
          bays+='<rect class="plan-package" x="'+bx+'" y="'+(depth*.21)+'" width="'+bw+'" height="'+(depth*.58)+'" rx="1"/><path class="plan-package-seam" d="M'+(bx+bw/2)+' '+(depth*.21)+'v'+(depth*.58)+'"/>';
        }
        bays+='</g>';
      }
      let supports='';
      for(let m=0;m<=12;m++) supports+='<path class="plan-upright" d="M'+(m*bay)+' 0v'+depth+'"/>';
      const rotation=vertical?'translate('+depth+' 0) rotate(90)':'';
      return '<g class="plan-rack '+(used===96?'is-full ':'')+(selected===s.id?'is-selected':'')+'" data-plan-id="'+esc(s.id)+'" transform="translate('+(z.x*10)+' '+(z.y*4)+')" tabindex="'+(preview&&selected!==s.id?'-1':'0')+'" role="button" aria-label="'+esc(s.name+', vista de cima, '+used+' de 96 posições ocupadas'+(editing?'. Arraste ou use as setas para mover.':'. Abrir prateleira.'))+'"><title>'+esc(s.name)+' · '+used+'/96 posições</title>'+
        (editing?'<rect class="plan-placement" width="'+w+'" height="'+h+'"/>':'')+
        '<g transform="translate('+x+' '+y+')"><g transform="'+rotation+'"><rect class="plan-rack-shadow" x="2" y="3" width="'+length+'" height="'+depth+'" rx="1"/><rect class="plan-rack-frame" width="'+length+'" height="'+depth+'" rx="1"/>'+bays+supports+'<path class="plan-rail" d="M0 1H'+length+'M0 '+(depth-1)+'H'+length+'"/></g></g><text class="plan-rack-name" x="'+x+'" y="'+(y-9)+'" font-size="10">'+esc(s.name)+'</text></g>';
    }).join('');
    return '<svg class="warehouse-plan" viewBox="-60 -55 1120 515" xmlns="http://www.w3.org/2000/svg" aria-label="Planta interativa do galpão"><defs><pattern id="'+(preview?'preview':'main')+'-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#e6edf4" stroke-width=".6"/></pattern></defs><rect x="0" y="0" width="1000" height="400" fill="url(#'+(preview?'preview':'main')+'-grid)"/><path class="plan-wall" d="M0 145V0H1000V145M0 255V400H1000V255"/><path class="plan-gate" d="M0 145V255M1000 145V255"/><path class="plan-axis" d="M-35 200H1035"/><text class="plan-door" x="-28" y="202" transform="rotate(-90 -28 202)">ACESSO</text><text class="plan-door" x="1028" y="202" transform="rotate(90 1028 202)">ACESSO</text><text class="plan-heading" x="0" y="-23">GALPÃO / PLANTA ILUSTRATIVA</text><text class="plan-footnote" x="0" y="436">'+shelves.length+' PRATELEIRA(S) · VISTA DE CIMA</text><text class="plan-footnote" x="1000" y="436" text-anchor="end">SEM ESCALA</text>'+racks+'</svg>';
  }
  const api={draw,move,nextZone};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.WarehousePlan=api;
})(typeof globalThis!=='undefined'?globalThis:this);

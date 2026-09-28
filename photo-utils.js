/* Fotos compactas para documentos do Firestore, sem envio ao Storage. */
(() => {
  const MAX_LENGTH = 260000;
  async function compress(source) {
    const image = new Image();
    await new Promise((resolve,reject) => {image.onload=resolve;image.onerror=()=>reject(new Error('Não foi possível abrir essa imagem.'));image.src=source;});
    let edge=1200;
    for(let attempt=0;attempt<7;attempt++) {
      const scale=Math.min(1,edge/Math.max(image.naturalWidth,image.naturalHeight));
      const canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
      const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
      for(const quality of [.82,.68,.54]) {
        const data=canvas.toDataURL('image/jpeg',quality);
        if(data.length<=MAX_LENGTH)return data;
      }
      edge=Math.round(edge*.75);
    }
    throw new Error('Não foi possível reduzir essa foto. Tente outra imagem.');
  }
  async function fromFile(file) {
    if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('Escolha uma imagem JPG, PNG ou WebP.');
    if(file.size>25*1024*1024)throw new Error('A imagem deve ter no máximo 25 MB.');
    const url=URL.createObjectURL(file);
    try {return await compress(url);} finally {URL.revokeObjectURL(url);}
  }
  window.AlmoxPhotos={MAX_LENGTH,compress,fromFile};
})();

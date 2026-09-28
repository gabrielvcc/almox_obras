/* Cliente novo e anônimo: verifica fotos sem cache nem sessão de administrador. */
const fs=require('node:fs'),assert=require('node:assert/strict');
global.window=global;global.Inventory=require('../../inventory.js');
global.location={hostname:'127.0.0.1'};
Object.defineProperty(global,'navigator',{value:{onLine:true},configurable:true});
global.addEventListener=()=>{};
global.ALMOX_FIREBASE_CONFIG={apiKey:'demo-key',authDomain:'demo-almox.firebaseapp.com',projectId:'demo-almox',appId:'demo-app'};
global.ALMOX_FIREBASE_EMULATORS=true;
new Function(fs.readFileSync('firebase-client.js','utf8').replace('import(SDK + "firebase-" + name + ".js")','import("firebase/" + name)'))();
const timer=setTimeout(()=>{console.error('Timeout na leitura pública');process.exit(1);},15000);
AlmoxCloud.init({onState:record=>{
  try {assert(record.exists);assert(record.state.warehousePhoto.startsWith('data:image/png;base64,'));clearTimeout(timer);console.log('OK: foto carregada por cliente anônimo sem cache.');process.exit(0);}
  catch(error){console.error(error);process.exit(1);}
},onSession:()=>{},onError:error=>{console.error(error);process.exit(1);}});

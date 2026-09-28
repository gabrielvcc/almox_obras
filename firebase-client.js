/* Firebase: um estoque compartilhado. Sem configuração, a edição permanece bloqueada. */
(() => {
  "use strict";
  const SDK = "https://www.gstatic.com/firebasejs/12.19.0/";
  const M = window.Inventory;
  let auth, db, A, F, rootRef, ready = false, busy = false;
  let callbacks = {}, session = {user: null, admin: false}, cache = null, roleUnsubscribe, roleGeneration = 0, loadGeneration = 0;
  let storedState = null;
  const photoCache = new Map();
  const photoRef = value => /^photo:[A-Za-z0-9_-]{1,100}$/.test(value);
  const photoValues = state => [state.warehousePhoto, ...state.shelves.flatMap(s => s.items.map(i => i.photo))];
  async function mapPhotos(state, transform) {
    const result=M.clone(state);
    result.warehousePhoto=await transform(result.warehousePhoto);
    for(const shelf of result.shelves) for(const item of shelf.items) item.photo=await transform(item.photo);
    return result;
  }
  async function resolvePhoto(value) {
    if(!photoRef(value)) return value;
    if(photoCache.has(value)) return photoCache.get(value);
    const doc=await F.getDocFromServer(F.doc(db,"photos",value.slice(6)));
    if(!doc.exists()) throw new Error("Uma foto não foi encontrada. Recarregue o estoque.");
    const data=doc.data().data;
    if(typeof data!=="string" || data.length>260000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error("Foto armazenada inválida.");
    photoCache.set(value,data);return data;
  }
  const config = window.ALMOX_FIREBASE_CONFIG;
  const configured = !!(config?.apiKey && config?.authDomain && config?.projectId && config?.appId);
  const empty = () => { const state = M.defaultState(); state.shelves[0].id = "initial-shelf"; return state; };
  function errorMessage(error) {
    const messages = {
      "auth/popup-closed-by-user": "A janela de login foi fechada.",
      "auth/cancelled-popup-request": "Uma nova tentativa de login foi iniciada.",
      "auth/popup-blocked": "Permita a janela de login no navegador e tente novamente.",
      "auth/unauthorized-domain": "Este endereço ainda não foi autorizado para login.",
      "auth/operation-not-allowed": "O login com Google ainda não foi habilitado.",
      "auth/network-request-failed": "Não foi possível conectar. Confira sua internet.",
      "permission-denied": "Você não tem permissão para alterar o estoque.",
      "unavailable": "Não foi possível conectar ao estoque. Tente novamente.",
      "conflict": "O estoque foi atualizado por outra pessoa. Feche e reabra o cadastro antes de salvar."
    };
    return messages[error?.code] || error?.message || "Não foi possível concluir. Tente novamente.";
  }
  function sessionChanged() {
    callbacks.onSession?.({user: session.user ? {uid: session.user.uid, displayName: session.user.displayName || "", email: session.user.email || ""} : null, admin: session.admin, ready, configured});
  }
  function fail(error) { ready = false; sessionChanged(); callbacks.onError?.(errorMessage(error)); }
  function requireAdmin() {
    if (!ready || !auth?.currentUser || !session.admin || !navigator.onLine) throw new Error("Somente administradores conectados podem editar o estoque.");
  }
  function conflict() { const error = new Error(); error.code = "conflict"; return error; }
  async function loadStock() {
    const generation = ++loadGeneration;
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const before = await F.getDocFromServer(rootRef);
        if (generation !== loadGeneration) return;
        if (!before.exists()) {
          cache = {state: empty(), revision: 0, exists: false}; storedState=M.clone(cache.state); ready = true;
          callbacks.onState?.(M.clone(cache)); sessionChanged(); return;
        }
        const shelves = await F.getDocsFromServer(F.collection(db, "warehouses/main/shelves"));
        const data = before.data(), byId = new Map(shelves.docs.map(doc => [doc.id, doc.data()]));
        if (!Array.isArray(data.shelfIds) || !Number.isInteger(data.revision)) throw new Error("Não foi possível ler o estoque.");
        const raw={version:1,warehousePhoto:data.warehousePhoto||"",shelves:data.shelfIds.map(id=>byId.get(id))};
        let state, photoError;
        try {state=M.validateState(await mapPhotos(raw,resolvePhoto));} catch(error) {photoError=error;}
        const after = await F.getDocFromServer(rootRef);
        if (generation !== loadGeneration) return;
        if (!after.exists() || data.revision !== after.data().revision) continue;
        if(photoError)throw photoError;
        storedState=raw;
        const active=new Set(photoValues(raw).filter(photoRef));
        for(const key of photoCache.keys())if(!active.has(key))photoCache.delete(key);
        cache = {state, revision: data.revision, exists: true}; ready = true;
        callbacks.onState?.(M.clone(cache)); sessionChanged(); return;
      }
      throw new Error("O estoque está sendo atualizado. Tente novamente em instantes.");
    } catch (error) { if (generation === loadGeneration) fail(error); }
  }
  async function init(options) {
    callbacks = options;
    sessionChanged();
    if (!configured) {
      callbacks.onState?.({state: empty(), revision: 0, exists: false});
      callbacks.onError?.("O estoque ainda não está disponível.");
      return;
    }
    try {
      const modules = await Promise.all(["app", "auth", "firestore"].map(name => import(SDK + "firebase-" + name + ".js")));
      const app = modules[0].initializeApp(config);
      [A, F] = modules.slice(1);
      auth = A.getAuth(app); auth.languageCode = "pt-BR";
      db = F.getFirestore(app);
      // Os emuladores só podem ser ativados explicitamente em endereço de loopback.
      const emulator = window.ALMOX_FIREBASE_EMULATORS;
      if (emulator && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) && config.projectId.startsWith("demo-")) {
        A.connectAuthEmulator(auth, "http://127.0.0.1:9099", {disableWarnings: true});
        F.connectFirestoreEmulator(db, "127.0.0.1", 8088);
      }
      rootRef = F.doc(db, "warehouses", "main");
      A.onAuthStateChanged(auth, user => {
        const generation = ++roleGeneration;
        roleUnsubscribe?.(); session = {user, admin: false}; sessionChanged();
        if (!user) return;
        roleUnsubscribe = F.onSnapshot(F.doc(db, "admins", user.uid), {includeMetadataChanges: true}, snapshot => {
          if (generation !== roleGeneration) return;
          // Nunca concede edição apenas a partir de uma permissão em cache.
          if (snapshot.metadata.fromCache) return;
          session.admin = snapshot.exists() && snapshot.data().enabled === true;
          sessionChanged();
        }, () => { if (generation === roleGeneration) { session.admin = false; sessionChanged(); } });
      }, fail);
      F.onSnapshot(rootRef, {includeMetadataChanges: true}, snapshot => {
        if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) loadStock();
      }, fail);
      window.addEventListener("offline", () => { ready = false; sessionChanged(); callbacks.onError?.("Sem conexão. As alterações estão temporariamente indisponíveis."); });
      window.addEventListener("online", () => { loadStock(); });
    } catch (error) { fail(error); }
  }
  async function login() {
    if (!auth) throw new Error("O login ainda não está disponível.");
    const provider = new A.GoogleAuthProvider();
    provider.setCustomParameters({prompt: "select_account"});
    try { await A.signInWithPopup(auth, provider); } catch (error) { throw new Error(errorMessage(error)); }
  }
  async function logout() {
    session.admin = false; sessionChanged();
    if (auth) await A.signOut(auth);
  }
  async function saveState(raw, expectedRevision) {
    requireAdmin();
    if (busy) throw new Error("Aguarde o salvamento em andamento.");
    if (!cache || cache.revision !== expectedRevision) throw new Error(errorMessage(conflict()));
    const previous=M.clone(storedState), validated=M.validateState(raw), pending=new Map(), reused=new Map();
    for(const ref of photoValues(previous))if(photoRef(ref)&&photoCache.has(ref))reused.set(photoCache.get(ref),ref);
    busy=true;
    const uid=auth.currentUser.uid;
    try {
      const next=await mapPhotos(validated,async photo=>{
        if(!photo || !photo.startsWith("data:"))return photo;
        if(reused.has(photo))return reused.get(photo);
        const original=photo;
        if(photo.length>260000)photo=await window.AlmoxPhotos.compress(photo);
        if(photo.length>260000)throw new Error("A foto precisa ser reduzida antes de salvar.");
        if(reused.has(photo)){reused.set(original,reused.get(photo));return reused.get(photo);}
        const ref="photo:"+M.uid();pending.set(ref,photo);reused.set(photo,ref);reused.set(original,ref);return ref;
      });
      for(const shelf of next.shelves)if(new Blob([JSON.stringify(shelf)]).size>800000)throw new Error("Esta prateleira tem informações demais. Reduza as observações antes de salvar.");
      const active=new Set(photoValues(next).filter(photoRef));
      const removed=[]; // Fotos antigas permanecem disponíveis no histórico.
      const size=JSON.stringify(next).length+[...pending.values()].reduce((sum,data)=>sum+data.length,0)+removed.reduce((sum,ref)=>sum+(photoCache.get(ref)?.length||260000),0);
      if(size>7000000 || pending.size+removed.length+next.shelves.length+previous.shelves.length>450)throw new Error("Há fotos demais para uma única alteração. Faça a mudança em etapas menores.");
      const display=M.validateState(await mapPhotos(next,ref=>pending.get(ref)||photoCache.get(ref)||ref));
      requireAdmin();
      if(auth.currentUser.uid!==uid)throw new Error("A conta mudou. Reabra o cadastro antes de salvar.");
      const events=window.InventoryHistory.diff(cache.exists?previous:{version:1,warehousePhoto:"",shelves:[]},next);
      if(!events.length)return M.clone(cache);
      const identity=await auth.currentUser.getIdTokenResult();
      requireAdmin();
      if(auth.currentUser.uid!==uid)throw new Error("A conta mudou. Reabra o cadastro antes de salvar.");
      const historyId=M.uid();
      const history={revision:expectedRevision+1,actorUid:uid,actorName:identity.claims.name||"",actorEmail:identity.claims.email||"",createdAt:F.serverTimestamp(),events};
      if(events.length>400||new Blob([JSON.stringify(history)]).size>700000)throw new Error("Há alterações demais para um único registro. Faça a mudança em etapas menores.");
      await F.runTransaction(db,async transaction=>{
        const current=await transaction.get(rootRef);
        if((current.exists()?current.data().revision:0)!==expectedRevision)throw conflict();
        const oldShelves=new Map(previous.shelves.map(shelf=>[shelf.id,shelf]));
        transaction.set(F.doc(db,"history",historyId),history);
        transaction.set(rootRef,{version:1,revision:expectedRevision+1,historyId,warehousePhoto:next.warehousePhoto,shelfIds:next.shelves.map(shelf=>shelf.id),updatedBy:uid,updatedAt:F.serverTimestamp()});
        for(const [ref,data] of pending)transaction.set(F.doc(db,"photos",ref.slice(6)),{data,updatedBy:uid,updatedAt:F.serverTimestamp()});
        for(const shelf of next.shelves){
          if(!current.exists()||!window.InventoryHistory.equal(oldShelves.get(shelf.id),shelf))transaction.set(F.doc(db,"warehouses/main/shelves",shelf.id),shelf);
          oldShelves.delete(shelf.id);
        }
        for(const id of oldShelves.keys())transaction.delete(F.doc(db,"warehouses/main/shelves",id));
        for(const ref of removed)transaction.delete(F.doc(db,"photos",ref.slice(6)));
      });
      const result={state:display,revision:expectedRevision+1,exists:true};
      if(!cache||cache.revision<=result.revision){
        cache=M.clone(result);storedState=M.clone(next);
        for(const [ref,data] of pending)photoCache.set(ref,data);
        for(const ref of removed)photoCache.delete(ref);
      }
      return result;
    }catch(error){
      if(error.code==="permission-denied")throw new Error("Não foi possível salvar. Confira sua autorização e publique as regras atualizadas de histórico no Firestore.");
      throw new Error(errorMessage(error));
    }finally{busy=false;}
  }
  // A base anterior só é lida; a publicação exige confirmação de um administrador.
  async function readLegacy() {
    if (!window.indexedDB) return null;
    return new Promise(resolve => {
      const request = indexedDB.open("almox-local");
      request.onupgradeneeded = () => { request.transaction.abort(); resolve(null); };
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const local = request.result;
        if (!local.objectStoreNames.contains("inventory")) { local.close(); resolve(null); return; }
        const read = local.transaction("inventory").objectStore("inventory").get("main");
        read.onsuccess = () => {
          local.close();
          try { resolve(read.result ? M.validateState(read.result.state) : null); } catch { resolve(null); }
        };
        read.onerror = () => { local.close(); resolve(null); };
      };
    });
  }
  async function getHistory(cursor=null) {
    if(!db)throw new Error("O histórico ainda não está disponível.");
    const clauses=[F.orderBy("revision","desc"),F.limit(50)];
    if(cursor)clauses.push(F.startAfter(cursor));
    const result=await F.getDocsFromServer(F.query(F.collection(db,"history"),...clauses));
    return {entries:result.docs.map(doc=>({...doc.data(),id:doc.id,createdAt:doc.data().createdAt.toDate().toISOString()})),cursor:result.docs.at(-1)||null,more:result.size===50};
  }
  window.AlmoxCloud = {configured, init, login, logout, saveState, readLegacy, errorMessage, getHistory, getPhoto:resolvePhoto};
})();

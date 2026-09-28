/* Somente testes: servido exclusivamente pelo servidor de tests/browser_check.py. */
(() => {
  let callbacks, record = JSON.parse(localStorage.getItem('almox-test-record') || 'null');
  if (!record) record = {state: Inventory.defaultState(), revision: 0, exists: false};
  let session = {user:{uid:'test-admin',displayName:'Administrador de teste',email:'admin@example.com'},admin:true,ready:true,configured:true};
  window.testCloud = {setSession(value) {session={...session,...value};callbacks.onSession(session);}, writes:0};
  window.AlmoxCloud = {
    configured:true,
    async init(options) {callbacks=options;callbacks.onState(Inventory.clone(record));callbacks.onSession(session);},
    async getHistory(cursor=0) {const entries=JSON.parse(localStorage.getItem('almox-test-history')||'[]').reverse();return {entries:entries.slice(cursor,cursor+50),cursor:cursor+50,more:entries.length>cursor+50};},
    async getPhoto(value) {return value;},
    async readLegacy() {return null;},
    async login() {testCloud.setSession({user:{uid:'viewer',displayName:'Visitante',email:'viewer@example.com'},admin:false});},
    async logout() {testCloud.setSession({user:null,admin:false});},
    errorMessage(error) {return error.message;},
    async saveState(state,revision) {
      if (!session.admin) throw Error('Somente administradores podem editar.');
      if (record.revision!==revision) throw Error('O estoque foi atualizado.');
      const entries=JSON.parse(localStorage.getItem('almox-test-history')||'[]');
      entries.push({id:String(revision+1),revision:revision+1,createdAt:new Date().toISOString(),actorName:session.user.displayName||'Teste',actorEmail:session.user.email||'',events:InventoryHistory.diff(record.state,state)});
      localStorage.setItem('almox-test-history',JSON.stringify(entries));
      record={state:Inventory.validateState(state),revision:revision+1,exists:true};
      localStorage.setItem('almox-test-record',JSON.stringify(record));testCloud.writes++;
      callbacks.onState(Inventory.clone(record));return Inventory.clone(record);
    }
  };
})();

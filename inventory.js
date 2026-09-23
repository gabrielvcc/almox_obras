/* Regras de estoque compartilhadas pela interface e pelos testes. */
(function (root) {
  "use strict";
  const ROWS = ["A", "B", "C", "D"];
  const UNITS = ["un", "sc", "cx", "kg", "m", "L", "pc"];
  const clone = value => JSON.parse(JSON.stringify(value));
  const uid = () => globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
  const pairStart = position => position % 2 ? position : position - 1;
  const at = (shelf, row, position) => shelf.items.find(item => item.row === row && position >= item.start && position < item.start + item.span);
  const used = shelf => shelf.items.reduce((sum, item) => sum + item.span, 0);
  const defaultState = () => ({version: 1, warehousePhoto: "", shelves: [{id: uid(), name: "Prateleira direita", zone: {x: 64, y: 20, w: 25, h: 60}, items: []}]});
  function ensure(condition, message) { if (!condition) throw new Error(message); }
  function bounded(value, max, label, required = false) {
    ensure(typeof value === "string" && value.length <= max, label + " inválido.");
    ensure(!required || value.trim().length > 0, label + " obrigatório.");
    return value.trim();
  }
  function photo(value) {
    ensure(typeof value === "string" && value.length <= 14000000, "Foto inválida ou muito grande.");
    ensure(!value || /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value), "Formato de foto inválido.");
    return value;
  }
  function validateZone(zone) {
    ensure(zone && ["x", "y", "w", "h"].every(key => Number.isFinite(zone[key])), "Área da prateleira inválida.");
    ensure(zone.x >= 0 && zone.y >= 0 && zone.w >= 5 && zone.h >= 5 && zone.x + zone.w <= 100 && zone.y + zone.h <= 100, "A área clicável precisa caber dentro da imagem.");
    return {x: zone.x, y: zone.y, w: zone.w, h: zone.h};
  }
  function placeItem(shelf, candidate) {
    ensure(ROWS.includes(candidate.row), "Andar inválido.");
    ensure(Number.isInteger(candidate.start) && candidate.start >= 1 && candidate.start <= 16, "Posição inválida.");
    ensure(candidate.span === 1 || candidate.span === 2, "Tamanho do item inválido.");
    ensure(candidate.span !== 2 || candidate.start % 2 === 1, "Um módulo inteiro deve começar na primeira posição do par.");
    const collision = shelf.items.some(item => item.id !== candidate.id && item.row === candidate.row && candidate.start < item.start + item.span && item.start < candidate.start + candidate.span);
    ensure(!collision, "A outra posição deste módulo já está ocupada. Escolha uma única posição ou libere o espaço.");
    return candidate;
  }
  function validateState(raw) {
    ensure(raw && raw.version === 1, "Este arquivo não é um backup compatível do Almox.");
    ensure(Array.isArray(raw.shelves) && raw.shelves.length >= 1 && raw.shelves.length <= 30, "O backup deve ter entre 1 e 30 prateleiras.");
    const ids = new Set();
    const state = {version: 1, warehousePhoto: photo(raw.warehousePhoto || ""), shelves: []};
    for (const original of raw.shelves) {
      ensure(original && typeof original === "object", "Prateleira inválida.");
      const shelf = {id: bounded(original.id, 100, "Identificador", true), name: bounded(original.name, 60, "Nome da prateleira", true), zone: validateZone(original.zone), items: []};
      ensure(!ids.has(shelf.id), "Há identificadores duplicados no backup."); ids.add(shelf.id);
      ensure(Array.isArray(original.items) && original.items.length <= 64, "Lista de itens inválida.");
      for (const value of original.items) {
        ensure(value && typeof value === "object", "Item inválido.");
        const item = {id: bounded(value.id, 100, "Identificador do item", true), row: value.row, start: value.start, span: value.span, name: bounded(value.name, 120, "Nome do item", true), quantity: value.quantity, unit: value.unit, asset: bounded(value.asset || "", 100, "Patrimônio"), notes: bounded(value.notes || "", 2000, "Observações"), photo: photo(value.photo || ""), updatedAt: bounded(value.updatedAt || "", 100, "Data")};
        ensure(!ids.has(item.id), "Há identificadores duplicados no backup."); ids.add(item.id);
        ensure(Number.isFinite(item.quantity) && item.quantity >= 0.001 && item.quantity <= 1000000000, "Quantidade inválida. Use um número entre 0,001 e 1 bilhão.");
        ensure(UNITS.includes(item.unit), "Unidade do item inválida.");
        placeItem(shelf, item); shelf.items.push(item);
      }
      state.shelves.push(shelf);
    }
    return state;
  }
  function catalog(state) {
    const groups = new Map();
    for (const shelf of state.shelves) {
      for (const item of shelf.items) {
        // O patrimônio identifica cada registro; a unidade faz parte do agrupamento.
        const nameKey = item.name.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");
        const key = JSON.stringify([nameKey, item.unit]);
        if (!groups.has(key)) groups.set(key, {name: item.name.trim(), unit: item.unit, total: 0, photo: "", locations: []});
        const group = groups.get(key);
        group.total += item.quantity;
        if (!group.photo && item.photo) group.photo = item.photo;
        group.locations.push({shelfId: shelf.id, shelfName: shelf.name, itemId: item.id, row: item.row, start: item.start, span: item.span, quantity: item.quantity, asset: item.asset});
      }
    }
    return [...groups.values()].map(group => {
      group.total = Number(group.total.toPrecision(15));
      group.locations.sort((a, b) => a.shelfName.localeCompare(b.shelfName, "pt-BR") || a.row.localeCompare(b.row) || a.start - b.start);
      return group;
    }).sort((a, b) => a.name.localeCompare(b.name, "pt-BR") || a.unit.localeCompare(b.unit));
  }
  const api = {ROWS, UNITS, clone, uid, pairStart, at, used, defaultState, validateZone, placeItem, validateState, catalog};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Inventory = api;
})(globalThis);

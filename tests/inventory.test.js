"use strict";
const test = (name, run) => { run(); console.log("OK: " + name); };
const assert = require("node:assert/strict");
const M = require("../inventory.js");
const item = (values = {}) => ({id: "item-1", row: "A", start: 1, span: 1, name: "Cimento CP-2", quantity: 5, unit: "sc", asset: "PAT-001", notes: "", photo: "", updatedAt: "2026-09-23", ...values});
test("uma prateleira começa com 64 posições livres", () => {
  const state = M.defaultState();
  assert.equal(M.used(state.shelves[0]), 0);
  for (const row of M.ROWS) for (let position = 1; position <= 16; position++) assert.equal(M.at(state.shelves[0], row, position), undefined);
});
test("item grande reserva o par e ambas as posições apontam ao mesmo cadastro", () => {
  const shelf = M.defaultState().shelves[0];
  const value = item({start: 15, span: 2}); M.placeItem(shelf, value); shelf.items.push(value);
  assert.equal(M.at(shelf, "A", 15), value); assert.equal(M.at(shelf, "A", 16), value); assert.equal(M.used(shelf), 2);
  assert.equal(M.pairStart(16), 15);
});
test("não permite sobreposição, inclusive ao ampliar um item existente", () => {
  const shelf = M.defaultState().shelves[0];
  shelf.items.push(item(), item({id: "item-2", start: 2}));
  assert.throws(() => M.placeItem(shelf, item({span: 2})), /ocupada/);
  assert.throws(() => M.placeItem(shelf, item({id: "item-3"})), /ocupada/);
  assert.doesNotThrow(() => M.placeItem(shelf, item({name: "Novo nome"})));
});
test("módulos inteiros não atravessam pares nem saem da prateleira", () => {
  const shelf = M.defaultState().shelves[0];
  assert.throws(() => M.placeItem(shelf, item({start: 2, span: 2})), /primeira/);
  assert.throws(() => M.placeItem(shelf, item({start: 17})), /Posição/);
  assert.throws(() => M.placeItem(shelf, item({row: "E"})), /Andar/);
});
test("backup conserva prateleiras, fotos, campos e posições ocupadas", () => {
  const state = M.defaultState();
  const photo = "data:image/png;base64,aGVsbG8=";
  state.shelves[0].items.push(item({photo, span: 2}));
  state.warehousePhoto = photo;
  const restored = M.validateState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored, state);
});
test("backup inválido não pode substituir o estoque", () => {
  const state = M.defaultState(); state.shelves[0].items.push(item(), item({id: "item-2"}));
  assert.throws(() => M.validateState(state), /ocupada/);
  for (const quantity of [0, -1, "5", Infinity, 1e10]) {
    const next = M.defaultState(); next.shelves[0].items.push(item({quantity}));
    assert.throws(() => M.validateState(next), /Quantidade/);
  }
  assert.throws(() => M.validateState({version: 2}), /compatível/);
  assert.throws(() => M.validateState({...M.defaultState(), warehousePhoto: "https://example.com/photo.png"}), /Formato/);
  assert.throws(() => M.validateZone({x: 90, y: 0, w: 20, h: 10}), /caber/);
});
test("reduzir ou excluir item libera somente as posições correspondentes", () => {
  const shelf = M.defaultState().shelves[0];
  shelf.items.push(item({span: 2}), item({id: "item-2", row: "B", start: 16}));
  shelf.items[0].span = 1;
  assert.equal(M.at(shelf, "A", 2), undefined); assert.equal(M.used(shelf), 2);
  shelf.items = shelf.items.filter(value => value.id !== "item-1");
  assert.equal(M.at(shelf, "A", 1), undefined); assert.equal(M.used(shelf), 1);
});



test("itens iguais somam quantidades entre posições e prateleiras sem perder patrimônios", () => {
  const state = M.defaultState();
  state.shelves[0].items.push(item({name: "Cone", start: 2, quantity: 5, unit: "un", asset: "P-01"}));
  state.shelves.push({id: "shelf-2", name: "Prateleira esquerda", items: [item({id: "item-2", name: " cone ", row: "C", start: 8, quantity: 8, unit: "un", asset: "P-02"})]});
  const before = JSON.stringify(state);
  const groups = M.catalog(state);
  assert.equal(groups.length, 1); assert.equal(groups[0].total, 13);
  assert.equal(groups[0].locations.length, 2);
  assert.deepEqual(new Set(groups[0].locations.map(location => location.asset)), new Set(["P-01", "P-02"]));
  assert.deepEqual(new Set(groups[0].locations.map(location => location.row + location.start)), new Set(["A2", "C8"]));
  assert.equal(JSON.stringify(state), before);
});
test("unidades e modelos diferentes permanecem separados; módulo inteiro não duplica quantidade", () => {
  const state = M.defaultState();
  state.shelves[0].items.push(item({id: "1", name: "Cone", unit: "un", quantity: 5, span: 2}), item({id: "2", name: "Cone", unit: "cx", start: 3, quantity: 2}), item({id: "3", name: "Cone 75 cm", unit: "un", start: 4}));
  const groups = M.catalog(state);
  assert.equal(groups.length, 3);
  assert.equal(groups.find(group => group.name === "Cone" && group.unit === "un").total, 5);
});
test("totais fracionários e agrupamento refletem edições e exclusões", () => {
  const state = M.defaultState();
  const shelf = state.shelves[0];
  shelf.items.push(item({quantity: 0.1}), item({id: "2", start: 2, quantity: 0.2}));
  assert.equal(M.catalog(state)[0].total, 0.3);
  shelf.items[1].name = "Outro material";
  assert.equal(M.catalog(state).length, 2);
  shelf.items.pop();
  assert.equal(M.catalog(state)[0].total, 0.1);
});


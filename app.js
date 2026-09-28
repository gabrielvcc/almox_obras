/* Almox: consulta pública; edição autorizada pelo Firebase. */
(() => {
  "use strict";
  const M = window.Inventory;
  const P = window.WarehousePlan;
  let layoutDraft = null, layoutRevision = 0, planZoom = 1, planSelected = null, planSaving = false;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const esc = value => String(value).replace(/[&<>"']/g, character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[character]));
  const icon = name => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  let state, revision = 0, activeShelf, view = "shelf", filter = "all", shelfFilter = "all";
  let itemContext = null, shelfContext = null, pendingPhoto = "", photoLoading = false, photoSequence = 0, toastTimer, saving = false;

  function toast(message, error = false) {
    const element = $("#toast");
    element.textContent = message; element.classList.toggle("error", error); element.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { element.hidden = true; }, error ? 8000 : 4500);
  }
  function confirmAction(title, message, label = "Confirmar") {
    const dialog = $("#confirm-dialog");
    $("#confirm-title").textContent = title;
    $("#confirm-message").textContent = message;
    $("#confirm-accept").textContent = label;
    dialog.returnValue = "";
    return new Promise(resolve => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "accept"), {once: true});
      dialog.showModal();
    });
  }
  const cloud = window.AlmoxCloud;
  let session = {user: null, admin: false, ready: false, configured: cloud.configured};
  let cloudExists = false, legacyStock = null, shelfRevision = 0;
  function canEdit() { return session.admin && session.ready && navigator.onLine; }
  function requireEditor() {
    if (!canEdit()) throw new Error("Somente administradores conectados podem editar o estoque.");
  }
  function renderAccess() {
    document.body.classList.toggle("can-edit", canEdit());
    $("#account-button").textContent = session.user ? "Minha conta" : "Entrar";
    $("#account-login").hidden = !!session.user;
    $("#account-profile").hidden = !session.user;
    $("#google-login").disabled = !session.configured;
    $("#account-name").textContent = session.user?.displayName || "Sua conta";
    $("#account-email").textContent = session.user?.email || "";
    $("#account-role").textContent = session.admin ? "Administrador" : "Somente visualização";
    $("#account-uid").value = session.user?.uid || "";
    $("#legacy-import").hidden = !(canEdit() && !cloudExists && legacyStock);
  }
  async function commit(next, message, expectedRevision = revision) {
    requireEditor();
    if (saving) throw new Error("Aguarde o salvamento em andamento.");
    const validated = M.validateState(next);
    saving = true;
    try {
      const result = await cloud.saveState(validated, expectedRevision);
      if (result.revision >= revision) { state = result.state; revision = result.revision; cloudExists = true; }
      if (!state.shelves.some(shelf => shelf.id === activeShelf)) activeShelf = state.shelves[0].id;
      render();
      if (message) toast(message);
    } finally { saving = false; }
  }
  function shelfIn(next, id) { return next.shelves.find(shelf => shelf.id === id); }
  function selectedShelves() {
    return shelfFilter === "all" ? state.shelves : state.shelves.filter(shelf => shelf.id === shelfFilter);
  }
  function showShelf(id = "all") {
    shelfFilter = id;
    if (id !== "all") activeShelf = id;
    view = "shelf"; $("#search").value = ""; filter = "all"; render();
  }
  function render() {
    if (shelfFilter !== "all" && !state.shelves.some(shelf => shelf.id === shelfFilter)) shelfFilter = "all";
    $("#shelf-view").hidden = view !== "shelf"; $("#warehouse-view").hidden = view !== "warehouse"; $("#items-view").hidden = view !== "items";
    for (const [id, page] of [["items-nav", "items"], ["warehouse-nav", "warehouse"], ["shelves-nav", "shelf"]]) {
      $("#" + id).classList.toggle("active", view === page);
      $("#" + id).setAttribute("aria-current", view === page ? "page" : "false");
    }
    const title = view === "items" ? "Itens" : view === "warehouse" ? "Meu galpão" : "Prateleiras";
    $("#breadcrumb-current").textContent = title; $("#shelf-title").textContent = "Prateleiras";
    document.title = title + " · Almox";
    $("#shelf-nav").innerHTML = '<button id="warehouse-mobile" class="nav-button" style="display:none" title="Visão do galpão" aria-label="Visão do galpão">' + icon("grid") + '</button><button id="items-mobile" class="nav-button ' + (view === "items" ? "active" : "") + '">' + icon("box") + 'Itens</button><button id="shelves-mobile" class="nav-button ' + (view === "shelf" ? "active" : "") + '">' + icon("shelf") + 'Prateleiras</button>';
    $("#warehouse-mobile").onclick = showWarehouse; $("#items-mobile").onclick = showItems;
    $("#shelves-mobile").onclick = () => showShelf();
    $("#item-names").innerHTML = [...new Set(state.shelves.flatMap(shelf => shelf.items.map(item => item.name)))].map(name => '<option value="' + esc(name) + '"></option>').join("");
    $("#shelf-filter").innerHTML = '<option value="all">Todas</option>' + state.shelves.map(shelf => '<option value="' + esc(shelf.id) + '">' + esc(shelf.name) + '</option>').join("");
    $("#shelf-filter").value = shelfFilter;
    const shelves = selectedShelves(), occupied = shelves.reduce((sum, shelf) => sum + M.used(shelf), 0), capacity = shelves.length * M.CAPACITY;
    $("#occupied-count").textContent = occupied; $("#available-count").textContent = capacity - occupied;
    $("#total-capacity").textContent = "/ " + capacity;
    $("#item-count").textContent = shelves.reduce((sum, shelf) => sum + shelf.items.length, 0);
    $("#occupancy-percent").textContent = Math.round(occupied / capacity * 100) + "%";
    $("#capacity-label").textContent = occupied + " de " + capacity; $("#capacity-bar").style.width = occupied / capacity * 100 + "%";
    $("#shelf-range").textContent = shelves.length > 1 ? shelves.length + " prateleiras · deslize para ver todas" : "Posições " + M.positionNumber(state, shelves[0].id, 1) + " a " + M.positionNumber(state, shelves[0].id, M.POSITIONS);
    renderMap(); if (view === "warehouse") renderWarehouse(); if (view === "items") renderCatalog(); renderAccess();
  }
  function normalized(value) { return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim(); }
  function renderMap() {
    const query = normalized($("#search").value);
    let matches = 0;
    $("#rack").innerHTML = selectedShelves().map(shelf => {
      const offset = M.positionNumber(state, shelf.id, 1) - 1;
      const headings = '<div class="module-headings"><span>ANDAR</span>' + Array.from({length: M.MODULES}, (_, index) => '<span>MÓDULO ' + String(offset / 2 + index + 1).padStart(2, "0") + '</span>').join("") + '</div>';
      const floors = M.ROWS.map((row, rowIndex) => {
        let modules = "";
        for (let moduleIndex = 0; moduleIndex < M.MODULES; moduleIndex++) {
          let slots = "";
          const first = moduleIndex * 2 + 1;
          for (let position = first; position <= first + 1; position++) {
            const item = M.at(shelf, row, position);
            if (item?.span === 2 && item.start !== position) continue;
            const full = item?.span === 2, codes = M.positionLabel(state, shelf.id, row, position, full ? 2 : 1);
            const searchText = normalized([codes, shelf.name, item?.name || "", item?.asset || "", item?.notes || ""].join(" "));
            const visible = (!query || searchText.includes(query)) && (filter === "all" || (filter === "occupied" ? !!item : !item));
            if (visible) matches += full ? 2 : 1;
            const label = item ? codes + ": " + item.name + ", " + item.quantity + " " + item.unit + ". Clique para consultar." : codes + (canEdit() ? ": livre. Clique para cadastrar." : ": livre.");
            slots += '<button class="slot ' + (item ? "occupied " : "") + (full ? "full " : "") + (!visible ? "dimmed " : query ? "matched " : "") + '" data-shelf-id="' + esc(shelf.id) + '" data-row="' + row + '" data-position="' + position + '" title="' + esc(label) + '" aria-label="' + esc(label) + '"><span class="slot-code">' + codes + '</span><span class="slot-bottom">' + (full ? esc(item.name) : item ? '<svg class="mini-icon" aria-hidden="true"><use href="#i-box"/></svg>' : "+") + '</span></button>';
          }
          modules += '<div class="module" aria-label="Módulo ' + (offset / 2 + moduleIndex + 1) + '">' + slots + "</div>";
        }
        return '<div class="rack-floor"><div class="floor-label"><strong>' + row + "</strong><small>" + (4 - rowIndex) + "º andar</small></div>" + modules + "</div>";
      }).join("");
      return '<article class="shelf-board" data-board="' + esc(shelf.id) + '" aria-label="' + esc(shelf.name) + '"><header class="shelf-board-heading"><div><h3>' + esc(shelf.name) + '</h3><p>Posições ' + (offset + 1) + '–' + (offset + M.POSITIONS) + '</p></div><button class="button secondary shelf-edit" data-admin data-edit-shelf="' + esc(shelf.id) + '">' + icon("edit") + 'Editar prateleira</button></header>' + headings + floors + '<div class="rack-base"><span></span><span></span></div></article>';
    }).join("");
    $$(".segmented button").forEach(button => { button.classList.toggle("selected", button.dataset.filter === filter); button.setAttribute("aria-pressed", button.dataset.filter === filter); });
    $("#search-feedback").textContent = query || filter !== "all" ? (matches ? matches + " posições correspondem à busca. As demais aparecem esmaecidas." : "Nenhuma posição corresponde à busca. Tente outro termo ou filtro.") : "";
  }
  function showItems() { view = "items"; render(); }
  function renderCatalog() {
    const groups = M.catalog(state), query = normalized($("#catalog-search").value);
    const position = location => M.positionLabel(state, location.shelfId, location.row, location.start, location.span);
    const visible = groups.filter(group => normalized([group.name, ...group.locations.map(location => [location.shelfName, location.asset, position(location)].join(" "))].join(" ")).includes(query));
    const number = value => new Intl.NumberFormat("pt-BR", {maximumFractionDigits: 10}).format(value);
    const quantity = (value, unit) => number(value) + " " + (unit === "pc" ? "pç" : unit);
    $("#catalog-count").textContent = groups.length + (groups.length === 1 ? " tipo de item" : " tipos de itens");
    $("#catalog-result").textContent = query ? visible.length + (visible.length === 1 ? " resultado" : " resultados") : "Todas as prateleiras";
    $("#catalog-list").innerHTML = visible.length ? visible.map(group =>
      '<details class="item-group" open><summary><span class="catalog-photo">' + (group.photo ? '<img src="' + esc(group.photo) + '" alt="" loading="lazy">' : icon("box")) + '</span><span class="catalog-name"><strong>' + esc(group.name) + '</strong><small>' + group.locations.length + (group.locations.length === 1 ? " localização" : " localizações") + '</small></span><span class="catalog-total"><strong>' + quantity(group.total, group.unit) + '</strong><small>no total</small></span>' + icon("arrow") + '</summary><div class="catalog-locations"><div class="location-columns" aria-hidden="true"><span>Localização</span><span>Quantidade</span><span>Patrimônio</span><span></span></div><ul>' +
      group.locations.map(location => '<li><div class="catalog-place"><span class="position-badge">' + position(location) + '</span><span>' + esc(location.shelfName) + '</span></div><div class="catalog-quantity"><small>Quantidade</small><strong>' + quantity(location.quantity, group.unit) + '</strong></div><div class="catalog-asset"><small>Patrimônio</small><span>' + esc(location.asset || "Não informado") + '</span></div><button class="button secondary location-open" data-catalog-shelf="' + esc(location.shelfId) + '" data-row="' + location.row + '" data-position="' + location.start + '" aria-label="Ver ' + esc(group.name) + ' em ' + esc(location.shelfName) + ', ' + position(location) + '">Ver posição' + icon("arrow") + '</button></li>').join("") +
      '</ul></div></details>').join("") :
      '<div class="catalog-empty">' + icon("box") + '<h2>' + (groups.length ? "Nenhum item encontrado" : "Seus itens aparecem aqui") + '</h2><p>' + (groups.length ? "Tente outro nome, patrimônio ou posição." : (canEdit() ? "Cadastre um item em uma posição da prateleira para começar." : "Ainda não há itens cadastrados.")) + '</p></div>';
  }
  function showWarehouse() { view = "warehouse"; render(); }
  function renderWarehouse() {
    const hasPhoto = !!state.warehousePhoto;
    $("#warehouse-image").hidden = !hasPhoto;
    if (hasPhoto) $("#warehouse-image").src = state.warehousePhoto; else $("#warehouse-image").removeAttribute("src");
    $("#warehouse-illustration").hidden = hasPhoto;
    $("#remove-warehouse-photo").hidden = !hasPhoto;
    $("#change-photo").innerHTML = icon("photo") + (hasPhoto ? "Trocar foto" : "Usar foto do galpão");
    $("#warehouse-scroll").classList.toggle("is-plan", !hasPhoto);
    if (hasPhoto) {
      $("#hotspots").innerHTML = state.shelves.map(shelf => '<button class="hotspot" data-shelf="' + esc(shelf.id) + '" style="left:' + shelf.zone.x + "%;top:" + shelf.zone.y + "%;width:" + shelf.zone.w + "%;height:" + shelf.zone.h + '%" aria-label="Abrir ' + esc(shelf.name) + '"><strong>' + esc(shelf.name) + '</strong><small>' + shelf.items.length + " itens · " + (M.CAPACITY - M.used(shelf)) + " livres</small></button>").join("");
    } else {
      $("#hotspots").innerHTML = "";
      $("#warehouse-illustration").innerHTML = P.draw(layoutDraft || state.shelves, {editing:!!layoutDraft,selected:planSelected});
    }
    $("#hotspots").hidden = !hasPhoto;
    $("#warehouse-stage").classList.toggle("editing-plan", !!layoutDraft);
    $("#warehouse-stage").style.width = hasPhoto ? "" : (planZoom * 100) + "%";
    $("#plan-edit").hidden = hasPhoto || !!layoutDraft;
    $("#plan-save").hidden = $("#plan-cancel").hidden = !layoutDraft;
    $("#plan-save").disabled = $("#plan-cancel").disabled = planSaving;
    $("#warehouse-add").disabled = $("#change-photo").disabled = !!layoutDraft;
    for (const id of ["plan-zoom-in","plan-zoom-out","plan-zoom-reset"]) $("#"+id).hidden = hasPhoto;
    $("#plan-instructions").textContent = layoutDraft ? "Arraste as prateleiras ou selecione uma e use as setas. Salve para confirmar." : "Clique em uma prateleira para consultar. Os módulos indicam a ocupação geral de cada prateleira.";
    $("#warehouse-cards").innerHTML = state.shelves.map(shelf => '<button class="warehouse-card" data-shelf="' + esc(shelf.id) + '">' + icon("shelf") + "<span><strong>" + esc(shelf.name) + "</strong><small>" + M.used(shelf) + " de " + M.CAPACITY + " posições ocupadas</small></span>" + icon("arrow") + "</button>").join("");
  }
  function setPhotoPreview() {
    const preview = $("#item-photo-preview");
    preview.hidden = !pendingPhoto; $("#photo-placeholder").hidden = !!pendingPhoto;
    $("#remove-item-photo").hidden = !pendingPhoto;
    if (pendingPhoto) preview.src = pendingPhoto; else preview.removeAttribute("src");
  }
  function openItem(row, position, shelfId = activeShelf) {
    const shelf = shelfIn(state, shelfId), item = M.at(shelf, row, position);
    const editable = canEdit();
    const selected = item ? item.start : position;
    const first = M.pairStart(selected);
    const code = value => M.positionLabel(state, shelf.id, row, value);
    itemContext = {shelfId: shelf.id, row, position: selected, itemId: item?.id || null, revision};
    photoSequence++; photoLoading = false; $("#save-item").disabled = false;
    $("#item-form").reset(); $("#item-error").textContent = "";
    $("#item-location").textContent = shelf.name + " · ANDAR " + row;
    $("#item-dialog-title").textContent = "Posição " + M.positionLabel(state, shelf.id, row, selected, item?.span || 1);
    $("#position-description").textContent = "Módulo " + String(Math.ceil(M.positionNumber(state, shelf.id, selected) / 2)).padStart(2, "0") + " · posições " + code(first) + " e " + code(first + 1);
    $("#position-status").textContent = item ? "Item cadastrado · edite os dados ou libere o espaço" : "Espaço livre para um novo item";
    $("#item-name").value = item?.name || ""; $("#item-quantity").value = item?.quantity ?? 1;
    $("#item-unit").value = item?.unit || "un"; $("#item-asset").value = item?.asset || ""; $("#item-notes").value = item?.notes || "";
    const blocked = [first, first + 1].some(slot => { const other = M.at(shelf, row, slot); return other && other.id !== item?.id; });
    const fullRadio = $('input[name="span"][value="2"]');
    fullRadio.disabled = blocked || !editable; fullRadio.checked = item?.span === 2;
    $('input[name="span"][value="1"]').checked = item?.span !== 2;
    $("#full-module-label").textContent = "Ocupa " + code(first) + " + " + code(first + 1);
    $("#span-help").textContent = blocked ? "A outra posição está ocupada. O módulo inteiro não está disponível." : item?.span === 2 ? "Ao reduzir para uma posição, o item permanece em " + code(first) + "." : "O módulo inteiro reserva as duas posições deste par.";
    $("#delete-item").hidden = !item;
    $("#item-dialog").classList.toggle("is-readonly", !editable);
    $$("#item-form input, #item-form select, #item-form textarea").forEach(input => { input.disabled = !editable; });
    fullRadio.disabled = blocked || !editable;
    $("#item-dismiss").textContent = editable ? "Cancelar" : "Fechar";
    if (!editable) {
      $("#position-status").textContent = item ? "Dados do item" : "Esta posição está livre.";
      $("#span-help").textContent = "";
      if (!item) $("#item-quantity").value = "";
    }
    pendingPhoto = item?.photo || ""; setPhotoPreview();
    $("#item-dialog").showModal();
  }
  async function saveItem(event) {
    event.preventDefault();
    if (photoLoading) { $("#item-error").textContent = "Aguarde a foto terminar de carregar."; return; }
    const context = itemContext;
    $("#save-item").disabled = true;
    try {
      requireEditor();
      const next = M.clone(state), shelf = shelfIn(next, context.shelfId);
      if (!shelf) throw new Error("Prateleira não encontrada.");
      const span = Number($('input[name="span"]:checked').value);
      const candidate = {id: context.itemId || M.uid(), row: context.row, start: span === 2 ? M.pairStart(context.position) : context.position, span, name: $("#item-name").value.trim(), quantity: Number($("#item-quantity").value), unit: $("#item-unit").value, asset: $("#item-asset").value.trim(), notes: $("#item-notes").value.trim(), photo: pendingPhoto, updatedAt: new Date().toISOString()};
      M.placeItem(shelf, candidate);
      shelf.items = shelf.items.filter(item => item.id !== candidate.id); shelf.items.push(candidate);
      await commit(next, "Item salvo. Cada coisa em seu lugar.", context.revision);
      $("#item-dialog").close();
    } catch (error) { $("#item-error").textContent = error.message; }
    finally { $("#save-item").disabled = false; }
  }
  async function deleteItem() {
    if (!canEdit()) return toast("Você não tem permissão para editar.", true);
    const context = itemContext, item = shelfIn(state, context.shelfId)?.items.find(value => value.id === context.itemId);
    if (!item || !await confirmAction("Liberar esta posição?", 'O cadastro de "' + item.name + '" será removido, incluindo a foto. O espaço ficará disponível.', "Liberar posição")) return;
    try {
      requireEditor();
      const next = M.clone(state), shelf = shelfIn(next, context.shelfId);
      shelf.items = shelf.items.filter(value => value.id !== context.itemId);
      await commit(next, "Posição liberada.", context.revision); $("#item-dialog").close();
    } catch (error) { $("#item-error").textContent = error.message; }
  }
  function openShelf(edit = false, planSide = null, shelfId = activeShelf) {
    if (!canEdit()) return;
    if (layoutDraft) return toast("Salve ou cancele a organização da planta primeiro.");
    shelfRevision = revision;
    if (!edit && state.shelves.length >= 30) { toast("Esta versão permite até 30 prateleiras por galpão.", true); return; }
    const shelf = edit ? shelfIn(state, shelfId) : null;
    shelfContext = shelf?.id || null;
    $("#shelf-form").reset(); $("#shelf-error").textContent = "";
    $("#shelf-dialog-title").textContent = edit ? "Editar prateleira" : "Nova prateleira";
    $("#shelf-name").value = shelf?.name || (planSide ? "Prateleira " + planSide : "");
    const index = state.shelves.length;
    const zone = shelf?.zone || (!state.warehousePhoto ? P.nextZone(state.shelves) : planSide ? {x: 25, y: planSide === "esquerda" ? 36 : 58, w: 50, h: 5} : {x: 6 + index % 3 * 30, y: 15 + Math.floor(index / 3) % 2 * 35, w: 25, h: 30});
    ["x", "y", "w", "h"].forEach(key => { $("#zone-" + key).value = zone[key]; });
    $("#delete-shelf").hidden = !edit; $("#delete-shelf").disabled = state.shelves.length === 1;
    $("#delete-shelf").title = state.shelves.length === 1 ? "Mantenha ao menos uma prateleira no galpão." : "";
    updateZonePreview(); $("#shelf-dialog").showModal();
  }
  function getZone() { return Object.fromEntries(["x", "y", "w", "h"].map(key => [key, Number($("#zone-" + key).value)])); }
  function updateZonePreview() {
    const zone = getZone();
    $("#zone-preview").classList.toggle("vector-preview", !state.warehousePhoto);
    if (!state.warehousePhoto) {
      const selected = shelfContext || "draft-shelf";
      const shelves = M.clone(state.shelves);
      const safe = {...zone,w:Math.max(5,Math.min(100,zone.w||5)),h:Math.max(5,Math.min(100,zone.h||5))};
      const draft = {id:selected,name:$("#shelf-name").value || "Nova prateleira",zone:P.move(safe,zone.x||0,zone.y||0),items:shelfIn(state,selected)?.items || []};
      const index = shelves.findIndex(s => s.id === selected);
      if (index < 0) shelves.push(draft); else shelves[index] = draft;
      $("#zone-preview").style.backgroundImage = "none";
      $("#zone-preview").innerHTML = P.draw(shelves,{editing:true,selected,preview:true});
    } else {
      $("#zone-preview").innerHTML = '<div id="zone-preview-box"></div>';
      const box = $("#zone-preview-box");
      Object.assign(box.style,{left:zone.x+"%",top:zone.y+"%",width:zone.w+"%",height:zone.h+"%"});
      box.textContent = $("#shelf-name").value || "Prateleira";
      $("#zone-preview").style.backgroundImage = 'url("' + state.warehousePhoto + '")';
    }
  }
  async function saveShelf(event) {
    event.preventDefault();
    const submit = event.submitter; submit.disabled = true;
    try {
      requireEditor();
      const next = M.clone(state), name = $("#shelf-name").value.trim(), zone = M.validateZone(getZone());
      if (!name) throw new Error("Informe o nome da prateleira.");
      if (next.shelves.some(shelf => shelf.id !== shelfContext && normalized(shelf.name) === normalized(name))) throw new Error("Já existe uma prateleira com esse nome.");
      let id = shelfContext;
      if (id) Object.assign(shelfIn(next, id), {name, zone});
      else { id = M.uid(); next.shelves.push({id, name, zone, items: []}); }
      await commit(next, shelfContext ? "Prateleira atualizada." : "Nova prateleira criada.", shelfRevision);
      $("#shelf-dialog").close();
    } catch (error) { $("#shelf-error").textContent = error.message; }
    finally { submit.disabled = false; }
  }
  async function deleteShelf() {
    if (!canEdit()) return toast("Você não tem permissão para editar.", true);
    const shelf = shelfIn(state, shelfContext);
    if (!shelf || state.shelves.length === 1) return;
    if (!await confirmAction("Excluir prateleira?", '"' + shelf.name + '" e seus ' + shelf.items.length + " itens serão removidos.", "Excluir prateleira")) return;
    try {
      const next = M.clone(state); next.shelves = next.shelves.filter(value => value.id !== shelf.id);
      await commit(next, "Prateleira excluída.", shelfRevision); $("#shelf-dialog").close();
    } catch (error) { $("#shelf-error").textContent = error.message; }
  }
  function readImage(file) { return window.AlmoxPhotos.fromFile(file); }
  async function onItemPhoto(event) {
    if (!canEdit()) return;
    const file = event.target.files[0]; if (!file) return;
    const sequence = ++photoSequence; photoLoading = true; $("#save-item").disabled = true; $("#item-error").textContent = "";
    try { const result = await readImage(file); if (sequence === photoSequence) { pendingPhoto = result; setPhotoPreview(); } }
    catch (error) { if (sequence === photoSequence) $("#item-error").textContent = error.message; }
    finally { if (sequence === photoSequence) { photoLoading = false; $("#save-item").disabled = false; event.target.value = ""; } }
  }
  async function onWarehousePhoto(event) {
    if (!canEdit()) return;
    const file = event.target.files[0]; if (!file) return;
    $("#change-photo").disabled = true;
    try { const photo = await readImage(file); const next = M.clone(state); next.warehousePhoto = photo; await commit(next, "Foto do galpão atualizada. Ajuste as áreas em Editar prateleira."); }
    catch (error) { toast(error.message, true); }
    finally { event.target.value = ""; $("#change-photo").disabled = false; }
  }
  function bindEvents() {
    $(".brand").onclick = event => { event.preventDefault(); showWarehouse(); };
    $("#warehouse-nav").onclick = showWarehouse;
    $("#items-nav").onclick = showItems;
    $("#catalog-search").oninput = renderCatalog;
    $("#catalog-list").addEventListener("click", event => {
      const button = event.target.closest("[data-catalog-shelf]");
      if (button) { showShelf(button.dataset.catalogShelf); openItem(button.dataset.row, Number(button.dataset.position)); }
    });
    $("#add-shelf").onclick = () => openShelf();
    $("#warehouse-add").onclick = () => openShelf();
    $("#shelves-nav").onclick = () => showShelf();
    $("#shelf-filter").onchange = event => {
      shelfFilter = event.target.value;
      if (shelfFilter !== "all") activeShelf = shelfFilter;
      render(); $(".shelves-scroll").scrollLeft = 0;
    };
    ["#shelf-nav", "#hotspots", "#warehouse-cards"].forEach(selector => $(selector).addEventListener("click", event => { const button = event.target.closest("[data-shelf]"); if (button) showShelf(button.dataset.shelf); }));
    $("#hotspots").addEventListener("click", event => {
      const button = event.target.closest("[data-plan-add]");
      if (button) openShelf(false, button.dataset.planAdd);
    });
    $("#rack").onclick = event => { const button = event.target.closest("[data-position]"); if (button) openItem(button.dataset.row, Number(button.dataset.position), button.dataset.shelfId); };
    $("#rack").addEventListener("click", event => {
      const button = event.target.closest("[data-edit-shelf]");
      if (button) openShelf(true, null, button.dataset.editShelf);
    });
    $("#search").oninput = renderMap;
    $$(".segmented button").forEach(button => { button.onclick = () => { filter = button.dataset.filter; renderMap(); }; });
    $$("[data-close]").forEach(button => { button.onclick = () => $("#" + button.dataset.close).close(); });
    $("#item-dialog").addEventListener("close", () => { photoSequence++; photoLoading = false; });
    $("#item-form").onsubmit = saveItem; $("#delete-item").onclick = deleteItem; $("#item-photo").onchange = onItemPhoto;
    $("#remove-item-photo").onclick = () => { if (!canEdit()) return; photoSequence++; photoLoading = false; $("#save-item").disabled = false; pendingPhoto = ""; $("#item-photo").value = ""; setPhotoPreview(); };
    $("#shelf-form").onsubmit = saveShelf; $("#delete-shelf").onclick = deleteShelf;
    ["x", "y", "w", "h"].forEach(key => { $("#zone-" + key).oninput = updateZonePreview; }); $("#shelf-name").oninput = updateZonePreview;
    $("#change-photo").onclick = () => $("#warehouse-photo-input").click();
    $("#warehouse-photo-input").onchange = onWarehousePhoto;
    $("#remove-warehouse-photo").onclick = async () => {
      if (!canEdit()) return;
      const expectedRevision = revision;
      if (!await confirmAction("Remover foto do galpão?", "A ilustração inicial voltará a aparecer. As prateleiras e seus itens serão mantidos.", "Remover foto")) return;
      try { const next = M.clone(state); next.warehousePhoto = ""; await commit(next, "Ilustração restaurada.", expectedRevision); } catch (error) { toast(error.message, true); }
    };
    bindAccount();
    bindPlan();
  }
  function bindPlan() {
    $("#plan-edit").onclick = () => {
      if (!canEdit()) return;
      layoutDraft = M.clone(state.shelves); layoutRevision = revision; planSelected = null; renderWarehouse();
    };
    $("#plan-cancel").onclick = () => { if(planSaving)return; layoutDraft=null;planSelected=null;renderWarehouse(); };
    $("#plan-save").onclick = async () => {
      if (!canEdit() || !layoutDraft || planSaving) return;
      planSaving=true;renderWarehouse();
      try {
        const next=M.clone(state);
        for(const shelf of next.shelves) {
          const draft=layoutDraft.find(s=>s.id===shelf.id);
          if(draft) shelf.zone=M.validateZone(draft.zone);
        }
        await commit(next,"Disposição do galpão salva.",layoutRevision);
        layoutDraft=null;planSelected=null;
      } catch(error) { toast(error.message,true); }
      finally { planSaving=false;renderWarehouse(); }
    };
    for (const [id,delta] of [["plan-zoom-in",.25],["plan-zoom-out",-.25],["plan-zoom-reset",0]]) {
      $("#"+id).onclick=()=>{planZoom=delta?Math.max(1,Math.min(3,planZoom+delta)):1;renderWarehouse();};
    }
    $("#warehouse-illustration").onclick=event=>{
      const rack=event.target.closest('[data-plan-id]');
      if(rack&&!layoutDraft)showShelf(rack.dataset.planId);
    };
    function attach(container, preview) {
      let drag=null;
      const editable=()=>canEdit()&&!planSaving&&(preview?!state.warehousePhoto:!!layoutDraft);
      const selectedId=()=>preview?(shelfContext||"draft-shelf"):planSelected;
      const zoneFor=id=>preview?getZone():layoutDraft.find(s=>s.id===id)?.zone;
      function point(event) {
        const svg=container.querySelector('svg.warehouse-plan');
        return new DOMPoint(event.clientX,event.clientY).matrixTransform(svg.getScreenCTM().inverse());
      }
      function paint(id,zone,focus=false) {
        if(preview) {
          for(const key of ["x","y","w","h"]) $("#zone-"+key).value=zone[key];
          updateZonePreview();
        } else {
          const shelf=layoutDraft?.find(s=>s.id===id);if(!shelf)return;
          shelf.zone=zone;renderWarehouse();
        }
        if(focus) [...container.querySelectorAll('[data-plan-id]')].find(el=>el.dataset.planId===id)?.focus({preventScroll:true});
      }
      container.addEventListener('pointerdown',event=>{
        if(!editable() || event.button!==0)return;
        const rack=event.target.closest('[data-plan-id]');
        if(!rack || (preview && rack.dataset.planId!==selectedId()))return;
        const id=rack.dataset.planId;planSelected=preview?planSelected:id;
        drag={id,point:point(event),zone:{...zoneFor(id)},pointer:event.pointerId};
        container.setPointerCapture(event.pointerId);event.preventDefault();
      });
      container.addEventListener('pointermove',event=>{
        if(!drag || event.pointerId!==drag.pointer || !editable())return;
        const p=point(event);
        paint(drag.id,P.move(drag.zone,drag.zone.x+(p.x-drag.point.x)/10,drag.zone.y+(p.y-drag.point.y)/4));
      });
      function finish(event,cancel) {
        if(!drag||event.pointerId!==drag.pointer)return;
        const old=drag;drag=null;
        if(editable())paint(old.id,cancel?old.zone:zoneFor(old.id),true);
        if(container.hasPointerCapture(event.pointerId))container.releasePointerCapture(event.pointerId);
      }
      container.addEventListener('pointerup',event=>finish(event,false));
      container.addEventListener('pointercancel',event=>finish(event,true));
      container.addEventListener('keydown',event=>{
        const rack=event.target.closest('[data-plan-id]');if(!rack)return;
        if(!preview&&!layoutDraft&&(event.key==='Enter'||event.key===' ')) {event.preventDefault();showShelf(rack.dataset.planId);return;}
        if(!editable()||(preview&&rack.dataset.planId!==selectedId()))return;
        const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
        if(!delta)return;
        event.preventDefault();const id=rack.dataset.planId,zone=zoneFor(id),step=event.shiftKey?5:1;
        if(!preview)planSelected=id;
        paint(id,P.move(zone,zone.x+delta[0]*step,zone.y+delta[1]*step),true);
      });
    }
    attach($("#warehouse-illustration"),false);
    attach($("#zone-preview"),true);
  }
  function bindAccount() {
    $("#account-button").onclick = () => { $("#account-error").textContent = ""; renderAccess(); $("#account-dialog").showModal(); };
    $("#google-login").onclick = async () => {
      $("#google-login").disabled = true; $("#account-error").textContent = "";
      try { await cloud.login(); $("#account-dialog").close(); } catch (error) { $("#account-error").textContent = error.message; }
      finally { $("#google-login").disabled = !session.configured; }
    };
    $("#sign-out").onclick = async () => {
      try { await cloud.logout(); $("#account-dialog").close(); } catch (error) { $("#account-error").textContent = cloud.errorMessage(error); }
    };
    $("#copy-account-id").onclick = async () => {
      try { await navigator.clipboard.writeText(session.user.uid); toast("Identificador copiado."); }
      catch { $("#account-uid").focus(); $("#account-uid").select(); }
    };
    $("#legacy-import").onclick = async () => {
      if (!canEdit() || cloudExists || !legacyStock) return;
      const count = legacyStock.shelves.reduce((sum, shelf) => sum + shelf.items.length, 0);
      if (!await confirmAction("Publicar os cadastros anteriores?", "Serão publicados " + legacyStock.shelves.length + " prateleira(s) e " + count + " item(ns), incluindo fotos. Todos que acessarem o link poderão consultar esses dados.", "Publicar cadastros")) return;
      try { await commit(legacyStock, "Cadastros publicados.", 0); legacyStock = null; renderAccess(); }
      catch (error) { toast(error.message, true); }
    };
  }
  async function initialize() {
    state = M.defaultState(); state.shelves[0].id = "initial-shelf"; activeShelf = state.shelves[0].id;
    bindEvents(); render();
    cloud.readLegacy().then(value => {
      if (value && (value.shelves.some(shelf => shelf.items.length) || value.warehousePhoto)) legacyStock = value;
      renderAccess();
    }).catch(() => {});
    await cloud.init({
      onState(record) {
        if (record.revision < revision) return;
        state = record.state; revision = record.revision; cloudExists = record.exists;
        if (!state.shelves.some(shelf => shelf.id === activeShelf)) activeShelf = state.shelves[0].id;
        $("#storage-warning").hidden = true; render();
      },
      onSession(value) {
        const previousAccess = session.admin && session.ready;
        session = value;
        if (!canEdit()) { layoutDraft = null; planSelected = null; }
        if (previousAccess !== (session.admin && session.ready)) {
          for (const id of ["item-dialog", "shelf-dialog", "confirm-dialog"]) if ($("#" + id).open) $("#" + id).close();
        }
        render();
      },
      onError(message) { $("#storage-warning").textContent = message; $("#storage-warning").hidden = false; renderAccess(); }
    });
  }
  initialize();
})();

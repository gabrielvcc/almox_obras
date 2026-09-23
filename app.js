/* Almox: aplicativo estático, sem serviços externos ou bibliotecas. */
(() => {
  "use strict";
  const M = window.Inventory;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const esc = value => String(value).replace(/[&<>"']/g, character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[character]));
  const icon = name => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  let state, db, revision = 0, activeShelf, view = "shelf", filter = "all", shelfFilter = "all";
  let itemContext = null, shelfContext = null, pendingPhoto = "", photoLoading = false, photoSequence = 0, toastTimer, saving = false;
  const imageTypes = ["image/jpeg", "image/png", "image/webp"];
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("almox-updates") : null;

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
  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error("IndexedDB indisponível"));
      const request = indexedDB.open("almox-local", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("inventory");
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); toast("O estoque foi atualizado. Recarregue esta página.", true); };
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Armazenamento bloqueado por outra aba"));
    });
  }
  function readRecord() {
    return new Promise((resolve, reject) => {
      const request = db.transaction("inventory", "readonly").objectStore("inventory").get("main");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function writeRecord(next) {
    if (!db) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("inventory", "readwrite");
      const objectStore = transaction.objectStore("inventory");
      let conflict = false;
      const request = objectStore.get("main");
      request.onsuccess = () => {
        if ((request.result?.revision || 0) !== revision) { conflict = true; transaction.abort(); return; }
        objectStore.put({state: next, revision: revision + 1}, "main");
      };
      transaction.oncomplete = () => { revision++; resolve(); };
      transaction.onabort = () => reject(new Error(conflict ? "O estoque mudou em outra aba. Feche este formulário e recarregue a página antes de editar." : "Não foi possível salvar. Tente novamente ou use uma foto menor."));
      transaction.onerror = () => {};
    });
  }
  async function commit(next, message) {
    if (saving) throw new Error("Aguarde o salvamento em andamento.");
    const validated = M.validateState(next);
    if (new Blob([JSON.stringify(validated)]).size > 48 * 1024 * 1024) throw new Error("O estoque atingiu o limite de 48 MB desta versão. Reduza as fotos antes de continuar.");
    saving = true;
    try {
      await writeRecord(validated); state = validated;
      if (!state.shelves.some(shelf => shelf.id === activeShelf)) activeShelf = state.shelves[0].id;
      render(); if (db) channel?.postMessage({revision});
      if (message) toast(message + (db ? "" : " As alterações serão perdidas ao fechar esta página."));
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
    renderMap(); if (view === "warehouse") renderWarehouse(); if (view === "items") renderCatalog();
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
            const label = item ? codes + ": " + item.name + ", " + item.quantity + " " + item.unit + ". Clique para editar." : codes + ": livre. Clique para cadastrar.";
            slots += '<button class="slot ' + (item ? "occupied " : "") + (full ? "full " : "") + (!visible ? "dimmed " : query ? "matched " : "") + '" data-shelf-id="' + esc(shelf.id) + '" data-row="' + row + '" data-position="' + position + '" title="' + esc(label) + '" aria-label="' + esc(label) + '"><span class="slot-code">' + codes + '</span><span class="slot-bottom">' + (full ? esc(item.name) : item ? '<svg class="mini-icon" aria-hidden="true"><use href="#i-box"/></svg>' : "+") + '</span></button>';
          }
          modules += '<div class="module" aria-label="Módulo ' + (offset / 2 + moduleIndex + 1) + '">' + slots + "</div>";
        }
        return '<div class="rack-floor"><div class="floor-label"><strong>' + row + "</strong><small>" + (4 - rowIndex) + "º andar</small></div>" + modules + "</div>";
      }).join("");
      return '<article class="shelf-board" data-board="' + esc(shelf.id) + '" aria-label="' + esc(shelf.name) + '"><header class="shelf-board-heading"><div><h3>' + esc(shelf.name) + '</h3><p>Posições ' + (offset + 1) + '–' + (offset + M.POSITIONS) + '</p></div><button class="button secondary shelf-edit" data-edit-shelf="' + esc(shelf.id) + '">' + icon("edit") + 'Editar prateleira</button></header>' + headings + floors + '<div class="rack-base"><span></span><span></span></div></article>';
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
      '<div class="catalog-empty">' + icon("box") + '<h2>' + (groups.length ? "Nenhum item encontrado" : "Seus itens aparecem aqui") + '</h2><p>' + (groups.length ? "Tente outro nome, patrimônio ou posição." : "Cadastre um item em uma posição da prateleira para começar.") + '</p></div>';
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
      const right = state.shelves.find(shelf => normalized(shelf.name).includes("direita")) || state.shelves.find(shelf => !normalized(shelf.name).includes("esquerda"));
      const left = state.shelves.find(shelf => shelf.id !== right?.id && normalized(shelf.name).includes("esquerda")) || state.shelves.find(shelf => shelf.id !== right?.id);
      $("#hotspots").innerHTML = [{side: "esquerda", css: "left", shelf: left, y: 24.706}, {side: "direita", css: "right", shelf: right, y: 66.471}].map(({side, css, shelf, y}) => {
        const title = shelf ? shelf.name : "Prateleira " + side;
        const detail = shelf ? shelf.items.length + " itens" : "Cadastrar prateleira";
        return '<button class="hotspot plan-shelf plan-' + css + (shelf ? "" : " unassigned") + '" ' + (shelf ? 'data-shelf="' + esc(shelf.id) : 'data-plan-add="' + side) + '" style="left:10%;top:' + y + '%;width:50%;height:8.824%" aria-label="' + (shelf ? "Abrir " : "Cadastrar ") + esc(title) + '"><span class="plan-label"><span><strong>' + esc(title) + '</strong><small>' + detail + '</small></span>' + icon(shelf ? "arrow" : "plus") + '</span></button>';
      }).join("");
    }
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
    const selected = item ? item.start : position;
    const first = M.pairStart(selected);
    const code = value => M.positionLabel(state, shelf.id, row, value);
    itemContext = {shelfId: shelf.id, row, position: selected, itemId: item?.id || null};
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
    fullRadio.disabled = blocked; fullRadio.checked = item?.span === 2;
    $('input[name="span"][value="1"]').checked = item?.span !== 2;
    $("#full-module-label").textContent = "Ocupa " + code(first) + " + " + code(first + 1);
    $("#span-help").textContent = blocked ? "A outra posição está ocupada. O módulo inteiro não está disponível." : item?.span === 2 ? "Ao reduzir para uma posição, o item permanece em " + code(first) + "." : "O módulo inteiro reserva as duas posições deste par.";
    $("#delete-item").hidden = !item;
    pendingPhoto = item?.photo || ""; setPhotoPreview();
    $("#item-dialog").showModal();
  }
  async function saveItem(event) {
    event.preventDefault();
    if (photoLoading) { $("#item-error").textContent = "Aguarde a foto terminar de carregar."; return; }
    const context = itemContext;
    $("#save-item").disabled = true;
    try {
      const next = M.clone(state), shelf = shelfIn(next, context.shelfId);
      if (!shelf) throw new Error("Prateleira não encontrada.");
      const span = Number($('input[name="span"]:checked').value);
      const candidate = {id: context.itemId || M.uid(), row: context.row, start: span === 2 ? M.pairStart(context.position) : context.position, span, name: $("#item-name").value.trim(), quantity: Number($("#item-quantity").value), unit: $("#item-unit").value, asset: $("#item-asset").value.trim(), notes: $("#item-notes").value.trim(), photo: pendingPhoto, updatedAt: new Date().toISOString()};
      M.placeItem(shelf, candidate);
      shelf.items = shelf.items.filter(item => item.id !== candidate.id); shelf.items.push(candidate);
      await commit(next, "Item salvo. Cada coisa em seu lugar.");
      $("#item-dialog").close();
    } catch (error) { $("#item-error").textContent = error.message; }
    finally { $("#save-item").disabled = false; }
  }
  async function deleteItem() {
    const context = itemContext, item = shelfIn(state, context.shelfId)?.items.find(value => value.id === context.itemId);
    if (!item || !await confirmAction("Liberar esta posição?", 'O cadastro de "' + item.name + '" será removido, incluindo a foto. O espaço ficará disponível.', "Liberar posição")) return;
    try {
      const next = M.clone(state), shelf = shelfIn(next, context.shelfId);
      shelf.items = shelf.items.filter(value => value.id !== context.itemId);
      await commit(next, "Posição liberada."); $("#item-dialog").close();
    } catch (error) { $("#item-error").textContent = error.message; }
  }
  function openShelf(edit = false, planSide = null, shelfId = activeShelf) {
    if (!edit && state.shelves.length >= 30) { toast("Esta versão permite até 30 prateleiras por galpão.", true); return; }
    const shelf = edit ? shelfIn(state, shelfId) : null;
    shelfContext = shelf?.id || null;
    $("#shelf-form").reset(); $("#shelf-error").textContent = "";
    $("#shelf-dialog-title").textContent = edit ? "Editar prateleira" : "Nova prateleira";
    $("#shelf-name").value = shelf?.name || (planSide ? "Prateleira " + planSide : "");
    const index = state.shelves.length;
    const zone = shelf?.zone || (planSide ? {x: 25, y: planSide === "esquerda" ? 36 : 58, w: 50, h: 5} : {x: 6 + index % 3 * 30, y: 15 + Math.floor(index / 3) % 2 * 35, w: 25, h: 30});
    ["x", "y", "w", "h"].forEach(key => { $("#zone-" + key).value = zone[key]; });
    $("#delete-shelf").hidden = !edit; $("#delete-shelf").disabled = state.shelves.length === 1;
    $("#delete-shelf").title = state.shelves.length === 1 ? "Mantenha ao menos uma prateleira no galpão." : "";
    updateZonePreview(); $("#shelf-dialog").showModal();
  }
  function getZone() { return Object.fromEntries(["x", "y", "w", "h"].map(key => [key, Number($("#zone-" + key).value)])); }
  function updateZonePreview() {
    const zone = getZone(), box = $("#zone-preview-box");
    box.style.left = zone.x + "%"; box.style.top = zone.y + "%"; box.style.width = zone.w + "%"; box.style.height = zone.h + "%";
    box.textContent = $("#shelf-name").value || "Prateleira";
    $("#zone-preview").style.backgroundImage = state.warehousePhoto ? 'url("' + state.warehousePhoto + '")' : "none";
  }
  async function saveShelf(event) {
    event.preventDefault();
    const submit = event.submitter; submit.disabled = true;
    try {
      const next = M.clone(state), name = $("#shelf-name").value.trim(), zone = M.validateZone(getZone());
      if (!name) throw new Error("Informe o nome da prateleira.");
      if (next.shelves.some(shelf => shelf.id !== shelfContext && normalized(shelf.name) === normalized(name))) throw new Error("Já existe uma prateleira com esse nome.");
      let id = shelfContext;
      if (id) Object.assign(shelfIn(next, id), {name, zone});
      else { id = M.uid(); next.shelves.push({id, name, zone, items: []}); }
      await commit(next, shelfContext ? "Prateleira atualizada." : "Nova prateleira criada.");
      $("#shelf-dialog").close();
    } catch (error) { $("#shelf-error").textContent = error.message; }
    finally { submit.disabled = false; }
  }
  async function deleteShelf() {
    const shelf = shelfIn(state, shelfContext);
    if (!shelf || state.shelves.length === 1) return;
    if (!await confirmAction("Excluir prateleira?", '"' + shelf.name + '" e seus ' + shelf.items.length + " itens serão removidos.", "Excluir prateleira")) return;
    try {
      const next = M.clone(state); next.shelves = next.shelves.filter(value => value.id !== shelf.id);
      await commit(next, "Prateleira excluída."); $("#shelf-dialog").close();
    } catch (error) { $("#shelf-error").textContent = error.message; }
  }
  function readImage(file) {
    return new Promise((resolve, reject) => {
      if (!imageTypes.includes(file.type)) return reject(new Error("Escolha uma imagem JPG, PNG ou WebP."));
      if (file.size > 10 * 1024 * 1024) return reject(new Error("A imagem deve ter no máximo 10 MB."));
      const image = new Image(), url = URL.createObjectURL(file);
      image.onload = () => {
        URL.revokeObjectURL(url);
        try {
          const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          const context = canvas.getContext("2d"); context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.84));
        } catch { reject(new Error("Não foi possível processar a imagem. Tente uma foto menor.")); }
      };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Não foi possível abrir essa imagem.")); };
      image.src = url;
    });
  }
  async function onItemPhoto(event) {
    const file = event.target.files[0]; if (!file) return;
    const sequence = ++photoSequence; photoLoading = true; $("#save-item").disabled = true; $("#item-error").textContent = "";
    try { const result = await readImage(file); if (sequence === photoSequence) { pendingPhoto = result; setPhotoPreview(); } }
    catch (error) { if (sequence === photoSequence) $("#item-error").textContent = error.message; }
    finally { if (sequence === photoSequence) { photoLoading = false; $("#save-item").disabled = false; event.target.value = ""; } }
  }
  async function onWarehousePhoto(event) {
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
    $("#remove-item-photo").onclick = () => { photoSequence++; photoLoading = false; $("#save-item").disabled = false; pendingPhoto = ""; $("#item-photo").value = ""; setPhotoPreview(); };
    $("#shelf-form").onsubmit = saveShelf; $("#delete-shelf").onclick = deleteShelf;
    ["x", "y", "w", "h"].forEach(key => { $("#zone-" + key).oninput = updateZonePreview; }); $("#shelf-name").oninput = updateZonePreview;
    $("#change-photo").onclick = () => $("#warehouse-photo-input").click();
    $("#warehouse-photo-input").onchange = onWarehousePhoto;
    $("#remove-warehouse-photo").onclick = async () => {
      if (!await confirmAction("Remover foto do galpão?", "A ilustração inicial voltará a aparecer. As prateleiras e seus itens serão mantidos.", "Remover foto")) return;
      try { const next = M.clone(state); next.warehousePhoto = ""; await commit(next, "Ilustração restaurada."); } catch (error) { toast(error.message, true); }
    };
    if (channel) channel.onmessage = async () => {
      if (!db || saving) return;
      if ($("dialog[open]")) { toast("O estoque foi alterado em outra aba. Recarregue antes de salvar novas alterações.", true); return; }
      try { const record = await readRecord(); if (record && record.revision > revision) { state = M.validateState(record.state); revision = record.revision; render(); toast("Estoque atualizado a partir de outra aba."); } } catch { toast("Recarregue para obter as alterações da outra aba.", true); }
    };
  }
  async function initialize() {
    try {
      db = await openDatabase();
      const record = await readRecord();
      if (record) { state = M.validateState(record.state); revision = record.revision; }
      else { state = M.defaultState(); await writeRecord(state); }
    } catch (error) {
      db?.close(); db = null; state = M.defaultState();
      $("#storage-warning").hidden = false;
    }
    activeShelf = state.shelves[0].id; bindEvents(); render();
  }
  initialize();
})();


"""Smoke test real do Almox, sem pacotes externos. Chrome/Edge + Python 3."""
import base64
import functools
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import sys
import subprocess
import threading
import time
import urllib.parse
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / ".artifacts"
ARTIFACTS.mkdir(exist_ok=True)
PROFILE = ARTIFACTS / ("browser-profile-" + str(time.time_ns()))
BROWSERS = [
    shutil.which("google-chrome"), shutil.which("chromium"), shutil.which("chrome"),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]
BROWSER = next((value for value in BROWSERS if value and Path(value).exists()), None)
if not BROWSER:
    raise SystemExit("Instale Chrome/Edge ou ajuste BROWSERS em tests/browser_check.py.")

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    use_fake = False
    def do_GET(self):
        # O teste nunca carrega a configuração de produção.
        if self.path.split('?')[0] == '/firebase-config.js':
            body = b'window.ALMOX_FIREBASE_CONFIG = null;'
            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.use_fake and self.path.split('?')[0] == '/firebase-client.js':
            self.path = '/tests/fixtures/cloud-fake.js'
        super().do_GET()

    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError):
            pass
    def log_message(self, *args):
        pass

class CDP:
    def __init__(self, url):
        parsed = urllib.parse.urlparse(url)
        self.sock = socket.create_connection((parsed.hostname, parsed.port), timeout=20)
        self.counter = 0
        self.errors = []
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(("GET " + parsed.path + " HTTP/1.1\r\nHost: " + parsed.netloc +
                           "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " +
                           key + "\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        response = b""
        while not response.endswith(b"\r\n\r\n"):
            response += self.exact(1)
        if response.split(b" ")[1] != b"101":
            raise RuntimeError(response.decode())
    def exact(self, length):
        result = b""
        while len(result) < length:
            chunk = self.sock.recv(length - len(result))
            if not chunk:
                raise RuntimeError("Chrome desconectou.")
            result += chunk
        return result
    def send(self, payload, opcode=1):
        mask = os.urandom(4)
        length = len(payload)
        header = bytes([128 | opcode])
        if length < 126:
            header += bytes([128 | length])
        elif length <= 65535:
            header += bytes([128 | 126]) + struct.pack("!H", length)
        else:
            header += bytes([128 | 127]) + struct.pack("!Q", length)
        self.sock.sendall(header + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(payload)))
    def receive(self):
        collected = b""
        while True:
            first, second = self.exact(2)
            length = second & 127
            if length == 126:
                length = struct.unpack("!H", self.exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self.exact(8))[0]
            mask = self.exact(4) if second & 128 else None
            payload = self.exact(length)
            if mask:
                payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
            opcode = first & 15
            if opcode == 9:
                self.send(payload, 10)
                continue
            if opcode == 8:
                raise RuntimeError("WebSocket fechado.")
            if opcode in (0, 1):
                collected += payload
                if first & 128:
                    return json.loads(collected)
    def call(self, method, params=None):
        self.counter += 1
        request_id = self.counter
        self.send(json.dumps({"id": request_id, "method": method, "params": params or {}}).encode())
        while True:
            message = self.receive()
            if message.get("method") == "Runtime.exceptionThrown":
                self.errors.append(message["params"])
            if message.get("id") == request_id:
                if "error" in message:
                    raise RuntimeError(message["error"])
                return message.get("result", {})
    def evaluate(self, expression):
        response = self.call("Runtime.evaluate", {"expression": expression, "awaitPromise": True, "returnByValue": True})
        if "exceptionDetails" in response:
            raise AssertionError(json.dumps(response["exceptionDetails"], ensure_ascii=False))
        return response.get("result", {}).get("value")
    def screenshot(self, name):
        result = self.call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
        (ARTIFACTS / name).write_bytes(base64.b64decode(result["data"]))

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
process = subprocess.Popen([BROWSER, "--headless=new", "--disable-gpu", "--no-first-run",
                            "--no-default-browser-check", "--remote-debugging-port=0",
                            "--user-data-dir=" + str(PROFILE), "about:blank"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
client = None
try:
    active_port = PROFILE / "DevToolsActivePort"
    deadline = time.time() + 20
    while not active_port.exists():
        if time.time() > deadline:
            raise RuntimeError("Chrome não iniciou em 20 segundos.")
        time.sleep(0.1)
    port = active_port.read_text().splitlines()[0]
    pages = json.load(urllib.request.urlopen("http://127.0.0.1:" + port + "/json/list"))
    client = CDP(next(page["webSocketDebuggerUrl"] for page in pages if page["type"] == "page"))
    client.call("Page.enable")
    client.call("Runtime.enable")
    client.call("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 1000, "deviceScaleFactor": 1, "mobile": False})
    client.call("Page.navigate", {"url": "http://127.0.0.1:" + str(server.server_port) + "/index.html"})
    time.sleep(0.5)
    helper = """
      window.q = s => document.querySelector(s);
      window.check = (value, message) => { if (!value) throw Error(message); };
      window.until = async fn => { for(let i=0;i<200;i++){if(fn()) return; await new Promise(r=>setTimeout(r,25));} throw Error('Timeout: '+fn); };
      window.save = async () => { q('#save-item').click(); await until(()=>!q('#item-dialog').open); };
      window.selectShelf = index => {q('#shelf-filter').selectedIndex=index+1; q('#shelf-filter').dispatchEvent(new Event('change'));};
      window.openSlot = (row, pos) => q('[data-row="'+row+'"][data-position="'+pos+'"]').click();
      window.setFile = (selector, text, name, type) => {const transfer=new DataTransfer(); transfer.items.add(new File([text],name,{type})); q(selector).files=transfer.files; q(selector).dispatchEvent(new Event('change',{bubbles:true}));};
      window.png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c=>c.charCodeAt(0));
    """
    client.evaluate(helper)
    client.evaluate("(async()=>{await until(()=>q('#storage-warning')&&!q('#storage-warning').hidden);check(!document.body.classList.contains('can-edit'),'Sem configuração nunca concede edição');check(getComputedStyle(q('#add-shelf')).display==='none','Cadastro oculto');q('#account-button').click();check(q('#google-login').disabled,'Login aguarda configuração');q('[data-close=\"account-dialog\"]').click();})()")
    print("OK: aplicação real sem configuração permanece somente leitura.", flush=True)
    QuietHandler.use_fake = True
    client.call("Page.reload", {"ignoreCache": True})
    time.sleep(0.5)
    client.evaluate(helper)
    client.evaluate("(async()=>{await until(()=>document.querySelectorAll('.slot').length===96);check(q('#occupied-count').textContent==='0','Estoque inicial vazio');check(q('#storage-warning').hidden,'Estoque disponível');})()")
    client.evaluate("""(async()=>{
      const canvas=document.createElement('canvas');canvas.width=1800;canvas.height=2600;
      const ctx=canvas.getContext('2d'),pixels=ctx.createImageData(canvas.width,canvas.height);
      let seed=17;for(let i=0;i<pixels.data.length;i+=4){seed=(Math.imul(seed,1664525)+1013904223)|0;pixels.data[i]=seed&255;pixels.data[i+1]=(seed>>>8)&255;pixels.data[i+2]=(seed>>>16)&255;pixels.data[i+3]=255;}
      ctx.putImageData(pixels,0,0);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      const compressed=await AlmoxPhotos.fromFile(new File([blob],'celular.png',{type:'image/png'}));
      check(compressed.startsWith('data:image/jpeg;base64,')&&compressed.length<=260000,'PNG grande convertido abaixo do limite');
      const image=new Image();image.src=compressed;await image.decode();check(Math.max(image.width,image.height)<=1200,'Dimensões reduzidas');
      canvas.width=20;canvas.height=20;
      const white=await AlmoxPhotos.compress(canvas.toDataURL('image/png'));
      image.src=white;await image.decode();ctx.drawImage(image,0,0);
      const pixel=ctx.getImageData(5,5,1,1).data;check(pixel[0]>245&&pixel[3]===255,'Transparência vira fundo branco');
    })()""")
    print("OK: PNG grande comprimido, limite de tamanho, dimensões e transparência.", flush=True)
    client.screenshot("desktop-empty.png")
    print("OK: inicialização e 96 posições.", flush=True)
    client.evaluate("""(async()=>{
      q('#warehouse-nav').click();
      check(document.querySelectorAll('#warehouse-illustration .plan-rack').length===1,'Somente prateleiras reais na planta');
      check(document.querySelectorAll('#warehouse-illustration .plan-bay').length===12,'12 módulos em vista superior');
      q('#warehouse-add').click();q('#shelf-name').value='Nova lateral';q('#shelf-name').dispatchEvent(new Event('input'));
      const before=Number(q('#zone-x').value);
      q('#zone-preview .is-selected').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
      check(Number(q('#zone-x').value)===before+1,'Prévia permite posicionar prateleira nova');
      q('[data-close="shelf-dialog"]').click();
      q('#plan-edit').click();
    })()""")
    drag_origin = client.evaluate("(()=>{const r=q('#warehouse-illustration .plan-rack').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()")
    client.call("Input.dispatchMouseEvent", {"type":"mousePressed", "x":drag_origin["x"], "y":drag_origin["y"], "button":"left", "clickCount":1})
    client.call("Input.dispatchMouseEvent", {"type":"mouseMoved", "x":drag_origin["x"]-50, "y":drag_origin["y"]-20, "button":"left", "buttons":1})
    client.call("Input.dispatchMouseEvent", {"type":"mouseReleased", "x":drag_origin["x"]-50, "y":drag_origin["y"]-20, "button":"left", "clickCount":1})
    client.evaluate("""(async()=>{
      const transform=q('#warehouse-illustration .plan-rack').getAttribute('transform');
      check(transform!=='translate(640 80)','Arrastar muda posição');
      q('#plan-save').click();await until(()=>q('#plan-save').hidden);
      const stored=JSON.parse(localStorage.getItem('almox-test-record')).state.shelves[0].zone;
      check(stored.x<64&&stored.y<20,'Posição salva');
      q('#plan-edit').click();
      q('#warehouse-illustration .plan-rack').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
      q('#plan-cancel').click();check(q('#warehouse-illustration .plan-rack').getAttribute('transform')===transform,'Cancelar restaura posição');
      q('#plan-zoom-in').click();check(q('#warehouse-stage').style.width==='125%','Zoom funciona');q('#plan-zoom-reset').click();
    })()""")
    client.screenshot("warehouse-plan.png")
    client.call("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 1, "mobile": True})
    client.evaluate("check(document.documentElement.scrollWidth<=392,'Planta não estoura a página móvel');q('#warehouse-scroll').scrollLeft=210;")
    client.screenshot("warehouse-plan-mobile.png")
    client.call("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 1000, "deviceScaleFactor": 1, "mobile": False})
    client.evaluate("q('#warehouse-illustration .plan-rack').dispatchEvent(new MouseEvent('click',{bubbles:true}));check(!q('#shelf-view').hidden,'Planta abre estoque existente');")
    print("OK: planta dinâmica, prévia, arrastar, salvar, cancelar, zoom e navegação.", flush=True)

    client.evaluate("""(async()=>{
      openSlot('A',2);q('#item-name').value='Cimento CP-2';q('#item-quantity').value='5';q('#item-asset').value='PAT-001';
      q('input[name=span][value="2"]').click();
      setFile('#item-photo',png,'foto.png','image/png');await until(()=>!q('#item-photo-preview').hidden&&!q('#save-item').disabled);
      await save();check(q('#occupied-count').textContent==='2','Item grande ocupa duas posições');
      check(document.querySelectorAll('.slot').length===95,'Par unificado');check(q('.slot.full').textContent.includes('A1 + A2'),'Par correto ao clicar em A2');
      openSlot('A',1);check(q('#item-quantity').value==='5','Quantidade salva');check(!q('#item-photo-preview').hidden,'Foto salva');q('[data-close="item-dialog"]').click();
    })()""")
    client.screenshot("desktop-item.png")
    print("OK: cadastro com foto e ocupação integral a partir da segunda posição.", flush=True)
    client.evaluate("""(async()=>{
      openSlot('A',1);q('input[name=span][value="1"]').click();await save();check(q('#occupied-count').textContent==='1','Redução libera espaço');
      openSlot('A',2);q('#item-name').value='Argamassa';await save();
      openSlot('A',1);check(q('input[name=span][value="2"]').disabled,'Bloqueia sobreposição');q('[data-close="item-dialog"]').click();
      q('#search').value='PAT-001';q('#search').dispatchEvent(new Event('input'));check(document.querySelectorAll('.slot.matched').length===1,'Busca patrimônio');
      q('#search').value='não existe';q('#search').dispatchEvent(new Event('input'));check(q('#search-feedback').textContent.includes('Nenhuma'),'Busca vazia');
    })()""")
    client.call("Page.reload")
    time.sleep(0.4)
    client.evaluate(helper)
    client.evaluate("(async()=>{await until(()=>q('#item-count').textContent==='2');openSlot('A',1);check(!q('#item-photo-preview').hidden,'Foto persiste ao recarregar');q('[data-close=\"item-dialog\"]').click();})()")
    print("OK: colisões, busca, redução e persistência após recarregar.", flush=True)
    client.evaluate("""(async()=>{
      q('#warehouse-nav').click();setFile('#warehouse-photo-input',png,'galpao.png','image/png');
      await until(()=>!q('#warehouse-image').hidden&&!q('#change-photo').disabled);
      q('#warehouse-add').click();q('#shelf-name').value='Prateleira esquerda';q('#shelf-form button[type=submit]').click();
      await until(()=>!q('#shelf-dialog').open);check(document.querySelectorAll('.hotspot').length===2,'Duas prateleiras no galpão');
      document.querySelectorAll('#warehouse-cards [data-shelf]')[1].click();check(q('#item-count').textContent==='0','Prateleiras independentes');
      q('.shelf-edit').click();q('#zone-x').value='90';q('#zone-w').value='25';q('#shelf-form button[type=submit]').click();
      await until(()=>q('#shelf-error').textContent.length>0);check(q('#shelf-dialog').open,'Área inválida não salva');
      q('#zone-x').value='6';q('#shelf-form button[type=submit]').click();await until(()=>!q('#shelf-dialog').open);
    })()""")
    print("OK: foto real, múltiplas prateleiras e validação das áreas clicáveis.", flush=True)
    client.evaluate("""(async()=>{
      q('#shelves-nav').click();
      check(q('#shelf-filter').value==='all','Todas por padrão');
      check(document.querySelectorAll('.shelf-board').length===2,'Prateleiras na mesma página');
      check(document.querySelectorAll('.slot').length===192,'96 posições em cada prateleira');
      const boards=[...document.querySelectorAll('.shelf-board')];
      check(boards[1].getBoundingClientRect().left>boards[0].getBoundingClientRect().right,'Mapas lado a lado');
      const last=boards[1].querySelector('[data-row="A"][data-position="24"]');
      check(last.textContent.includes('A48'),'Numeração contínua na segunda prateleira');
      last.click();check(q('#item-dialog-title').textContent==='Posição A48','Cadastro usa endereço global');
      q('#item-name').value='Teste limite';q('input[name=span][value="2"]').click();await save();
      const large=document.querySelectorAll('.shelf-board')[1].querySelector('.slot.full');
      check(large.textContent.includes('A47 + A48'),'Último par correto');
      large.click();q('#delete-item').click();await until(()=>q('#confirm-dialog').open);q('#confirm-accept').click();await until(()=>!q('#item-dialog').open);
      selectShelf(1);check(document.querySelectorAll('.shelf-board').length===1,'Filtro por prateleira');
      check(q('.slot').textContent.includes('A25'),'Filtro preserva início em A25');
      q('#search').value='A48';q('#search').dispatchEvent(new Event('input'));check(document.querySelectorAll('.slot.matched').length===1,'Busca pelo endereço contínuo');
      q('#shelves-nav').click();
    })()""")
    client.screenshot("shelves-all.png")
    client.evaluate("selectShelf(1);")
    client.screenshot("shelves-filtered.png")
    print("OK: página única, 12 módulos, numeração contínua, filtro e último módulo.", flush=True)

    client.evaluate("""(async()=>{
      openSlot('C',8);q('#item-name').value='Cone';q('#item-quantity').value='8';q('#item-asset').value='P-02';await save();
      selectShelf(0);
      openSlot('A',2);q('#item-name').value='Cone';q('#item-quantity').value='5';q('#item-asset').value='P-01';await save();
      q('#items-nav').click();check(!q('#items-view').hidden,'Consulta de itens acessível');
      window.coneGroup=()=>[...document.querySelectorAll('.item-group')].find(group=>group.querySelector('.catalog-name strong').textContent==='Cone');
      check(coneGroup().querySelector('.catalog-total strong').textContent==='13 un','Total agrupado correto');
      check(coneGroup().textContent.includes('A2')&&coneGroup().textContent.includes('C32'),'Localizações preservadas');
      check(coneGroup().textContent.includes('P-01')&&coneGroup().textContent.includes('P-02'),'Patrimônios preservados');
      check(document.querySelector('.catalog-photo img'),'Foto aparece na consulta');
      q('#catalog-search').value='C32';q('#catalog-search').dispatchEvent(new Event('input'));
      check(document.querySelectorAll('.item-group').length===1,'Busca por patrimônio');
      check(coneGroup().querySelectorAll('li').length===2,'Busca mantém todas as localizações e o total');
      q('#catalog-search').value='inexistente';q('#catalog-search').dispatchEvent(new Event('input'));
      check(q('.catalog-empty').textContent.includes('Nenhum'),'Busca sem resultados');
      q('#catalog-search').value='';q('#catalog-search').dispatchEvent(new Event('input'));
    })()""")
    client.screenshot("items-desktop.png")
    client.evaluate("""(async()=>{
      coneGroup().querySelector('[data-row="C"][data-position="8"]').click();
      check(q('#item-name').value==='Cone'&&q('#item-quantity').value==='8','Abre o registro correto da outra prateleira');
      q('#item-quantity').value='9';await save();q('#items-nav').click();
      check(coneGroup().querySelector('.catalog-total strong').textContent==='14 un','Consulta reflete alteração de quantidade');
      coneGroup().querySelector('[data-row="A"][data-position="2"]').click();
      q('#delete-item').click();await until(()=>q('#confirm-dialog').open);q('#confirm-dialog button[value=cancel]').click();
      check(q('#item-dialog').open,'Cancelamento preserva cadastro');q('#delete-item').click();await until(()=>q('#confirm-dialog').open);q('#confirm-accept').click();
      await until(()=>!q('#item-dialog').open);check(q('#item-count').textContent==='1','Exclusão libera posição');
      q('#items-nav').click();check(coneGroup().querySelector('.catalog-total strong').textContent==='9 un','Consulta reflete exclusão');
      check(!q('#export-button')&&!q('#import-button')&&!q('#backup-input')&&!q('.mobile-backup'),'Backup retirado da interface');
      check(!document.body.innerText.includes('Modo local')&&!document.body.innerText.includes('armazenamento local'),'Interface sem termos técnicos');
    })()""")
    print("OK: consulta agrupada, patrimônios, busca, edição por posição e exclusão.", flush=True)
    client.call("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 1, "mobile": True})
    client.evaluate("check(document.documentElement.scrollWidth<=392,'Sem transbordamento no celular');check(getComputedStyle(q('#warehouse-mobile')).display!=='none','Navegação móvel visível');")
    client.screenshot("mobile.png")
    client.evaluate("q('#warehouse-mobile').click();check(!q('#warehouse-view').hidden,'Galpão acessível no celular');check(!q('#export-mobile'),'Sem backup na visão do galpão');q('#items-mobile').click();check(!q('#items-view').hidden,'Itens acessível no celular');check(document.documentElement.scrollWidth<=392,'Consulta cabe no celular');")
    client.screenshot("items-mobile.png")
    client.evaluate("""(async()=>{
      testCloud.setSession({user:null,admin:false});
      check(!document.body.classList.contains('can-edit'),'Visitante somente leitura');
      check(getComputedStyle(q('#add-shelf')).display==='none','Visitante sem cadastro');
      q('#shelves-nav').click();selectShelf(0);openSlot('A',1);
      check(q('#item-dialog').open&&q('#item-name').disabled,'Consulta abre sem edição');
      check(q('#item-name').value==='Cimento CP-2','Consulta mostra cadastro');
      check(getComputedStyle(q('#save-item')).display==='none','Salvar oculto');
      const writes=testCloud.writes;
      q('#item-name').disabled=false;q('#item-name').value='Tentativa';
      q('#item-form').dispatchEvent(new Event('submit',{cancelable:true}));
      await new Promise(r=>setTimeout(r,60));check(testCloud.writes===writes,'Manipular DOM não salva');
      q('[data-close="item-dialog"]').click();
      q('#account-button').click();q('#google-login').click();await until(()=>!q('#account-dialog').open);
      check(!document.body.classList.contains('can-edit'),'Login sozinho não concede edição');
      q('#account-button').click();check(q('#account-role').textContent==='Somente visualização','Perfil informa permissão');
      q('[data-close="account-dialog"]').click();
      testCloud.setSession({admin:true});check(document.body.classList.contains('can-edit'),'Administrador edita');
      openSlot('A',1);check(!q('#item-name').disabled,'Campos liberados ao administrador');
      testCloud.setSession({admin:false});check(!q('#item-dialog').open,'Revogação fecha edição');
      q('#account-button').click();q('#sign-out').click();await until(()=>!q('#account-dialog').open);
      check(q('#account-button').textContent==='Entrar','Saída da conta');
    })()""")
    client.screenshot("visitor-mobile.png")
    print("OK: visitante, usuário, administrador, tentativa de edição e revogação na interface.", flush=True)
    client.evaluate("""(async()=>{
      q('#warehouse-nav').click();check(getComputedStyle(q('#plan-edit')).display==='none','Visitante não organiza planta');
      testCloud.setSession({user:{uid:'test-admin'},admin:true});
      q('#remove-warehouse-photo').click();await until(()=>q('#confirm-dialog').open);q('#confirm-accept').click();
      await until(()=>!q('#warehouse-illustration').hidden);
      check(document.querySelectorAll('#warehouse-illustration .plan-rack').length===2,'Todas as prateleiras no desenho');
      check(document.querySelectorAll('#warehouse-illustration .plan-bay.filled').length===2,'Ocupação atual refletida no desenho');
      q('#warehouse-add').click();q('#shelf-name').value='Terceira prateleira';q('#shelf-form button[type=submit]').click();
      await until(()=>!q('#shelf-dialog').open);
      check(document.querySelectorAll('#warehouse-illustration .plan-rack').length===3,'Nova prateleira expande desenho');
      q('#plan-edit').click();
      const old=JSON.parse(localStorage.getItem('almox-test-record'));
      q('#warehouse-illustration .plan-rack').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
      await AlmoxCloud.saveState(old.state,old.revision);
      q('#plan-save').click();await until(()=>!q('#plan-save').disabled);
      check(!q('#plan-save').hidden&&q('#toast').textContent.includes('atualizado'),'Conflito mantém rascunho e não sobrescreve');
      q('#plan-cancel').click();
      q('#plan-edit').click();testCloud.setSession({admin:false});
      check(q('#plan-save').hidden&&!q('#warehouse-stage').classList.contains('editing-plan'),'Revogação cancela organização');
    })()""")
    client.call("Emulation.setDeviceMetricsOverride", {"width":1440,"height":1000,"deviceScaleFactor":1,"mobile":False})
    client.screenshot("warehouse-live.png")
    print("OK: planta com três prateleiras, ocupação real e permissão de organização.", flush=True)
    client.evaluate("""(async()=>{
      q('#history-nav').click();await until(()=>q('.history-entry'));
      check(!q('#history-view').hidden&&q('#shelf-view').hidden,'Página pública de histórico');
      check(q('#history-list').textContent.includes('admin@example.com'),'E-mail do autor visível');
      q('#history-kind').value='item';q('#history-kind').dispatchEvent(new Event('input'));
      q('#history-field').value='quantity';q('#history-field').dispatchEvent(new Event('input'));
      q('#history-action').value='update';q('#history-action').dispatchEvent(new Event('input'));
      check(document.querySelectorAll('.history-change').length>0,'Filtros combinados encontram edições');
      check(q('#history-list').textContent.includes('Quantidade'),'Antes e depois da quantidade');
      q('#history-person').value='inexistente';q('#history-person').dispatchEvent(new Event('input'));check(!q('.history-entry'),'Filtro por usuário');
      q('#history-clear').click();
      const image=q('[data-history-photo]');check(image,'Histórico registra fotos');image.click();
      await until(()=>!q('#history-photo-image').hidden);check(q('#history-photo-dialog').open,'Foto histórica abre');q('#history-photo-close').click();
      q('#history-from').value='2099-01-01';q('#history-from').dispatchEvent(new Event('input'));check(!q('.history-entry'),'Filtro de período');q('#history-clear').click();
    })()""")
    client.screenshot("history-desktop.png")
    client.call("Emulation.setDeviceMetricsOverride", {"width":390,"height":844,"deviceScaleFactor":1,"mobile":True})
    client.evaluate("check(document.documentElement.scrollWidth<=392,'Histórico cabe no celular');check(q('#history-mobile'),'Histórico no menu móvel');")
    client.screenshot("history-mobile.png")
    print("OK: histórico público, autores, comparação, filtros e imagens no computador e celular.", flush=True)
    if client.errors:
        raise AssertionError(json.dumps(client.errors, ensure_ascii=False))
    print("OK: responsividade a 390 px e nenhum erro JavaScript não tratado.", flush=True)
    print("TODOS OS TESTES DE NAVEGADOR PASSARAM. Capturas em .artifacts.", flush=True)
finally:
    if client:
        client.sock.close()
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
    server.shutdown()



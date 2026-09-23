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
      window.openSlot = (row, pos) => q('[data-row="'+row+'"][data-position="'+pos+'"]').click();
      window.setFile = (selector, text, name, type) => {const transfer=new DataTransfer(); transfer.items.add(new File([text],name,{type})); q(selector).files=transfer.files; q(selector).dispatchEvent(new Event('change',{bubbles:true}));};
      window.png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c=>c.charCodeAt(0));
    """
    client.evaluate(helper)
    client.evaluate("(async()=>{await until(()=>document.querySelectorAll('.slot').length===64);check(q('#occupied-count').textContent==='0','Estoque inicial vazio');check(q('#storage-warning').hidden,'IndexedDB disponível');})()")
    client.screenshot("desktop-empty.png")
    print("OK: inicialização e 64 posições.", flush=True)
    client.evaluate("""(async()=>{
      q('#warehouse-nav').click();
      await until(()=>q('.warehouse-plan-image').complete&&q('.warehouse-plan-image').naturalWidth>0);
      check(document.querySelectorAll('.plan-shelf').length===2,'Duas laterais na planta');
      q('[data-plan-add="esquerda"]').click();
      check(q('#shelf-name').value==='Prateleira esquerda','Cadastro pela lateral correta');
      q('[data-close="shelf-dialog"]').click();
    })()""")
    client.screenshot("warehouse-plan.png")
    client.call("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 1, "mobile": True})
    client.evaluate("check(document.documentElement.scrollWidth<=392,'Planta não estoura a página móvel');q('#warehouse-scroll').scrollLeft=210;")
    client.screenshot("warehouse-plan-mobile.png")
    client.call("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 1000, "deviceScaleFactor": 1, "mobile": False})
    client.evaluate("q('.plan-shelf[data-shelf]').click();check(!q('#shelf-view').hidden,'Planta abre estoque existente');")
    print("OK: planta ilustrada, cadastro pela lateral e navegação no estoque.", flush=True)

    client.evaluate("""(async()=>{
      openSlot('A',2);q('#item-name').value='Cimento CP-2';q('#item-quantity').value='5';q('#item-asset').value='PAT-001';
      q('input[name=span][value="2"]').click();
      setFile('#item-photo',png,'foto.png','image/png');await until(()=>!q('#item-photo-preview').hidden&&!q('#save-item').disabled);
      await save();check(q('#occupied-count').textContent==='2','Item grande ocupa duas posições');
      check(document.querySelectorAll('.slot').length===63,'Par unificado');check(q('.slot.full').textContent.includes('A1 + A2'),'Par correto ao clicar em A2');
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
      q('#edit-shelf').click();q('#zone-x').value='90';q('#zone-w').value='25';q('#shelf-form button[type=submit]').click();
      await until(()=>q('#shelf-error').textContent.length>0);check(q('#shelf-dialog').open,'Área inválida não salva');
      q('#zone-x').value='6';q('#shelf-form button[type=submit]').click();await until(()=>!q('#shelf-dialog').open);
    })()""")
    print("OK: foto real, múltiplas prateleiras e validação das áreas clicáveis.", flush=True)
    client.evaluate("""(async()=>{
      openSlot('C',8);q('#item-name').value='Cone';q('#item-quantity').value='8';q('#item-asset').value='P-02';await save();
      document.querySelector('#shelf-nav [data-shelf]').click();
      openSlot('A',2);q('#item-name').value='Cone';q('#item-quantity').value='5';q('#item-asset').value='P-01';await save();
      q('#items-nav').click();check(!q('#items-view').hidden,'Consulta de itens acessível');
      window.coneGroup=()=>[...document.querySelectorAll('.item-group')].find(group=>group.querySelector('.catalog-name strong').textContent==='Cone');
      check(coneGroup().querySelector('.catalog-total strong').textContent==='13 un','Total agrupado correto');
      check(coneGroup().textContent.includes('A2')&&coneGroup().textContent.includes('C8'),'Localizações preservadas');
      check(coneGroup().textContent.includes('P-01')&&coneGroup().textContent.includes('P-02'),'Patrimônios preservados');
      check(document.querySelector('.catalog-photo img'),'Foto aparece na consulta');
      q('#catalog-search').value='P-02';q('#catalog-search').dispatchEvent(new Event('input'));
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



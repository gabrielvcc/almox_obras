# Almox — controle de estoque por posições

Aplicativo web em HTML, CSS e JavaScript puro, sem dependências e sem backend. Os dados começam vazios; não há cadastros de demonstração misturados ao estoque.

## Abrir

Abra **index.html** no Chrome, Edge ou Firefox atualizado. Para um endereço local estável e comportamento consistente do armazenamento, também é possível executar:

    python -m http.server 8080 --bind 127.0.0.1

Depois acesse http://localhost:8080. Esse comando apenas entrega os arquivos; não existe backend de estoque. Use sempre o mesmo endereço/navegador para acessar os mesmos dados.

## Como usar

- Cada prateleira tem quatro andares, de **A (topo) a D (base)**.
- Cada andar tem oito módulos físicos, com duas posições cada: **A1/A2**, **A3/A4**, até **A15/A16**. Ao todo, são 64 posições.
- Clique em uma posição livre para cadastrar nome, quantidade, unidade, patrimônio, foto e observações.
- Selecione **Módulo inteiro** para reservar as duas posições do par. Isso só é permitido quando o par está disponível.
- Clique em um item para editar ou **Liberar posição**. Ao reduzir um módulo inteiro para uma posição, o item permanece na primeira posição do par.
- A busca encontra nome, patrimônio, posição e observações na prateleira atual. Os filtros esmaecem as posições que não correspondem, preservando a orientação espacial.
- Use **Visão do galpão** (ou clique na marca Almox) para alternar prateleiras e adicionar novas.
- O croqui ilustra o galpão com duas prateleiras laterais e entradas nas pontas. Clique nas prateleiras para abrir ou cadastrar.
- Em **Usar foto do galpão**, carregue sua foto real. Em **Editar prateleira**, ajuste esquerda, topo, largura e altura da área clicável usando a prévia. Os valores são percentuais.
- A visão do galpão é uma imagem com áreas interativas, não um ambiente 3D. A base permite evoluir para navegação panorâmica depois.

## Onde os dados ficam

A página **Itens** consulta todas as prateleiras e agrupa registros pelo mesmo nome e unidade. Maiúsculas/minúsculas e espaços excedentes são ignorados; modelos com nomes distintos e unidades diferentes ficam separados. Cada localização conserva seu patrimônio e quantidade. A consulta não cria um cadastro geral separado: alterações são feitas na posição correspondente. Use nomes completos para distinguir modelos diferentes.

O armazenamento usa IndexedDB no navegador. Reabrir a página no mesmo endereço e perfil conserva os dados. Fotos são reduzidas a até 1600 pixels e armazenadas junto ao cadastro; não são enviadas a serviços externos.

**Publicar o site não compartilha o estoque entre pessoas, computadores ou navegadores.** Para isso, uma próxima etapa deverá incluir banco de dados, autenticação e sincronização. A aplicação não mantém uma cópia remota.

Limpar os dados do navegador, usar navegação privada ou trocar de domínio/perfil pode remover ou separar seus cadastros. Os controles de exportação/importação estão removidos nesta fase de demonstração. Falhas de gravação continuam sendo informadas, sem avisos técnicos permanentes na interface.

Limites desta base: 30 prateleiras, 10 MB por arquivo de imagem antes da redução, 48 MB para o conjunto de dados (incluindo fotos). Quantidades podem ser fracionárias, entre 0,001 e 1 bilhão. Os totais exibidos contam posições e cadastros, sem somar unidades de medidas diferentes.

## Publicar na web

Envie os cinco arquivos abaixo para qualquer hospedagem estática com HTTPS:

    index.html
    styles.css
    galpao.svg
    inventory.js
    app.js

Não precisa instalar pacotes, executar um build ou contratar um servidor de aplicação. Não envie backups pessoais junto aos arquivos do site.

## Verificar

Requer Node.js 16 ou superior:

    node --check inventory.js
    node --check app.js
    node tests/inventory.test.js

O teste de navegador usa apenas Python 3 e uma instalação local de Chrome ou Edge:

    python tests/browser_check.py

Os testes verificam ocupação, pares, colisões, integridade dos dados, agrupamento dos itens e os fluxos reais no navegador. O navegador de teste usa um perfil separado em .artifacts; ele não acessa o estoque do navegador pessoal.



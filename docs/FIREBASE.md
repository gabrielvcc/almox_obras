# Conectar o Almox ao Firebase

O aplicativo usa um único estoque compartilhado. Visitantes e usuários comuns consultam os dados; administradores podem editar. O site continua estático, sem servidor no Render.

## 1. Preparar o projeto

No console Firebase:

1. Registre um aplicativo **Web** nas configurações do projeto.
2. Em **Authentication > Sign-in method**, habilite **Google** e escolha o e-mail de suporte.
3. Em **Authentication > Settings > Authorized domains**, adicione o domínio em que o site será publicado. Para testar no computador, adicione também `localhost` e/ou `127.0.0.1`, conforme o endereço utilizado.
4. Crie o **Cloud Firestore**, banco `(default)`, em modo de produção.
5. Publique as regras de `tests/firebase/firestore.rules`. As fotos usam o próprio Firestore; não é necessário habilitar Storage nem Blaze para esta versão, respeitadas as cotas do plano gratuito.

Referências: [login Google](https://firebase.google.com/docs/auth/web/google-signin) e [limites do Firestore](https://firebase.google.com/docs/firestore/quotas).

## 2. Informar a configuração pública

Substitua o `null` em `firebase-config.js` pelo objeto exibido pelo Firebase:

```js
window.ALMOX_FIREBASE_CONFIG = {
  apiKey: "COPIE_DO_CONSOLE",
  authDomain: "SEU_PROJETO.firebaseapp.com",
  projectId: "SEU_PROJETO",
  storageBucket: "COPIE_O_BUCKET_EXATO_DO_CONSOLE",
  messagingSenderId: "COPIE_DO_CONSOLE",
  appId: "COPIE_DO_CONSOLE"
};
```

Esse objeto é a configuração pública do aplicativo Web. Não coloque chave privada nem credencial de conta de serviço no site. A autorização fica nas regras do Firestore.

Enquanto a configuração não for preenchida, a interface permanece somente para consulta e informa que o estoque está indisponível. Nenhum cadastro anterior é apagado.

## 3. Publicar pelo painel

Cole as regras em **Firestore Database > Regras** e clique em **Publicar**. As regras já incluem a coleção `photos`. A cópia usada nos testes fica em `tests/firebase/firestore.rules`.

Publique o site na hospedagem estática habitual com `index.html`, `styles.css`, `inventory.js`, `firebase-config.js`, `firebase-client.js`, `app.js`, `photo-utils.js`, `history.js` e `warehouse-plan.js`. Preserve também o `CNAME` caso use domínio próprio no GitHub Pages. Não é necessário usar Firebase Hosting nem instalar ferramentas para publicar regras pelo painel.

No Firestore, é recomendável criar uma isenção de índices de campo único para `photos.data`, desabilitando os índices desse campo de imagem; ele não é usado em buscas.

## 4. Autorizar um administrador

1. Abra o site e entre com a conta Google desejada.
2. Em **Minha conta**, abra o identificador da conta e copie o UID. Também é possível consultá-lo em **Authentication > Users** no console.
3. No Firestore, crie a coleção `admins` e um documento cujo ID seja exatamente esse UID.
4. Nesse documento, adicione `enabled` do tipo **boolean**, com valor `true`.

A edição é liberada automaticamente para a conta autorizada. Para revogar, altere `enabled` para `false` ou exclua o documento. Nem mesmo administradores podem conceder permissões pelo aplicativo; essa gestão é feita no console.

Não é necessário criar documentos de estoque manualmente: o primeiro salvamento por um administrador cria a base compartilhada.

## Cadastros da versão anterior

Se o estoque compartilhado ainda estiver vazio e existirem cadastros no navegador usado antes, o administrador verá **Publicar cadastros anteriores** em Minha conta. A confirmação publica prateleiras, itens e fotos. A base anterior permanece preservada.

A migração precisa ser feita no mesmo navegador e endereço da versão anterior, pois o navegador separa dados por origem. Se você já começou um estoque compartilhado, essa importação não sobrescreve os novos dados.

## Organização dos dados

- `warehouses/main`: revisão, ordem das prateleiras e foto do galpão.
- `warehouses/main/shelves/{id}`: cada prateleira e seus itens.
- `admins/{uid}`: autorização de edição.
- `photos/{id}`: imagem compacta em base64. Nos cadastros fica apenas a referência `photo:ID`.

Os dados do estoque e suas fotos são públicos para consulta, inclusive patrimônios e observações, conforme o acesso solicitado. A lista de administradores não é pública.

Alterações chegam às outras sessões automaticamente. Se outra pessoa modificar o estoque durante uma edição, o salvamento é recusado e o cadastro deve ser reaberto para evitar sobrescrever dados. Sem conexão, a edição fica indisponível.

Fotos PNG, JPG e WebP de até 25 MB são convertidas no navegador para JPEG, com fundo branco, lado maior de até 1200 pixels e no máximo 260.000 caracteres de base64 (cerca de 190 KiB de imagem). A qualidade e as dimensões diminuem conforme necessário.

Foto e cadastro são salvos na mesma transação. As fotos anteriores são preservadas para permitir a consulta no histórico, inclusive após a exclusão de um item. As fotos são carregadas na leitura do estoque e mantidas em cache durante a sessão, evitando novas leituras a cada alteração de quantidade. URLs antigas do Storage permanecem compatíveis; novas fotos não usam o Storage.

Alterações muito grandes, como importar muitas fotos de uma vez, podem exigir etapas menores. O aplicativo limita o tamanho da transação para evitar ultrapassar o limite do banco.

## Testes

```sh
npm test
npm run test:rules
npm run test:browser
```

Os testes de regras usam somente o projeto fictício `demo-almox` nos emuladores locais e precisam de Java 21. Verificam leitura pública, escrita autorizada, impossibilidade de autopromoção, fotos, sincronização, conflito de revisões e revogação. O teste de navegador usa Python 3 e Chrome/Edge, com dados e perfis isolados. A interface usa um adaptador de teste; o adaptador Firebase real é verificado separadamente nos emuladores. Nenhum teste automatizado faz login em uma conta Google real.

Para servir o site no computador:

```sh
python -m http.server 8000
```

Abra `http://localhost:8000`. O login exige uma origem autorizada; abrir o HTML diretamente como arquivo não substitui essa etapa.

## Histórico de alterações

A página Histórico é pública e registra autor (UID, nome e e-mail do token autenticado), horário do servidor, cadastro afetado, localização e valores antes/depois. Abrange itens, prateleiras, disposição da planta, exclusões e fotos do galpão. Imagens antigas permanecem acessíveis e continuam ocupando espaço no banco.

Cada salvamento grava `history/{id}` na mesma transação que altera o estoque. `warehouses/main.historyId` vincula os documentos. As regras exigem essa ligação, validam a identidade e impedem editar/apagar registros pelo aplicativo. O conteúdo detalhado da comparação é calculado pelo cliente; este histórico não substitui auditoria das alterações manuais feitas pelo proprietário no console ou por credenciais administrativas.

Publique o conteúdo completo de `tests/firebase/firestore.rules` em Firestore > Regras, junto com a nova versão do site. Clientes antigos não conseguem salvar sem registrar o histórico. As contas em `admins` permanecem iguais. Nenhuma edição anterior à ativação é reconstruída.

São carregados 50 salvamentos por vez, mais recentes primeiro. Use Carregar registros anteriores para ampliar o período consultado; os filtros se aplicam aos registros já carregados. Atualizar busca novamente as entradas recentes. Fotos antigas só são lidas ao clicar em Ver imagem.

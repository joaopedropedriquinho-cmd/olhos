# Meus Olhos

Base web acessível e voice-first da plataforma **Meus Olhos**: uma pessoa pode pedir assistência visual por voz ou botão, receber uma resposta falada e conectar-se com um voluntário em tempo real. O reconhecimento de fala e a fala sintetizada usam as APIs disponíveis no navegador. A IA de visão ainda não está configurada: a aplicação informa isso claramente e nunca inventa o conteúdo de uma imagem.

## Requisitos

- Node.js 18 ou superior e npm.
- Não é necessário instalar ferramentas globais.

## Instalação e execução local

Na raiz do projeto, instale as dependências do backend:

```powershell
Set-Location .\server
npm install
```

Opcionalmente, copie `.env.example` para `.env` na raiz do projeto e ajuste as variáveis:

```powershell
Copy-Item ..\.env.example ..\.env
```

Os valores do exemplo servem apenas para desenvolvimento local.

Inicie o servidor a partir da pasta `server`:

```powershell
npm start
```

O serviço escuta em `0.0.0.0` e usa `PORT` do ambiente (porta `3000` como padrão local). O mesmo servidor entrega as páginas web e a API.

## Páginas e API

- Interface do usuário: <http://localhost:3000/user/>
- Painel do voluntário: <http://localhost:3000/volunteer/>
- Saúde do backend: <http://localhost:3000/api/health>
- API de pedidos: `/api/requests`

### Testar o backend

Com o servidor iniciado, verifique a saúde:

```powershell
Invoke-RestMethod http://localhost:3000/api/health
```

Crie um pedido:

```powershell
$pedido = Invoke-RestMethod `
  -Uri http://localhost:3000/api/requests `
  -Method Post `
  -ContentType 'application/json' `
  -Body (@{ userName = 'João'; type = 'visual_assistance' } | ConvertTo-Json)
$pedido.request
```

Liste os pedidos:

```powershell
Invoke-RestMethod http://localhost:3000/api/requests
```

Para aceitar, use o `id` retornado na criação:

```powershell
$id = $pedido.request.id
Invoke-RestMethod `
  -Uri "http://localhost:3000/api/requests/$id/accept" `
  -Method Post `
  -ContentType 'application/json' `
  -Body (@{ volunteerName = 'Voluntário' } | ConvertTo-Json)
```

Para cancelar um pedido ainda disponível:

```powershell
$pedidoParaCancelar = Invoke-RestMethod `
  -Uri http://localhost:3000/api/requests `
  -Method Post `
  -ContentType 'application/json' `
  -Body (@{ userName = 'Teste'; type = 'visual_assistance' } | ConvertTo-Json)
$idParaCancelar = $pedidoParaCancelar.request.id
Invoke-RestMethod -Uri "http://localhost:3000/api/requests/$idParaCancelar/cancel" -Method Post
```

Para verificar o fluxo em tempo real, abra as duas páginas em navegadores ou abas diferentes, crie um pedido na página do usuário e aceite-o no painel do voluntário.

## Acessibilidade, voz e permissões

A interface do usuário inclui botões grandes com foco visível, textos ampliados, regiões de estado anunciadas a leitores de tela, instruções faladas e alternativa visual para cada ação de voz. O fluxo:

1. Apresenta as permissões e informações de privacidade. A pessoa escolhe quando configurar microfone, câmera e notificações; notificações são opcionais e localização não é solicitada.
2. Solicita microfone e câmera por meio do navegador e encerra os fluxos de mídia logo após a verificação. Se uma permissão for negada, pedidos de ajuda continuam disponíveis pelos botões.
3. A pessoa toca **Falar agora** e diz um comando em português, como “Preciso de ajuda”, “Quero falar com um voluntário”, “O que está na minha frente?”, “Leia isso para mim” ou “Cancelar”. Também há o botão **Descrever uma imagem** para iniciar esse fluxo sem fala. A captura pede confirmação explícita antes de capturar/enviar uma imagem; a pessoa pode responder por voz ou pelos botões Sim/Não.
4. A captura é temporária e encaminhada ao endpoint de visão somente após consentimento. A implementação atual usa `MockVisionProvider`, não interpreta a imagem nem a guarda. Informa que não há IA configurada e pergunta se a pessoa quer chamar um voluntário. Confirmar cria o pedido existente; a aceitação é anunciada por voz.

O reconhecimento de fala depende de `SpeechRecognition`/`webkitSpeechRecognition` e da disponibilidade do navegador. Em navegadores sem suporte ou sem síntese de voz, os botões e mensagens acessíveis continuam disponíveis. O navegador pode processar fala usando seu próprio serviço; o projeto não grava nem persiste áudio. Microfone e câmera exigem contexto seguro (HTTPS ou localhost). Para a experiência no Render, use o domínio HTTPS fornecido. O navegador não consegue garantir que uma fala inicial automática seja reproduzida antes de uma interação; por isso há também o botão **Ouvir instruções**.

Essa página web não substitui a integração de permissões nativas do futuro app Android no MIT App Inventor. Essa etapa deverá solicitar as permissões pela plataforma Android e explicar qualquer uso antes de pedir acesso.

## Endpoints

| Método | Caminho | Descrição |
| --- | --- | --- |
| `GET` | `/api/health` | Retorna `{ "status": "ok" }` |
| `POST` | `/api/requests` | Cria pedido; recebe `userName`, `type` e, opcionalmente, `socketId` para notificar o solicitante |
| `GET` | `/api/requests` | Lista pedidos |
| `POST` | `/api/requests/:id/accept` | Aceita pedido pendente; nome opcional via `volunteerName` |
| `POST` | `/api/requests/:id/cancel` | Cancela pedido pendente |
| `POST` | `/api/assistant/vision` | Encaminha uma imagem JPEG consentida à camada de visão; o provedor atual responde indisponível, sem analisar ou guardar a imagem |
| `POST` | `/api/ai/analyze` | Analisa uma imagem JPEG, PNG ou WebP com Gemini e retorna uma descrição concisa em português |
| `POST` | `/api/mobile/request-help` | Cria pedido para o aplicativo Android |
| `GET` | `/api/mobile/request-status/:id` | Consulta estado atual e voluntário do pedido |
| `POST` | `/api/mobile/cancel/:id` | Cancela pedido Android ainda pendente |

Pedidos passam pelos estados `pending`, `accepted` e `cancelled`. Um pedido só pode ser aceito ou cancelado uma vez.

### Analisar uma imagem com IA

Configure `AI_API_KEY` no ambiente do backend (no Render, em **Environment**) com uma chave criada no [Google AI Studio](https://aistudio.google.com/apikey). O backend usa o modelo `gemini-3.8-flash` pela API REST oficial; não é necessário instalar um SDK Node.js. A cota gratuita não exige configurar cobrança, mas tem limites variáveis por projeto e modelo, visíveis no [AI Studio](https://aistudio.google.com/rate-limit). Não vincule uma conta de cobrança se quiser permanecer na faixa gratuita.

O serviço gratuito do Gemini pode usar entradas e respostas para melhorar produtos e pode permitir revisão humana. Não envie imagens pessoais, sensíveis ou confidenciais por essa faixa. Os termos do Gemini API também restringem aplicações destinadas ou provavelmente acessadas por menores de 18 anos. Confirme que o uso e as imagens de teste são compatíveis com os [termos atuais](https://ai.google.dev/gemini-api/terms).

Envie o arquivo bruto com `Content-Type: image/jpeg`, `image/png` ou `image/webp` (limite de 5 MiB), ou envie JSON com `imageDataUrl` em base64. As imagens são mantidas apenas em memória durante a requisição e não são gravadas em disco.

Exemplo no PowerShell, usando uma imagem local:

```powershell
$bytes = [IO.File]::ReadAllBytes(".\foto.jpg")
$dataUrl = "data:image/jpeg;base64," + [Convert]::ToBase64String($bytes)
$body = @{ imageDataUrl = $dataUrl } | ConvertTo-Json -Compress
Invoke-RestMethod `
  -Uri https://olhos-xnia.onrender.com/api/ai/analyze `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

Exemplo equivalente enviando os bytes da imagem:

```powershell
curl.exe --request POST `
  --url https://olhos-xnia.onrender.com/api/ai/analyze `
  --header "Content-Type: image/jpeg" `
  --data-binary "@foto.jpg"
```

Resposta de sucesso: `{"success":true,"description":"..."}`. Imagem inválida, indisponibilidade ou falta da chave retornam `success: false` e uma mensagem genérica. Se a Gemini API retornar limite/cota excedida (`429`), a rota responde `503` com `{"success":false,"message":"A IA está temporariamente indisponível. Tente novamente mais tarde."}`. A cota grátis tem limites variáveis por projeto e modelo; não configure faturamento ou recarga automática para manter o projeto na faixa gratuita.

## Integração Android com MIT App Inventor

O backend mantém os pedidos em memória, compartilhados pelas rotas web e mobile. No MIT App Inventor, configure um componente **Web** e use a URL base do servidor (local na mesma rede Wi-Fi durante desenvolvimento, ou o domínio HTTPS do Render quando publicado). A aplicação Android não precisa de API key.

### Criar pedido

Configure `Web.Url` para `https://SEU_SERVIDOR/api/mobile/request-help`, `Web.RequestHeaders` para `Content-Type: application/json`, e chame `Web.PostText` com:

```json
{"userName":"João","type":"visual_assistance"}
```

Exemplo PowerShell equivalente:

```powershell
Invoke-RestMethod `
  -Uri http://localhost:3000/api/mobile/request-help `
  -Method Post `
  -ContentType 'application/json' `
  -Body (@{ userName = 'João'; type = 'visual_assistance' } | ConvertTo-Json)
```

Resposta HTTP `201 Created`:

```json
{
  "success": true,
  "requestId": "UUID_DO_PEDIDO",
  "status": "pending",
  "message": "Seu pedido foi enviado. Estamos procurando um voluntário."
}
```

No evento `Web.GotText`, leia o JSON de resposta e guarde `requestId` para consultar ou cancelar. `userName` e `type` são opcionais; sem eles, o servidor usa `"Pessoa usuária"` e `"visual_assistance"`.

No MIT App Inventor, `Web.RequestHeaders` é uma lista de pares, por exemplo `make a list (make a list ("Content-Type", "application/json"))`. No bloco `Web.GotText(url, responseCode, responseType, responseContent)`, use `Web.JsonTextDecode(responseContent)` para obter a resposta JSON; para respostas com erro, confira também `responseCode`.

### Consultar estado do pedido

Use `Web.Url = https://SEU_SERVIDOR/api/mobile/request-status/UUID_DO_PEDIDO` e chame `Web.Get`. O app pode repetir a consulta com um componente `Clock` (por exemplo, a cada 5 segundos) até o estado mudar:

```json
{
  "success": true,
  "requestId": "UUID_DO_PEDIDO",
  "status": "accepted",
  "hasVolunteer": true,
  "volunteerName": "Ana",
  "message": "Ana aceitou ajudar você."
}
```

Enquanto aguarda, `status` será `"pending"`, `hasVolunteer` será `false` e `volunteerName` será `null`. Após cancelar, o status será `"cancelled"`. Um ID desconhecido retorna HTTP `404` e:

```json
{
  "success": false,
  "requestId": "ID_INEXISTENTE",
  "status": null,
  "hasVolunteer": false,
  "volunteerName": null,
  "message": "Pedido não encontrado."
}
```

### Cancelar pedido

Configure `Web.Url = https://SEU_SERVIDOR/api/mobile/cancel/UUID_DO_PEDIDO` e chame `Web.PostText` com `{}` (também pode ser enviado sem corpo):

```json
{
  "success": true,
  "requestId": "UUID_DO_PEDIDO",
  "status": "cancelled",
  "message": "Seu pedido foi cancelado."
}
```

Pedidos aceitos não podem ser cancelados por esta rota: o servidor responde HTTP `409 Conflict`, `success: false` e uma mensagem explicativa. IDs inexistentes respondem `404`; dados inválidos respondem `400`. Em todas as respostas de sucesso, `success` é `true`; em erros da API mobile é `false`.

Exemplos de erro:

```json
{"success":false,"message":"O nome deve ser um texto."}
```

```json
{"success":false,"requestId":"UUID_DO_PEDIDO","status":"accepted","message":"Este pedido não pode mais ser cancelado."}
```

### Atualizações em tempo real (opcional)

As requisições HTTP nativas do MIT App Inventor normalmente não enviam o cabeçalho `Origin`; o CORS do servidor permite esse caso nativo sem abrir a API a origens web arbitrárias. Se a tela estiver em WebViewer ou outra origem de navegador, configure `CORS_ORIGINS` no servidor para essa origem. Não use `*` em produção.

Polling com `Web.Get` é a opção simples e recomendada para começar no MIT App Inventor. Se futuramente usar uma extensão cliente Socket.IO compatível, conecte ao mesmo servidor com o papel `user`, envie o `socketId` da conexão no JSON de `request-help` e escute:

- `request_accepted` (compatível com o evento existente) e `request_status`;
- `request_cancelled` e `request_status`.

O evento `request_status` traz `requestId`, `status`, `hasVolunteer` e `volunteerName`. O pedido também continua emitindo `new_request` para os voluntários; a confirmação/cancelamento mantém os eventos existentes para não interromper o painel web. Sem um cliente Socket.IO no app, consulte `request-status/:id` periodicamente. A memória do servidor é reiniciada quando o processo reinicia, portanto o polling e os eventos não substituem uma persistência futura.

## Eventos em tempo real

O Socket.IO usa `new_request` para avisar os voluntários conectados, `request_accepted` para atualizar o solicitante e os painéis conectados e `request_cancelled` para remover pedidos cancelados. Conexões e desconexões de voluntários emitem `volunteer_online` e `volunteer_offline`.

## Estrutura do projeto

```text
.
├── server/
│   ├── server.js
│   ├── package.json
│   ├── package-lock.json
│   └── src/
│       ├── config.js
│       ├── realtime.js
│       ├── assistant/
│       │   ├── assistantRoutes.js
│       │   ├── mockVisionProvider.js
│       │   └── visionService.js
│       ├── mobile/
│       │   └── mobileRoutes.js
│       └── requests/
│           ├── inMemoryRequestRepository.js
│           ├── requestRoutes.js
│           └── requestService.js
├── user/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── volunteer/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── .env.example
├── .gitignore
└── README.md
```

## Variáveis de ambiente e CORS

As variáveis são carregadas do `.env` na raiz do projeto. `.env.example` não contém segredos:

- `PORT`: porta definida pelo ambiente de hospedagem.
- `NODE_ENV`: use `production` na hospedagem.
- `CORS_ORIGINS`: lista de origens permitidas separadas por vírgula. Em desenvolvimento, localhost e 127.0.0.1 são aceitos; em produção, configure as origens reais se frontend e API estiverem em domínios diferentes. A aplicação servida pelo mesmo domínio é reconhecida automaticamente.

## Publicação futura no GitHub

Crie um repositório vazio no GitHub e, na raiz deste projeto, configure o remoto e envie os arquivos:

```bash
git init
git add .
git commit -m "Cria base da plataforma Meus Olhos"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/meus-olhos.git
git push -u origin main
```

Troque `SEU_USUARIO` pelo seu usuário/organização e use a URL real do repositório. O arquivo `.gitignore` evita enviar `.env` e dependências instaladas.

## Publicação futura no Render

Crie um **Web Service** conectado ao repositório. Configure:

- **Root Directory:** `server`
- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Environment:** Node
- **Environment Variables:** `NODE_ENV=production`; configure `CORS_ORIGINS` somente se a interface estiver em outra origem.

O Render fornece `PORT` automaticamente. O servidor usa essa variável e escuta em `0.0.0.0`; não configure porta fixa na hospedagem. Como os arquivos `user/` e `volunteer/` ficam um nível acima do diretório do backend, mantenha-os no mesmo repositório/deploy.

## Armazenamento e preparação para Supabase

As rotas HTTP dependem de `RequestService`, que por sua vez usa um repositório com operações de criação, listagem, busca e atualização. `InMemoryRequestRepository` é a implementação atual e mantém os pedidos apenas enquanto o processo estiver ativo. Para migrar, implemente o mesmo contrato com Supabase e injete essa implementação no `server.js`; a API e as páginas não precisam conhecer o mecanismo de persistência. A associação temporária entre o socket do solicitante e o pedido fica isolada no módulo de tempo real, não no registro persistido.

## Arquitetura de IA e privacidade
`/api/assistant/vision` e `MockVisionProvider` permanecem inalterados. A nova rota `POST /api/ai/analyze` valida JPEG, PNG e WebP (até 5 MiB), envia a imagem em memória para Gemini e retorna uma descrição textual; não grava a imagem em disco. Mantenha `AI_API_KEY` apenas no backend. Na faixa gratuita, o provedor pode usar entradas para melhorar os serviços, portanto não envie imagens pessoais, sensíveis ou confidenciais e confira as restrições de idade nos termos vigentes.
#   o l h o s  
 #   o l h o s  
 #   o l h o s  
 
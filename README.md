# zaphelper

Assistente pessoal no WhatsApp. Monitora seu "chat pessoal" (mensagens que você manda pra você mesmo) e executa comandos começando com `/`. Também salva todas as mensagens recebidas (DMs, grupos, tudo) pra poder responder perguntas tipo "quantos leads foram agendados hoje?".

Construído com:
- **Backend:** Node.js 20 + TypeScript + Fastify + Prisma + PostgreSQL
- **WhatsApp:** [Evolution API](https://github.com/EvolutionAPI/evolution-api)
- **Frontend:** React + Vite + Tailwind + TanStack Query
- **Deploy:** Docker Compose (projetado pra rodar no EasyPanel/Hostinger VPS)

---

## Funcionalidades

### Comandos (v1)

| Comando | Descrição |
|---|---|
| `/statustoday` | Resume os leads agendados hoje no grupo "Be Home Leads Scheduled" (por pessoa e por fonte). |
| `/statusweek` | Idem, mas de segunda até agora. |
| `/reminder YYYY-MM-DD HH:MM <mensagem>` | Agenda um lembrete; o bot te manda a mensagem no seu self-chat. |
| `/reminders` | Lista lembretes ativos. |
| `/help` | Lista todos os comandos. |

Mande qualquer um deles pra você mesmo no WhatsApp e o bot responde.

### Dashboard web

- **Dashboard:** status da conexão, botão pra conectar via QR code, últimos comandos.
- **Mensagens:** navegador de todas as mensagens salvas, com filtro por chat/grupo.
- **Comandos:** lista dos comandos disponíveis + histórico de execuções.
- **Lembretes:** tabs com ativos / enviados / perdidos / cancelados.

### Extensibilidade

Cada comando é 1 arquivo em `backend/src/commands/`. Pra adicionar um novo:

1. Crie `backend/src/commands/<nome>.command.ts` exportando um objeto `Command`.
2. Importe e adicione em `backend/src/commands/registry.ts`.
3. Reinicie o container.

Ver [`help.command.ts`](./backend/src/commands/help.command.ts) como exemplo mínimo.

---

## Estrutura

```
zaphelper/
├── backend/                  # Fastify + Prisma + scheduler
│   ├── prisma/
│   │   └── schema.prisma
│   ├── src/
│   │   ├── server.ts         # entrypoint
│   │   ├── config.ts
│   │   ├── evolution/        # cliente Evolution API
│   │   ├── routes/           # webhook + dashboard API
│   │   ├── services/         # ingest, dispatcher, scheduler, lead-parser
│   │   ├── commands/         # 1 comando = 1 arquivo
│   │   ├── middleware/
│   │   └── utils/
│   └── Dockerfile
├── web/                      # Dashboard (Vite + React + Tailwind)
│   ├── src/
│   │   ├── pages/
│   │   ├── components/
│   │   └── api/
│   ├── nginx.conf            # proxy /api e /webhook pro backend
│   └── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## Desenvolvimento local

Requisitos: Node.js 20+, Docker (pra o PostgreSQL) ou um Postgres já rodando.

```bash
# 1. clone + instale
cd zaphelper
cp .env.example .env
# edite .env com valores de dev (DATABASE_URL apontando pra localhost, etc.)

# 2. instale dependências (npm workspaces)
npm install

# 3. suba só o postgres via docker
docker compose up -d postgres

# 4. rode as migrations
cd backend
npx prisma migrate dev

# 5. gere uma hash de senha pro admin
node -e "console.log(require('bcryptjs').hashSync('sua-senha', 12))"
# cole o resultado em .env como ADMIN_PASSWORD_HASH

# 6. rode backend + web em paralelo (na raiz do projeto)
cd ..
npm run dev
```

- Backend: http://localhost:3000
- Web: http://localhost:5173 (proxy-ado pra API do backend)
- Webhook de dev: use [ngrok](https://ngrok.com/) ou similar pra expor `http://localhost:3000/webhook` pro Evolution API.

### Rodar os testes do lead parser

```bash
cd backend
npm test
```

---

## Deploy passo-a-passo (Hostinger VPS + EasyPanel)

Essas instruções assumem que você vai começar do zero. Se já tem VPS/EasyPanel/Evolution API, pule para a seção apropriada.

### 1. Provisione a VPS na Hostinger

1. Acesse https://www.hostinger.com/vps-hosting e compre um plano. Recomendado: **KVM 2** ou superior (2 vCPU, 8 GB RAM, 100 GB SSD).
2. Na criação, escolha:
   - **Sistema operacional:** Ubuntu 22.04 LTS
   - **Localização:** mais perto de você ou do Evolution API (latência importa pro webhook)
3. Anote o IP público e a senha root que a Hostinger envia.
4. Conecte via SSH: `ssh root@SEU_IP_VPS`

### 2. Instale o EasyPanel

```bash
curl -sSL https://get.easypanel.io | sh
```

O instalador mostra a URL do painel e credenciais iniciais. Acesse em `https://SEU_IP_VPS` (HTTPS self-signed — aceite o aviso).

### 3. Configure DNS e domínio

1. No seu provedor de DNS, crie um registro A:
   - `zaphelper.seudominio.com` → IP da VPS
   - (opcional) `evolution.seudominio.com` → IP da VPS
2. Espere a propagação (normalmente 1-5 minutos).
3. No EasyPanel: **Settings → Domains**, adicione `zaphelper.seudominio.com`. O EasyPanel provisiona SSL via Let's Encrypt automaticamente.

### 4. Suba o Evolution API (se ainda não tiver)

Se você já tem um Evolution API rodando, pule para o passo 5.

No EasyPanel:

1. **Project** → **+ Create** → nome: `evolution`
2. **+ Service** → **App** → **Image** → `atendai/evolution-api:latest`
3. Variáveis de ambiente mínimas:
   ```
   AUTHENTICATION_API_KEY=gere-uma-chave-longa-aqui
   DATABASE_ENABLED=true
   DATABASE_PROVIDER=postgresql
   DATABASE_CONNECTION_URI=postgresql://user:pass@seu-postgres:5432/evolution
   CONFIG_SESSION_PHONE_CLIENT=zaphelper
   QRCODE_LIMIT=10
   ```
4. **Ports:** expose port `8080`.
5. **Domains:** adicione `evolution.seudominio.com` e redirecione para porta `8080` (SSL automático).
6. **Deploy**. Confira que `https://evolution.seudominio.com/manager` abre.

**Guarde:** a URL (`https://evolution.seudominio.com`) e o `AUTHENTICATION_API_KEY` — vão pro `.env` do zaphelper.

### 5. Prepare os segredos

Em qualquer máquina com Node.js:

```bash
# JWT_SECRET
openssl rand -hex 32

# POSTGRES_PASSWORD
openssl rand -hex 24

# ADMIN_PASSWORD_HASH (substitua "minhasenha123" pela sua)
npx bcryptjs-cli hash minhasenha123 12
# ou
node -e "console.log(require('bcryptjs').hashSync('minhasenha123', 12))"
```

Guarde os três valores.

### 6. Suba o zaphelper via Compose no EasyPanel

**Opção A — Git (recomendado):**

1. Suba este repositório para GitHub/GitLab.
2. No EasyPanel: **Project** → **+ Create** → nome: `zaphelper`
3. **+ Service** → **Compose**
4. **Source:** GitHub, aponte pro repositório e branch.
5. **Compose file:** `docker-compose.yml`
6. Clique em **Environment** e cole todas as variáveis do `.env.example`, trocando pelos valores reais:

   ```
   POSTGRES_USER=zaphelper
   POSTGRES_PASSWORD=<hex gerado no passo 5>
   POSTGRES_DB=zaphelper

   EVOLUTION_API_URL=https://evolution.seudominio.com
   EVOLUTION_API_KEY=<chave do Evolution do passo 4>
   EVOLUTION_INSTANCE_NAME=zaphelper-main

   WEBHOOK_URL=https://zaphelper.seudominio.com/webhook

   ADMIN_USER=admin
   ADMIN_PASSWORD_HASH=<hash bcrypt do passo 5>
   JWT_SECRET=<hex gerado no passo 5>

   BE_HOME_LEADS_GROUP_NAME=Be Home Leads Scheduled
   SELF_PHONE_NUMBER=
   TZ=America/New_York
   COOKIE_SECURE=true
   WEB_PORT=8080
   ```
7. **Deploy.** Acompanhe os logs dos três containers (`postgres`, `backend`, `web`). Sinais de sucesso:
   - `postgres`: `database system is ready to accept connections`
   - `backend`: `Scheduler started` + `zaphelper listening`
   - `web`: nginx startup

**Opção B — Upload do compose:**

Se preferir não usar Git, você pode copiar o conteúdo de `docker-compose.yml` e colar na opção **Compose → Paste YAML**. Você ainda precisa subir as pastas `backend/` e `web/` de alguma forma (git, rsync, ou usando imagens pré-buildadas).

### 7. Conecte o EasyPanel domain ao serviço `web`

No projeto `zaphelper` do EasyPanel:

1. Clique no serviço `web` → **Domains** → **+ Add**
2. Domínio: `zaphelper.seudominio.com`
3. **HTTPS:** habilitado (Let's Encrypt automático)
4. **Target port:** `80`
5. Salve.

Aguarde 30-60s. Acesse `https://zaphelper.seudominio.com` — você deve ver a tela de login.

### 8. Conecte seu WhatsApp

1. Entre no dashboard com `admin` + a senha que você escolheu no passo 5.
2. No card **WhatsApp**, clique em **Conectar WhatsApp**.
3. Um QR Code aparece.
4. No seu celular: **WhatsApp → Configurações → Aparelhos conectados → Conectar um aparelho → escaneie**.
5. Aguarde 5-10 segundos. O badge vira **Conectado** e aparece o número detectado.

O zaphelper chama `fetchInstances` no Evolution automaticamente e descobre seu número — não precisa preencher `SELF_PHONE_NUMBER`.

### 9. Teste!

No seu chat pessoal do WhatsApp (o "Eu mesmo"), mande:

```
/help
```

Deve voltar uma lista com todos os comandos. Depois:

```
/reminder 2026-04-14 09:00 Testar o zaphelper
```

Em seguida:

```
/reminders
```

E no dia/hora marcada, você vai receber o lembrete. ✅

---

## Troubleshooting

### "Webhook não dispara"

- Confirme que `https://zaphelper.seudominio.com/webhook` é acessível publicamente:
  ```bash
  curl -X POST -H "Content-Type: application/json" -d '{}' https://zaphelper.seudominio.com/webhook
  # deve retornar {"ok":true,"ignored":"malformed"}
  ```
- No Evolution API Manager, confira que o webhook do seu instance tem a URL correta e os eventos `MESSAGES_UPSERT` e `CONNECTION_UPDATE` estão marcados.
- No backend, rode `docker compose logs -f backend` e mande uma mensagem no WhatsApp — deve aparecer.

### "Comandos não executam"

- Cheque se o dashboard mostra seu número em **Dashboard → WhatsApp**. Se não mostrar, clique em **Conectar WhatsApp** e re-escaneie, ou chame `POST /api/instance/refresh-identity`.
- Certifique que está mandando no self-chat (seu próprio número), não num grupo.
- Confira os logs do backend — cada comando gera um `CommandLog` no DB e aparece na página **Comandos**.

### "/statustoday retorna 0 leads"

- O filtro é case-insensitive e usa `contains`. Verifique o nome exato do grupo na página **Mensagens** (filtre por tipo=grupos) e ajuste `BE_HOME_LEADS_GROUP_NAME` no `.env`. Precisa redeployar depois.
- O timezone (`TZ`) afeta o limite "hoje". Se seus leads da noite aparecem como "ontem", ajuste `TZ`.

### "Lembretes não disparam"

- Confira a lista em **Lembretes** — o status deve ser `PENDING`.
- Logs do backend devem mostrar `Scheduler started` no boot, seguido pelo log `Reminder sent` quando o lembrete dispara.
- Se o container reiniciou depois do horário marcado, o lembrete dispara com prefixo `[Missed]`.

### "Prisma migrate falhou no boot"

- Os logs do backend mostram o erro. Normalmente é um conflito de migration — entre no container (`docker compose exec backend sh`) e rode `npx prisma migrate status`.
- Pra resetar tudo (⚠️ apaga dados): `npx prisma migrate reset`.

---

## Adicionando um comando novo

Exemplo: `/ping` que responde "pong":

1. Crie `backend/src/commands/ping.command.ts`:
   ```typescript
   import type { Command } from "./types.js";

   export const pingCommand: Command = {
     name: "ping",
     description: "Responde pong.",
     async execute(ctx) {
       return { success: true, reply: `pong (${ctx.now.toISOString()})` };
     },
   };
   ```

2. Importe e registre em `backend/src/commands/registry.ts`:
   ```typescript
   import { pingCommand } from "./ping.command.js";

   export const allCommands: Command[] = [
     // ...
     pingCommand,
   ];
   ```

3. Rebuild e redeploy. Mande `/ping` no self-chat.

Qualquer comando pode acessar `ctx.prisma`, `ctx.evolution`, `ctx.scheduler`, e `ctx.config` — então dá pra fazer coisas muito além de respostas estáticas (consultar mensagens, agendar novos jobs, chamar APIs externas, etc).

---

## Variáveis de ambiente

Ver `.env.example` — todas comentadas.

| Variável | Obrigatória | Descrição |
|---|---|---|
| `DATABASE_URL` | sim | URL PostgreSQL (gerada automaticamente pelo compose). |
| `EVOLUTION_API_URL` | sim | URL do Evolution API (sem barra no final). |
| `EVOLUTION_API_KEY` | sim | `AUTHENTICATION_API_KEY` do Evolution. |
| `EVOLUTION_INSTANCE_NAME` | não | Nome do instance. Default: `zaphelper-main`. |
| `WEBHOOK_URL` | sim | URL pública que Evolution vai chamar. Termina em `/webhook`. |
| `ADMIN_USER` | não | Usuário do dashboard. Default: `admin`. |
| `ADMIN_PASSWORD_HASH` | sim | Hash bcrypt da senha. |
| `JWT_SECRET` | sim | String random ≥32 chars. |
| `BE_HOME_LEADS_GROUP_NAME` | não | Nome (ou substring) do grupo de leads. |
| `SELF_PHONE_NUMBER` | não | Seu número (auto-detectado se vazio). |
| `TZ` | não | Timezone. Default: `America/New_York`. |
| `COOKIE_SECURE` | não | `false` pra dev sem HTTPS. |
| `WEB_PORT` | não | Porta do container web. Default: `8080`. |

---

## Gotchas conhecidos

1. **Evolution API webhook precisa de HTTPS público válido.** Sem isso o WhatsApp não entrega eventos.
2. **Self-chat precisa do seu JID.** Auto-detectado ao conectar, mas se falhar, preencha `SELF_PHONE_NUMBER` no `.env`.
3. **Timezone afeta `/statustoday` e `/statusweek`.** Se você mora no fuso de NY mas deixou `TZ=UTC`, leads das 19h aparecem no dia errado.
4. **Lembretes >24 dias no futuro** dependem do sweep diário (`setTimeout` não aceita delays maiores que 2^31 ms). Funciona, mas não mostra no log até 24h antes.
5. **Dedupe de webhook** é feito por `waMessageId` único. Se o Evolution re-entrega o mesmo evento (retries), o segundo insere falha e o handler retorna 200 sem processar.
6. **Container restart durante um lembrete** faz ele virar `[Missed]` — dispara imediatamente com prefixo diferente. Sem perdas silenciosas.

---

## Roadmap / ideias futuras

- `/cancel <N>` para cancelar um lembrete pelo número da lista.
- `/schedule` para agendar envio de mensagem para contato específico.
- Multi-lead parsing (mensagem com vários leads separados por linha em branco).
- Export CSV dos leads da semana.
- Integração com Google Calendar (criar evento via `/event`).

---

## Licença

Privado — uso pessoal.

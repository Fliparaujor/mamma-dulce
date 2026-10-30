# Histórias Publisher

Painel para planejar e publicar os episódios do @istoriasbrasileiras em Instagram Reels, TikTok e YouTube Shorts (pela API oficial do Buffer) e no Kwai (fluxo manual assistido). Roda inteiro na Cloudflare, sem servidor ligado o tempo todo: um Worker serve a API e o painel, o D1 guarda o calendário, o R2 guarda os vídeos e um Cron Trigger cuida da fila.

A ideia central é simples. Os 60 episódios do mês ficam no D1. O Buffer Free só aceita 10 posts agendados por canal, então o agendador manda ao Buffer apenas os próximos e repõe as vagas conforme os posts saem.

## O que está pronto

Login de administrador único, com sessão em cookie `HttpOnly; Secure; SameSite=Strict`, token CSRF em toda escrita, checagem de origem e bloqueio depois de 5 senhas erradas em 15 minutos (20 no total).

Biblioteca com upload múltiplo (arrastar no computador, seletor no celular), progresso por arquivo, validação de extensão, tipo, tamanho e da assinatura MP4/MOV, detecção de duplicados por impressão digital e conversão dos arquivos em episódios com série e número detectados pelo nome (`Historia_01_Ep01.mp4`, `Lenda do Boto parte 2.mp4`, `S01E04.mp4`).

Upload direto ao R2 por URL pré-assinada (multipart com partes de 20 MB acima de 95 MB) quando as credenciais S3 do R2 estão configuradas. Sem elas, o envio passa pelo Worker em streaming, também em partes. O vídeo nunca é carregado inteiro na memória do Worker.

Entrega pública dos vídeos em `/media/<id>/<token>.mp4`, pelo próprio Worker, com `HEAD`, `Range` (206/416), `ETag` e token aleatório por arquivo que não expira. É o link que o Buffer recebe.

Editor de episódio com legenda geral ou por rede, hashtags gerais, por série e por rede, título do YouTube, contador de caracteres com os limites que o Buffer aplica e prévia do texto final. Edição em lote (série, modo de legenda, legenda, hashtags, redes ligadas).

Gerador de calendário: dias, horários (12h e 19h por padrão, editáveis), redes, pré-visualização antes de gravar, ordem da história preservada, horários passados e ocupados pulados, nenhum episódio duplicado por rede (garantido também por índice único no banco). Visão mensal e semanal, reagendamento individual, por episódio e deslocamento da sequência em N dias.

Integração com o Buffer: teste de conexão, escolha da organização, mapeamento dos canais de Instagram, TikTok e YouTube, criação de posts com `createPost` em modo `customScheduled` e `dueAt`, Reel no Instagram (`metadata.instagram.type = reel`), título e categoria obrigatórios no YouTube, reagendamento com `editPost`, cancelamento com `deletePost`, leitura de status e erros.

Fila inteligente (detalhes abaixo), monitoramento com histórico de tentativas, reprocessamento seguro, modo simulação (dry-run), pausa do abastecimento, fluxo manual do Kwai com agenda `.ics` assinável, página de uso e custos, limpeza de mídia antiga que nunca apaga vídeo com publicação pendente.

## Como a fila funciona

O cron dispara a cada 15 minutos, mas o agendador só fala com o Buffer quando o intervalo configurado vence (60 minutos por padrão). Em cada execução:

1. Pega uma trava no D1. Se outra execução estiver rodando, sai sem fazer nada.
2. Marca como "Requer atenção" o que passou do horário sem ter ido para o Buffer. Nada é enviado atrasado.
3. Com a sincronização inteligente ligada, só consulta o Buffer se algo pode ter mudado: post cujo horário passou, envio pendente de confirmação, vaga livre com episódio esperando, ou 6 horas sem consultar.
4. Lê no Buffer os posts que ocupam vaga (`scheduled`, `sending`, `needs_approval`), inclusive os criados fora do app. Essa é a ocupação real de cada canal.
5. Reconcilia: `sent` vira Publicado (com data e link), `error` vira Falhou com a mensagem do Buffer, lembrete vencido vira Ação manual, post apagado no Buffer vira Requer atenção.
6. Abastece as vagas livres com as próximas publicações de cada rede, na ordem da história, respeitando o limite por execução e o orçamento de requisições.

O `createPost` do Buffer não tem chave de idempotência. Por isso a publicação passa para "Enviando" numa troca atômica antes da chamada. Se a resposta se perder, a execução seguinte procura o post pelo canal e pelo `dueAt` e adota o ID. Só depois de 10 minutos sem encontrá-lo a publicação volta para a fila. Os testes cobrem os dois casos (resposta perdida depois de criar, falha antes de chegar).

Estados exibidos: Planejado no sistema, Enviando ao Buffer, Agendado no Buffer, Ação manual necessária, Publicado, Falhou, Requer atenção, Cancelado. "Agendado no Buffer" nunca é tratado como publicado.

## O que não é suportado (limites reais)

Kwai: existe a Kuaishou Open Platform, com escopo de publicação de vídeo, mas não consegui confirmar que ela atende contas do Kwai no Brasil. O app não usa bots, cookies nem endpoints privados. O fluxo é manual: fila do dia, legenda pronta, botão de compartilhar o vídeo direto para o app (Web Share no Android), confirmação explícita e histórico. O módulo está isolado em `worker/kwai/` para receber uma integração oficial se ela for confirmada.

TikTok: o Buffer lista TikTok entre os serviços e aceita `metadata.tiktok`, mas se o post sai automático ou por notificação depende da conta e das permissões. O app envia `schedulingType: automatic` e mostra o tipo que o Buffer devolver. Se vier `notification`, o post vira "Ação manual" no horário e só conta como publicado quando o Buffer informar `sent` ou `markedAsPublished`.

YouTube Shorts: a API do Buffer não tem campo "Short". O YouTube decide pelo vídeo (vertical ou quadrado e curto). O app avisa quando o vídeo é horizontal ou passa de 3 minutos.

Notificação push nativa: exigiria serviço pago ou mais infraestrutura. Em troca há a agenda `.ics` (assinável no Google Agenda, com alarme e legenda) e o aviso do navegador enquanto o painel está aberto.

Métricas de desempenho dos posts não foram implementadas.

## Custo mensal estimado

Premissas: 60 vídeos por mês de 30 a 80 MB cada (2 a 5 GB), retenção de 30 dias com limpeza ligada, 3 canais no Buffer Free, domínio gratuito `workers.dev`.

| Serviço | Uso estimado | Franquia gratuita | Custo |
| --- | --- | --- | --- |
| Workers | ~96 disparos de cron por dia + uso do painel + downloads do Buffer | 100.000 requisições/dia | US$ 0 |
| D1 | poucos milhares de linhas lidas/escritas por dia | 5 GB, 5 mi leituras e 100 mil escritas/dia | US$ 0 |
| R2 armazenamento | 2 a 6 GB | 10 GB-mês | US$ 0 |
| R2 operações | centenas (classe A) e poucos milhares (classe B) | 1 mi A e 10 mi B por mês | US$ 0 |
| Buffer | plano Free | 3 canais, 10 agendados por canal | US$ 0 |

Nas premissas acima o custo fica em zero. Não é garantido para sempre. Os riscos concretos:

- Passar de 10 GB no R2: US$ 0,015 por GB-mês excedente (100 GB a mais custariam cerca de US$ 1,35). Vídeos longos ou em 4K, ou desligar a limpeza, chegam lá rápido.
- A Cloudflare costuma pedir um meio de pagamento para ativar o R2, mesmo no uso gratuito. Com cartão cadastrado, o excedente é cobrado automaticamente.
- No plano Free do Workers, estourar 100 mil requisições por dia não gera cobrança: as requisições passam a falhar até a meia-noite UTC.
- Buffer: o plano Free limita a API a 150 requisições por 15 minutos, 600 por dia e 1.000 por canal a cada 30 dias (até 3.000). O teto diário do app (90 por padrão) e a sincronização inteligente existem para ficar longe disso. Se ligar o intervalo de 15 minutos sem a sincronização inteligente, o limite de 30 dias estoura.
- Domínio próprio custa à parte e não é necessário.

A página "Uso e custos" do painel mostra os números medidos pelo app.

## Desenvolvimento local

Requisitos: Node 20 ou mais novo.

```sh
cd historias-publisher
npm install
cp .dev.vars.example .dev.vars
npm run hash-password            # cole a saída em ADMIN_PASSWORD_HASH no .dev.vars
npm run db:migrate:local
npm run dev                      # compila o painel e sobe o Worker em http://localhost:8787
```

Para mexer só no painel com recarga instantânea, deixe `npx wrangler dev` rodando e use `npm run dev:web` (porta 5173, com proxy para a API).

Sem `BUFFER_API_KEY` tudo funciona menos o envio ao Buffer. Para ver o fluxo de envio sem publicar nada, ligue o "Modo simulação" em Configurações.

Verificações:

```sh
npm run lint
npm run typecheck
npm test          # testes no runtime real dos Workers (D1 e R2 locais), com Buffer falso
npm run build
npm run check     # tudo acima em sequência
```

## Colocar em produção

Nada abaixo compra serviço. O único passo que pode pedir cartão é a ativação do R2 no painel da Cloudflare.

1. Crie uma conta na Cloudflare e faça login no Wrangler:

   ```sh
   npx wrangler login
   ```

2. Crie o banco e copie o `database_id` exibido para o `wrangler.jsonc`:

   ```sh
   npx wrangler d1 create historias-publisher
   ```

3. Ative o R2 no painel (R2 Object Storage) e crie o bucket:

   ```sh
   npx wrangler r2 bucket create historias-publisher-media
   ```

   Não ative o acesso público `r2.dev`: os vídeos são servidos pelo Worker.

4. Aplique as migrations:

   ```sh
   npm run db:migrate:remote
   ```

5. Faça o primeiro deploy para descobrir o endereço `workers.dev`:

   ```sh
   npm run deploy
   ```

   Copie o endereço (`https://historias-publisher.SEU-SUBDOMINIO.workers.dev`) para `vars.PUBLIC_BASE_URL` no `wrangler.jsonc`.

6. Grave os segredos:

   ```sh
   npm run hash-password
   npx wrangler secret put ADMIN_PASSWORD_HASH
   npx wrangler secret put BUFFER_API_KEY
   ```

7. Opcional, para upload direto do navegador ao R2 (recomendado para vídeos grandes): no painel, R2 → Manage R2 API Tokens → crie um token com permissão "Object Read & Write" só para o bucket. Depois:

   ```sh
   npx wrangler secret put R2_ACCOUNT_ID
   npx wrangler secret put R2_ACCESS_KEY_ID
   npx wrangler secret put R2_SECRET_ACCESS_KEY
   cp r2-cors.example.json r2-cors.json    # troque o endereço pelo seu workers.dev
   npx wrangler r2 bucket cors set historias-publisher-media --file r2-cors.json
   ```

   O CORS precisa expor o cabeçalho `ETag`, senão o envio em partes falha.

8. Deploy final:

   ```sh
   npm run deploy
   ```

### Checklist do Buffer

1. Conta no Buffer com Instagram (conta profissional), TikTok e YouTube conectados. O Free aceita 3 canais.
2. publish.buffer.com → Settings → API → criar chave. Ela vai só para o segredo `BUFFER_API_KEY`.
3. No painel: Redes conectadas → Testar conexão → escolher a organização → Sincronizar canais.
4. Conferir se algum canal aparece como desconectado, bloqueado, com fila pausada ou "publicação por lembrete".
5. Deixar o limite de 10 posts por canal (só aumente se mudar de plano no Buffer).
6. Ligar o modo simulação, rodar "Sincronizar" no Dashboard e ler o histórico de uma publicação.
7. Desligar a simulação e acompanhar a primeira execução real em Publicações.

### Verificação pós-deploy

```sh
curl https://historias-publisher.SEU-SUBDOMINIO.workers.dev/healthz
```

A resposta deve ter `"ok": true` com `database`, `storage`, `migrations` e `adminPasswordConfigured` verdadeiros. Depois: entrar no painel, enviar um vídeo, abrir o link dele numa aba anônima (precisa tocar sem login), gerar um calendário de 1 dia, rodar "Sincronizar" com a simulação ligada e conferir o histórico. Os logs ficam em Workers → historias-publisher → Logs (observability está ligada no `wrangler.jsonc`), e credenciais são mascaradas antes de sair no log.

## Backup e recuperação

```sh
npm run db:backup        # gera backups/AAAA-MM-DD-HHMM.sql com o banco de produção
```

O arquivo tem calendário, episódios, legendas e histórico, sem senhas nem chaves. Guarde fora do computador. O D1 também tem Time Travel (restauração a qualquer minuto dos últimos 30 dias no plano pago, 7 dias no gratuito, segundo a documentação da Cloudflare):

```sh
npx wrangler d1 time-travel info historias-publisher
npx wrangler d1 time-travel restore historias-publisher --timestamp=2026-11-01T12:00:00Z
```

Para restaurar um backup num banco novo: `npx wrangler d1 execute historias-publisher --remote --file=backups/ARQUIVO.sql`.

Os vídeos ficam só no R2. Mantenha os arquivos originais no seu computador ou na nuvem enquanto houver publicação pendente; o app não faz cópia dos vídeos.

## Estrutura

```
worker/            API, agendador e entrega de mídia (Cloudflare Worker)
  buffer/          cliente GraphQL do Buffer (só campos da referência oficial)
  scheduler/       reconciliação, abastecimento, trava, limpeza
  kwai/            módulo do fluxo manual do Kwai (+ agenda .ics)
  services/        mídia/R2, publicações, canais
  routes/          rotas HTTP
shared/            lógica usada no servidor e no painel (fuso, calendário, legendas, nomes de arquivo)
web/               painel React + Vite + Tailwind (componentes no estilo shadcn/ui, ícones Lucide)
migrations/        esquema do D1
test/              testes Vitest no runtime dos Workers + Buffer falso
scripts/           hash de senha e backup
```

## Segurança

Segredos só como secrets da Cloudflare; o painel nunca recebe a chave do Buffer nem as credenciais do R2. Sessões guardadas como hash SHA-256 do token. Senha em PBKDF2-SHA256 com 10.000 iterações por padrão: medi cerca de 8 ms de CPU por login no runtime dos Workers, dentro dos 10 ms do plano Free (100.000 iterações gastam ~70 ms e só cabem no plano pago; gere com `npm run hash-password -- --iterations 100000` se migrar). Por isso use uma senha longa. Todas as entradas passam por schemas zod. O app não guarda senhas de Instagram, TikTok, Google ou Kwai e não automatiza login em redes sociais.

# Fase 7 — publicação da outbox e recuperação

`OutboxModule` publica os eventos já confirmados em `wagering.outbox_events` na
fila separada `wager-events.fifo`. O núcleo financeiro e a criação dos eventos
continuam os mesmos; HTTP e SQS gravam a outbox na transação financeira existente.

## Estado persistente e claim

A migration `Migration20261005070000` acrescenta `attempts`, `last_attempt_at`,
`next_attempt_at`, `last_error`, `lease_token`, `lease_owner` e `lease_until`.
`published_at` continua nulo enquanto não há confirmação de envio e gravação
válida da publicação. Campos de lease são todos nulos ou todos preenchidos.
Outbox já existente é imediatamente elegível; eventos anteriormente publicados
permanecem publicados. Esses metadados são manipulados por SQL explícito no store,
sem alterar as entidades/mappers financeiros ou impedir testes de migrations
históricas anteriores à Fase 7.

O claim usa uma transação curta: selecionar eventos pendentes e vencidos com
`FOR UPDATE SKIP LOCKED`, incrementar tentativas e gravar UUID de lease, owner e
prazo. Até cinco eventos são enviados em paralelo por publisher. Não existe lock
de wallet/transação nesse fluxo. O envio SQS começa depois do commit do claim.

O lease padrão é 30s e recebe renovação a cada um terço desse prazo. Renovação,
confirmação e retry adquirem o lock da outbox sem esperar (`SKIP LOCKED`) e então
verificam token, publicação nula e prazo usando o relógio PostgreSQL. Assim, uma
espera de lock não permite confirmar um lease que expirou durante a espera.
Worker antigo não renova, confirma ou reagenda um token substituído/expirado.

Após SendMessage retornar `MessageId`, a confirmação SQL grava `published_at` e
limpa o lease. Um lease expirado pode ser reassumido por qualquer instância.
Não há chamada SQS no callback da transação financeira; heartbeat/publicação
usam um fluxo independente. Eventos não confirmados no banco nunca são visíveis
ao claim. A auditoria da outbox impede DELETE, mudança de identidade/payload e
retorno de publicado para pendente.

## Pelo menos uma vez e identidade

Não há commit distribuído entre PostgreSQL e SQS:

- Crash depois do commit financeiro, antes do claim/envio: o evento fica pendente.
- Crash durante o lease, antes do envio: outro worker reassume após expiração.
- Crash depois do envio, antes de `published_at`: outro worker republica.

Todas as tentativas usam **o mesmo `eventId` e o mesmo payload persistido**.
`MessageDeduplicationId` é o `eventId`; `MessageGroupId` é o `data.walletId`.
A FIFO elimina envios repetidos dentro de sua janela de cinco minutos. Após essa
janela, pode ocorrer nova entrega. A garantia de efeito único vem da deduplicação
persistente do consumidor, não da memória do processo nem somente da FIFO.
O publisher não reconstrói eventos nem chama factories para obter novos IDs.

O contrato é entrega pelo menos uma vez, não publicação exatamente uma vez.
Não se promete ordem financeira total entre publishers: o consumidor mínimo
apenas registra fatos por identidade e não aplica novamente dinheiro.

## Retry

Backoff: 1s, 2s, 4s, 8s, 16s, depois 30s, mantendo esse teto. `next_attempt_at`
é calculado no PostgreSQL; `attempts` e `last_attempt_at` ficam persistidos.
Falha de envio registra `SQS_SEND_FAILED`; falha ao confirmar depois do envio
registra `PUBLICATION_CONFIRMATION_FAILED`, quando o banco permite essa gravação.
Se o banco também estiver indisponível, o lease persistido expira e permite
recuperação. Nenhum limite de tentativas apaga ou abandona o evento.
Uma fila/configuração restaurada permite publicar o mesmo registro em retry.

## Consumidor mínimo

O único efeito é um recibo auditável em `integration_event_receipts`:
`consumer_name`, `event_id`, `payload_hash`, `event_type`, `payload`, `consumed_at`.
A PK `(consumer_name,event_id)` serializa consumidores concorrentes. INSERT
ON CONFLICT não altera o recibo existente; o hash canônico confirma a igualdade
do conteúdo. O ack só ocorre depois do commit. Crash entre commit e ack produz
replay, sem outro recibo. Os recibos não permitem UPDATE/DELETE.

Não há novo domínio, alteração de saldo ou integração de negócio downstream.
Payload inválido ou mesmo eventId com conteúdo incompatível fica sem ack; o
recibo original é preservado. Tratamento completo de mensagens inválidas/DLQ de
eventos não faz parte deste consumidor mínimo.

## Configuração e lifecycle

- `OUTBOX_PUBLISHER_ENABLED=true`.
- `EVENT_CONSUMER_ENABLED=true`.
- `SQS_EVENT_QUEUE_NAME=wager-events.fifo` (distinta das filas de comandos/DLQ).
- `OUTBOX_LEASE_MS=30000` (100–300000).

Compose encaminha essas variáveis. O inicializador LocalStack cria a FIFO de
eventos com visibility 30s e retenção 14 dias. Os dois loops são independentes.
Shutdown interrompe polling/novos claims, aguarda a rodada ativa pelo prazo
`SQS_SHUTDOWN_TIMEOUT_MS` e depois aborta o trabalho pendente. Leases não
concluídos expiram; mensagens sem ack retornam por visibility. O cliente SQS é
destruído somente no hook final da aplicação.

## Provas automatizadas

`bun run test:outbox` usa PostgreSQL e LocalStack reais e cobre:

- disputa de uma outbox entre publishers e claims disjuntos em três processos;
- worker morto antes do envio e após envio real, antes de gravar publicação;
- lease expirado, token antigo, heartbeat e confirmação sem espera de lock;
- retry/backoff persistente, recuperação após mais de cinco falhas e marcador indisponível;
- ausência de publicação antes do commit e progresso HTTP durante envio pausado;
- consumidores independentes disputando republicação, crash antes do ack e restart;
- restart de todos os processos com eventos pendentes e conservação dos IDs;
- saldo reconstruído pelo ledger, sem efeito financeiro do consumidor de eventos.

Cada teste cria e remove apenas seus bancos/filas aleatórios. O harness desliga
publishers/consumidores de eventos nas suítes das fases anteriores, mantendo suas
expectativas de outbox ainda não publicada. Pausas antes/depois do SDK e visibility
de 1s existem exclusivamente no entry point de testes. Para provar deduplicação
além da janela FIFO sem esperar cinco minutos, os testes enviam o mesmo payload e
eventId com outro deduplication ID de transporte; o publisher real continua usando
sempre o eventId como deduplication ID.

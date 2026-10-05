# Arquitetura — Fases 0, 1, 2, 3 e 4

## Escopo implementado

Bootstrap NestJS executado por Bun 1.4.2, TypeScript strict, PostgreSQL 17,
MikroORM 6.5.8, SQS no LocalStack Community 4.0.3 e Docker Compose.
O domínio financeiro puro está em src/domain, sem imports de NestJS, ORM ou
infraestrutura. A Fase 2 persiste wallets e abertura auditável via POST /wallets.
A Fase 3 processa operações via POST /wagering/transactions com lock por wallet,
idempotência persistente, resposta original e outbox na mesma transação SQL.
A Fase 4 testa concorrência HTTP com três processos Bun independentes, restart,
stress controlado e locks observados diretamente no PostgreSQL.
Ainda não há autenticação, consumidor, inbox, publisher ou workers de negócio.

A migration 20261005000000 cria o schema wagering; 20261005020000 cria as três
tabelas financeiras, constraints, índices e proteção do ledger. A migration
20261005030000 acrescenta resultados originais e outbox. O histórico de migrations
fica em public; migrations executam em transação. O rollback não usa CASCADE. O search_path da conexão fica em public para
impedir que o schema homônimo do usuário receba o histórico.
O serviço migrate executa uma vez antes da aplicação no Compose.

## Executar

Requisitos: Bun 1.4.2 e Docker com Compose v2 ou superior. Copiar .env.example para .env
é opcional: os defaults locais são equivalentes. Credenciais são apenas locais.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test:smoke
bun test test/unit
docker compose up -d --wait postgres localstack
bun run migration:up
bun run check:infra
bun run test:integration
bun run test:concurrency
docker compose up -d --build --wait app
```

Health: GET /health/live e GET /health/ready, sem autenticação.
Readiness retorna 503 se PostgreSQL ou alguma das três filas não estiver acessível.
A aplicação precisa conectar ao PostgreSQL para inicializar; liveness não consulta
dependências após o bootstrap.

```sh
bun run migration:list
bun run migration:down
bun run migration:up
docker compose logs app localstack
docker compose down
```

migration:down deve ser usado no ambiente local descartável. Não remove tabelas
de fases posteriores por CASCADE. Integração usa serviços reais e deve rodar
com filas locais sem consumidores nem mensagens de negócio.

O teste migration-lifecycle cria um banco vazio isolado com nome aleatório,
verifica UP/DOWN/UP e UP repetido, e remove somente esse banco ao finalizar.
Ele exige permissão CREATEDB (disponível no usuário local do Compose).
DOWN da migration financeira remove suas três tabelas, índices, trigger e função,
preservando o schema. DOWN da migration anterior remove o schema wagering.
Antes desses dois rollbacks, DOWN da Fase 3 remove outbox e campos de resultado.
Após os três rollbacks, o histórico fica vazio; a tabela de controle em public
permanece por desenho do MikroORM. O teste exercita rollback com dados reais.

Bun deve estar no PATH global; não existe instalação local de runtime em .tools.

## Configuração

PORT; DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD;
AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY; SQS_ENDPOINT.
Portas e endpoint são validados antes da inicialização. Senhas não são logadas.
Bun carrega .env automaticamente. Dentro do Compose, variáveis explícitas
substituem host/endpoint locais pelos nomes dos serviços.

SQS_ENDPOINT_STRATEGY=path e o endpoint do SDK permitem usar LocalStack tanto
pelo host como pela rede Docker. As filas são criadas por um ready hook.
Readiness do container só passa depois do hook criar as filas e configurar DLQ.
A fila de comandos tem maxReceiveCount=5, visibilidade de 30s e retenção de 4 dias;
DLQ retém por 14 dias. Esses parâmetros serão exercitados na fase de mensageria.
A fila adicional wager-events.fifo será o destino de eventos da outbox.

## Versões e limitações

Dependências diretas têm versões exatas e transitivas ficam no bun.lock.
MikroORM 6 evita introduzir mudanças de ESM da versão 7 neste bootstrap.
LocalStack Community tem tag fixa, sem depender da distribuição latest.
Imagens possuem tags de versão; não há pin por digest nesta fase.
O smoke test verifica Nest/HTTP isoladamente; a integração exige PostgreSQL e SQS reais.
Logs e métricas completos pertencem à fase de observabilidade.

## Ajustes aprovados para as próximas fases

Priorizar PKs, FKs, UNIQUEs, CHECKs, índices e transações. Não implementar
constraint triggers diferidos complexos nem proteção especial de TRUNCATE.
Um trigger simples de bloqueio UPDATE/DELETE do ledger foi adicionado na Fase 2.

Money usa bigint em centavos no domínio, com parsing/serialização por strings.
Nenhuma quantia monetária passará por number. Contratos HTTP/SQS terão duas
casas decimais e a persistência será exata. Money foi implementado na Fase 1.

Idempotência já tem UNIQUE(idempotency_key),
UNIQUE(provider_id, external_transaction_id) e payloadHash. Replay e resultado
original persistido pertencem à fase de processamento. O replay de PENDING será
mantido simples, com a decisão contratual
documentada quando esse fluxo for implementado.

Autenticação não vale pontos e será omitida, com porta de identidade explícita
na fase correspondente e desenho de integração futura com IdP externo.
Implementação avança somente mediante aprovação, uma fase por vez.

## Domínio financeiro — Fase 1

Na Fase 1 o domínio foi implementado isoladamente. A Fase 2 o conecta à aplicação
por mappers e factories, mantendo src/domain sem dependências externas.

### Money

Centavos são bigint privado; parsing usa BigInt diretamente sobre os dígitos.
Nenhuma quantia passa por number. from exige formato canônico não negativo,
sem zeros à esquerda, com exatamente duas casas (ex.: 0.00, 25.10).
Não há arredondamento. rehydrate aceita sinal negativo para valores internos
como diferenças de reconciliação; Wallet e transações não aceitam saldo/valor
negativo. -0.00 interno é normalizado para 0.00. A moeda tem formato de três
letras maiúsculas; não há catálogo completo ISO-4217 nem conversão cambial.
Todas as operações binárias, inclusive equals, exigem a mesma moeda.
Objetos Money são congelados; serialização sempre devolve strings decimais.

### Wallet e ledger

Wallet.open mantém saldo inicial e version=1. openingMovement descreve o crédito
de zero ao saldo inicial quando positivo, sem incrementar a versão; a aplicação
o associa à transação interna OPENING e ao ledger na mesma SQL na Fase 2.
rehydrate restaura saldo, versão e datas sem gerar novo movimento de abertura.
debit/credit retornam um WalletBalanceChange congelado com walletId, direção,
money, balanceBefore, balanceAfter e walletVersion. A aplicação poderá criar
WalletLedgerEntry com esses fatos, id, transactionId e timestamp.
Valores zero não alteram saldo, versão ou updatedAt e não geram movimento/ledger.
Movimentos rejeitados preservam todo o estado anterior. Versões usam number
inteiro seguro apenas como metadado, nunca como dinheiro.

WalletLedgerEntry.create e rehydrate validam moedas, saldos não negativos,
valor positivo e aritmética exata. São imutáveis, sem transições. Datas recebidas
e devolvidas pelas entidades são copiadas defensivamente.
Unicidade player+currency e um ledger por transação/wallet são garantidos no
banco na Fase 2, com atomicidade da abertura. Controle de concorrência entre
apostas pertence à fase de processamento; o domínio não executa SQL.

### Transações e política

create aceita operações externas e nasce em PENDING. OPENING só entra pela
factory createOpening, com identidade interna e valor positivo, ou rehydrate.
A entrada externa futura deverá usar create, sem expor createOpening.
A política recusa aplicar OPENING à wallet já aberta para evitar crédito duplo.
matchesPayload compara o hash fornecido; hashing canônico e replay persistente
pertencem à aplicação futura, não a este núcleo.

Transições válidas:

| Origem | Destino | Condição |
|---|---|---|
| PENDING / PENDING_REFERENCE | PROCESSED | referência interna resolvida se houver referência externa; data válida |
| PENDING / PENDING_REFERENCE | PENDING_REFERENCE | existe referência externa; repetição permitida |
| PENDING / PENDING_REFERENCE | REJECTED | failureCode conhecido |
| PENDING / PENDING_REFERENCE | FAILED | failureCode conhecido |
| PROCESSED / REJECTED / FAILED | nenhum | toda tentativa lança InvalidTransactionStateError |

rehydrate não executa transições nem reaplica política: reconstrói estado,
validando formas impossíveis (ex.: PROCESSED sem processedAt ou rejeição sem
código) e invariantes estruturais.

WageringPolicy.evaluate é pura e retorna APPLY, PENDING_REFERENCE ou REJECT.
Não debita, credita, altera status nem publica eventos. BET debita, WIN credita,
LOSS apenas registra resultado. Zero é permitido em operações externas e é
processado sem efeito no saldo ou ledger, inclusive BET/WIN.
WIN pode ter referência opcional a BET e seu valor pode diferir do da aposta.
BET/LOSS não aceitam referência. REFUND exige BET; ROLLBACK aceita BET, WIN ou
REFUND e inverte a direção. Reversões são integrais, sem valores parciais.

A referência deve ter o id externo solicitado, mesmo provider/player/wallet,
moeda e rodada. gameId não faz parte da igualdade exigida no README.
Referência ausente ou ainda PENDING/PENDING_REFERENCE retorna espera;
REJECTED/FAILED, kind indevido, autorreferência e identidades divergentes são
inválidos. Expiração de espera e backoff não são implementados nesta fase.
processedReversals recebe fatos carregados pela aplicação; uma reversão já
PROCESSED da mesma referência e mesmo kind causa DUPLICATE_REVERSAL.
REFUND e ROLLBACK são tipos distintos, conforme regra explícita do README.
A Fase 2 inclui índice único parcial por referência/kind PROCESSED; aplicação
geral das reversões e controle de concorrência pertencem à fase de processamento.

### Códigos estáveis

| Código | Significado |
|---|---|
| INVALID_AMOUNT | formato/escala/sinal inválido para o contrato |
| INVALID_CURRENCY | moeda fora do formato de três letras maiúsculas |
| CURRENCY_MISMATCH | operação entre moedas diferentes |
| INVALID_WALLET_STATE | saldo, versão, identificadores ou data inválidos |
| INSUFFICIENT_BALANCE | BET ou débito direto sem saldo |
| REVERSAL_INSUFFICIENT_BALANCE | reversão de crédito produziria saldo negativo |
| INVALID_LEDGER_ENTRY | fatos ou aritmética inválidos |
| INVALID_TRANSACTION | metadados, kind ou valor inválidos |
| INVALID_TRANSACTION_STATE | transição proibida ou estado persistido inconsistente |
| OPENING_INTERNAL_ONLY | tentativa externa de OPENING ou aplicação duplicada da abertura |
| REFERENCE_REQUIRED | contrato de reversão sem referência |
| REFERENCE_NOT_FOUND | reservado para rejeição após expiração futura da espera |
| INVALID_REFERENCE | identidade, kind, estado ou vínculo inválido |
| REFERENCE_AMOUNT_MISMATCH | reversão diferente do valor integral original |
| DUPLICATE_REVERSAL | referência já revertida pelo mesmo tipo |
| WALLET_MISMATCH | wallet/player diferente do agregado carregado |
| PAYLOAD_CONFLICT | reservado para conflito de idempotência na aplicação futura |
| PERMANENT_INFRASTRUCTURE_FAILURE | marcador auditável de FAILED; classificação futura na aplicação |

### Eventos e testes

IntegrationEvent é envelope abstrato, com subclasses WagerTransactionProcessed,
WagerTransactionRejected, WagerTransactionPendingReference e WalletBalanceChanged.
Factories verificam o status/fatos aplicáveis; dados são snapshots congelados,
datas ISO e MoneyProps com quantias em string. LOSS processado tem evento de
resultado, mas não evento de mudança de saldo. Não existe publisher, registro
automático, outbox ou integração com SQS. Publicação futura somente após commit.

```sh
bun run typecheck
bun test test/unit/domain
```

Os testes são puros, sem NestJS, ORM, PostgreSQL ou SQS. Cobrem precisão grande,
parsing, moedas, imutabilidade, factories, movimentos/ledger, referências,
reversões, ausência de saldo e estados terminais.

## Schema e abertura auditável — Fase 2

### Persistência exata e entidades

WalletEntity, WagerTransactionEntity e WalletLedgerEntryEntity são classes de
persistência separadas, no schema wagering. Money não recebe decorators nem
tipos de ORM. Mappers reconstroem domínio exclusivamente por rehydrate.
IDs internos são UUID; player/provider/round/game e ids externos são texto.

Dinheiro usa NUMERIC sem precisão/escala fixa: NUMERIC(p,2) arredondaria entradas
SQL com mais casas antes do CHECK. Os CHECKs exigem valores finitos, não negativos
e scale <= 2; ledger exige amount > 0. Leituras SQL com escala 0/1 são normalizadas
para duas casas por strings e bigint. ExactMoneyType mantém valor, hidratação e
comparação como strings, sem DecimalType (que compara convertendo para number).
O limite de magnitude é o limite nativo de NUMERIC do PostgreSQL, sem arredondamento.
version é BIGINT com intervalo 1..9007199254740991 e conversão para number apenas
como metadado inteiro seguro; o ORM não incrementa versão automaticamente.

### Constraints e índices

| Objeto | Garantia |
|---|---|
| wallets | PK id; UNIQUE(player_id,currency); moeda válida; balance >= 0; versão inteira segura >= 1 |
| wager_transactions | PK id; UNIQUE idempotency_key e provider/external; kinds/status/codes válidos; valor exato não negativo |
| wallet_ledger_entries | PK id; UNIQUE(wallet_id,transaction_id); direção válida; valor positivo; saldos não negativos; before +/- amount = after |
| FK transação/wallet | walletId, playerId e moeda correspondem à mesma wallet |
| FK referência | id interno, id externo, provider, player, wallet, moeda e rodada correspondem à mesma referência |
| FK ledger/transação | wallet, moeda, valor, kind e status correspondem à mesma transação |
| Checks ledger | só PROCESSED; exclui LOSS; BET exige DEBIT, OPENING/WIN/REFUND exigem CREDIT; ROLLBACK admite inversão |
| Índice único parcial de reversões | uma reversão PROCESSED por referenceTransactionId + kind |

Transações PROCESSED têm processed_at; demais estados não. REJECTED/FAILED têm
failure_code conhecido; demais estados não. REFUND/ROLLBACK exigem referência
externa. Referência interna só aparece em PROCESSED, é diferente do próprio id
e resolve a referência externa. OPENING reserva provider internal, id externo
igual ao id interno, idempotency key por wallet, rodada/game internos e amount > 0.
Não há ON DELETE CASCADE. UNIQUEs adicionais suportam as FKs compostas.

Índices (wallet_id,created_at,id) suportam histórico estável de transações/ledger.
Há índices para ledger por transaction_id, referência interna e referências
pendentes por provider/id externo/data. A UNIQUE provider/external serve à
resolução da referência externa. DDL manual das migrations é autoritativo;
schema.update/schema.create automáticos não substituem constraints e triggers.

### Ledger imutável

Um único trigger BEFORE UPDATE OR DELETE, por linha, sempre lança SQLSTATE 55000,
inclusive em update sem mudança. Repositório de ledger só expõe append e leitura.
O trigger também protege SQL direto. Não existe constraint trigger diferido,
proteção especial de TRUNCATE ou promessa contra administradores que desabilitem
triggers. O rollback de migration remove tabelas na ordem de dependência, sem
CASCADE; é destrutivo e deve ser usado somente no ambiente descartável.

### Unidade de trabalho e abertura

FinancialUnitOfWork e TransactionManager são portas da aplicação. O adaptador
MikroOrmTransactionManager cria EntityManager fork isolado por chamada e usa
transactional(). Repositórios são construídos com esse mesmo manager e fazem
flush explícito em ordem wallet -> transação -> ledger. Flush não é commit:
qualquer erro no callback ou commit causa rollback de toda a unidade de trabalho.
Nenhuma entidade de persistência vaza pelas portas para o domínio.

OpenWallet valida Money antes de abrir a transação. Saldo zero grava só wallet.
Saldo positivo grava wallet com version=1, OPENING PROCESSED e ledger CREDIT
de 0.00 ao saldo inicial na mesma transação. A OPENING usa SHA-256 de JSON com
chaves fixas em ordem alfabética: currency, initialBalance, playerId, walletId.
Não há publicação de eventos ou registros inbox/outbox nesta fase.

A UNIQUE de player/currency é a fonte da verdade para duplicação; não se usa
precheck suscetível a corrida. Apenas a violação dessa constraint é convertida
em WalletAlreadyExistsError. Demais erros de banco propagam e fazem rollback.

POST /wallets recebe {playerId,initialBalance:{amount,currency}} e retorna
{id,playerId,balance:{amount,currency},version}. HTTP 201 só após commit;
409/WALLET_ALREADY_EXISTS para duplicação; 400 para corpo inválido ou erro de
Money/domínio. Erros inesperados recebem o tratamento 500 padrão do Nest,
sem retornar detalhes SQL. Autenticação permanece omitida conforme decisão aprovada.

### Verificação e limites

```sh
bun run typecheck
bun test test/unit
bun run test:integration
```

phase2-open-wallet usa um banco vazio isolado no PostgreSQL real do Compose e o
módulo HTTP de produção. Testa abertura zero/positiva, precisão muito acima do
limite seguro de number, conflito, HTTP e rollback após falha no INSERT do ledger.
Uma função/trigger exclusiva do teste provoca essa falha depois dos flushes de
wallet/OPENING; contagens independentes comprovam ausência de registros parciais.
SQL direto exercita PKs, UNIQUEs, FKs, CHECKs, aritmética e UPDATE/DELETE bloqueados.
migration-lifecycle testa dois ciclos completos com dados e reaplicação idempotente.
Fixtures removem apenas seus bancos de nome aleatório; exigem CREATEDB.

Não há use case de BET/WIN/LOSS/REFUND/ROLLBACK, consumidor SQS, publisher outbox
ou locking entre apostas. A coerência global de saldo com soma do ledger depende
da unidade transacional da aplicação; SQL administrativo ainda pode inserir dados
isolados que respeitem checks locais. Kind/status/valor da referência e a direção
exata de ROLLBACK são validados pela política de domínio, a ser conectada na fase
de processamento. Não foram adicionados triggers de consistência global.

## Processamento, lock e idempotência — Fase 3

### Contrato e reutilização

ProcessWagerTransactionUseCase depende somente das portas da aplicação e domínio.
O adaptador HTTP em src/wagering chama execute(payload, idempotencyKey, context).
Não há chamadas a SQS, fetch ou publisher no caso de uso ou nos repositórios.
Um futuro adaptador SQS poderá usar o mesmo caso de uso sem depender do controller.

POST /wagering/transactions exige Idempotency-Key único, ASCII visível, sem vírgula,
até 200 bytes. Identificadores textuais também são limitados a 200 bytes, sem
espaços nas extremidades ou caracteres de controle. walletId é UUID normalizado
para minúsculas. Campos desconhecidos são recusados; money.amount exige string
decimal não negativa com exatamente duas casas (até 1000 caracteres).
OPENING e provider internal não são aceitos externamente. REFUND/ROLLBACK exigem
referenceExternalTransactionId. WIN admite a referência opcional a BET já
prevista na política de domínio. X-Correlation-Id é opcional.

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "tx-123",
  "playerId": "player-1",
  "walletId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  "roundId": "round-1",
  "gameId": "game-1",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

Resposta: {transactionId,status,balance:{amount,currency},failureCode?,idempotentReplay}.
HTTP 200 para PROCESSED; 202 para PENDING_REFERENCE; 422 para REJECTED.
400 indica payload/header inválido ou wallet inexistente, sem registros parciais.
409 distingue IDEMPOTENCY_CONFLICT e EXTERNAL_TRANSACTION_CONFLICT.
503/INFRASTRUCTURE_UNAVAILABLE indica falha transitória, incluindo lock timeout,
deadlock, serialização, indisponibilidade de conexão ou esgotamento do pool.
Erros inesperados recebem 500 sem exposição de SQL pelo controller.
Resposta de sucesso/rejeição só sai depois de commit concluído.

### Hash canônico e resultado original

SHA-256 é calculado sobre UTF-8 deste JSON compacto, em ordem fixa alfabética;
money também tem chaves fixas. Referência ausente vira null. Nenhum timestamp,
id interno gerado, Idempotency-Key ou metadado de transporte participa do hash.

```json
{"externalTransactionId":"tx-123","gameId":"game-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"player-1","providerId":"provider-a","referenceExternalTransactionId":null,"roundId":"round-1","walletId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}
```

result_http_status SMALLINT e result_body JSONB preservam o status lógico e o
corpo completo, incluindo saldo observado, moeda e failureCode. Mesmo key/hash
retorna esse snapshot com apenas idempotentReplay=true, sem consultar a wallet,
reavaliar a política ou gerar ledger/eventos. O saldo de replay não acompanha
movimentos posteriores. O snapshot de PENDING_REFERENCE continuará sendo 202
mesmo se uma fase futura resolver a referência e mudar o estado atual.
Um trigger simples bloqueia alteração/remoção dos campos de resultado já definidos.
CHECK valida formato, status lógico, transactionId, dinheiro como string e flag false.
Os campos são nulos em OPENING/histórico anterior; não se inventa resposta retroativa.

### Lock, conflitos e atomicidade

Cada execução usa fork isolado do MikroORM e transação READ COMMITTED. Após
precheck de key/identidade externa, findOne com PESSIMISTIC_WRITE em wallets
executa SELECT FOR UPDATE. O lock permanece até commit/rollback. O repositório
recusa saveLocked sem aquisição prévia do lock naquela unidade de trabalho.
O precheck é repetido após adquirir o lock para ver o commit do detentor anterior.
Wallets distintas não compartilham um lock global. lock_timeout=5s e
statement_timeout=15s limitam espera; o cliente pode repetir a mesma key após 503.

UNIQUE(idempotency_key) e UNIQUE(provider_id,external_transaction_id) permanecem
a fonte da verdade. Colisões reais entre wallets distintas abortam a transação
perdedora, incluindo seu update de saldo; somente depois do rollback uma nova
unidade de trabalho lê o vencedor e retorna replay ou o conflito 409 apropriado.
Não se continua usando uma transação PostgreSQL já abortada nem se faz retry
automático de efeitos financeiros. A key tem precedência na classificação de conflito.

Sob o lock, a política verifica referência por provider/id externo, player, wallet,
moeda, rodada, kind, status e valor completo de reversão. Reversões PROCESSED
são consultadas sob o mesmo lock; a UNIQUE parcial referenceTransactionId/kind
é uma proteção adicional. Reversão duplicada do mesmo tipo é REJECTED.
Referência ausente ou ainda pendente persiste PENDING_REFERENCE, sem movimento.
Provider diferente não resolve a referência e permanece pendente.
Nenhum worker de resolução foi adicionado.

Saldo/version, transação/resultado, ledger e outbox usam o mesmo EntityManager
e commit. LOSS, valor zero, rejeições e referências pendentes não mudam version
nem criam ledger. Rejeições por player/moeda incompatível são auditadas: FK
wallet_id exige wallet existente; FK composta usa colunas geradas nulas somente
em REJECTED, mantendo a correspondência obrigatória nos demais estados.
O ledger permanece sujeito às constraints e ao trigger imutável da Fase 2.

### Outbox persistida

outbox_events armazena UUID do evento, transaction_id com FK, aggregate_id,
event_type, version, envelope JSONB, occurred_at, created_at e published_at nulo.
CHECK valida identidade do envelope; UNIQUE(transaction_id,event_type) evita
repetição de um tipo por transação. Índice parcial cobre eventos não publicados.
Eventos: WagerTransactionProcessed, WagerTransactionRejected,
WagerTransactionPendingReference e WalletBalanceChanged somente quando saldo muda.
Abertura positiva também persiste Processed + WalletBalanceChanged no mesmo
commit de wallet/OPENING/ledger; abertura zero não cria eventos.
Não há publisher, timer ou operação de publicação no repositório.
Dados anteriores à Fase 3 não recebem backfill de eventos.

### Validação e limites desta fase

```sh
bun run typecheck
bun test test/unit
bun run test:integration
bun test test/integration/phase3-concurrency.test.ts --timeout 30000
```

Integração usa bancos descartáveis no PostgreSQL real do Compose e o módulo HTTP
de produção. Inclui operações, replay preservando saldo original, conflitos,
referências, falhas SQL entre update/ledger e no insert de outbox, invisibilidade
antes de commit e proteção do snapshot. Concorrência usa conexões/transações
independentes: duas BET de 80 sobre 100, dez submissions idênticas, reversões,
colisões entre wallets e prova de backend aguardando lock no pg_stat_activity.
O rendezvous dos testes apenas sincroniza transações reais; não substitui banco,
locks ou persistência por mocks. UP/DOWN/UP é exercitado com OPENING, BET,
ledger, resultado e outbox; migrations anteriores não foram reescritas.

DOWN da Fase 3 restaura a FK composta antiga e apaga outbox/resultados. Se houver
rejeições com player/moeda divergentes, essa restauração falha e todo o DOWN
faz rollback, preservando os dados; não se apagam auditorias para forçar downgrade.
Use DOWN apenas em banco descartável e valide compatibilidade dos dados.
Consumidor SQS, inbox, publisher, worker de referências, autenticação e
observabilidade completa continuam para fases futuras. Eventos aguardam publicação
e referências pendentes aguardam processamento; não há alegação de entrega externa.

## Concorrência real — Fase 4

### Processos e distribuição

test/support/process-harness.ts cria um banco PostgreSQL vazio descartável,
aplica as migrations existentes e inicia três processos usando o executável Bun
global atual (process.execPath). Cada filho carrega o AppModule de produção pelo
entry point test/support/application-process.ts, sem overrides de repositórios,
use cases, locks ou pools. O entry point muda somente o bootstrap de teste:
logger desativado, bind em loopback e porta 0 atribuída pelo sistema operacional.
Um envelope stdout confirma PID, URL e nome do banco; o parent verifica readiness.
Portas e PIDs precisam ser distintos, e todos os filhos usam o mesmo banco.
Cada instância mantém seu próprio pool MikroORM de até dez conexões.

parallelRequests libera chamadas HTTP de uma barreira comum; instância i % 3
distribui requisições em rodízio. boundedRequests limita o stress a 30 chamadas
em voo. Os helpers drenam todas as chamadas antes de retornar falhas. Nenhuma
dessas estruturas decide idempotência ou efeitos financeiros: isso permanece
exclusivamente no PostgreSQL e na unidade transacional da aplicação.

restart encerra o filho pelo stdin, aguarda app.close/saída e inicia outro PID
com os mesmos parâmetros de banco. O teardown encerra todos os filhos, drena
stdout/stderr e remove somente o banco aleatório pertencente à fixture.
Timeouts de bootstrap, HTTP e shutdown são limitados; shutdown tem fallback
para kill se o filho não encerrar. O harness também limpa filhos que iniciaram
quando outro bootstrap falha. O processo pai não imprime credenciais.

### Cenários e reconciliação

```sh
docker compose up -d --wait postgres localstack
bun run typecheck
bun test test/unit
bun run test:integration
bun run test:concurrency
```

O LocalStack é necessário apenas para o readiness existente; não foi adicionado
consumidor nem publisher. Cada arquivo em test/concurrency usa seu próprio banco
isolado e três processos reais. Os cenários cobrem:

- cinquenta envios simultâneos com mesma key/payload: um processamento, 49 replays
  e um único débito, além do crédito de abertura;
- cinquenta keys com mesma identidade externa: um processamento e 49 conflitos;
- duas BET de 80.00 sobre 100.00 em processos distintos: PROCESSED/REJECTED,
  saldo 20.00, um débito e retries sem novo efeito;
- replay em novo PID após outra instância movimentar o saldo: resposta original
  de 75.00 preservada, mesmo com saldo atual 125.00;
- stress com 360 operações únicas (BET/WIN/LOSS) em 12 wallets, mais 360 retries,
  paralelismo limitado a 30 e saldo final 110.00 por wallet;
- avanço em seis wallets distintas enquanto duas conexões aguardam lock de
  outra wallet, comprovado por pg_stat_activity e pg_blocking_pids;
- três lock timeouts reais de cinco segundos, HTTP 503, nenhum registro parcial,
  retries bem-sucedidos após liberação e novos envios retornando replay.

assert-ledger-consistency.ts executa aritmética NUMERIC exata no banco:
wallet.balance == COALESCE(SUM(CREDIT.amount - DEBIT.amount), 0).
Dinheiro retornado para diagnóstico permanece texto. Também verifica duplicação
de ledger por wallet/transação, ledger associado a PROCESSED, exclusão de LOSS,
valor/moeda correspondentes e ausência de outbox publicada. A asserção é executada
após cada cenário; checks adicionais comparam version, ledger, transações e outbox.

reportScenario imprime JSON com nome, duração em milissegundos e contagens/saldos.
Os tempos principais incluem a execução HTTP e verificações do cenário, após
preparo das wallets; restart inclui shutdown/bootstrap. Stress inclui os retries.
São medidas locais de correção sob carga controlada, sem promessa de throughput,
latência de produção ou execução em hosts distintos.

### Correção necessária revelada pelo paralelismo

Os cinquenta envios descobriram uma janela READ COMMITTED: SELECT por key retornava
vazio; o vencedor fazia commit; SELECT por identidade externa encontrava a própria
key e retornava EXTERNAL_TRANSACTION_CONFLICT indevidamente. resolveExisting agora
reconhece essa key, relê o resultado original e aplica as mesmas regras de hash/replay.
Uma reprodução determinística pausa apenas o primeiro SELECT real, permite que
outro processo faça commit e retoma a leitura; cobre hash igual (replay) e diferente
(IDEMPOTENCY_CONFLICT). A sincronização de teste não substitui SQL ou processamento.
Essa é a única alteração funcional da Fase 4; schema, migrations, política financeira,
locks e fronteira transacional permanecem os da Fase 3.

Não foram implementados consumer SQS, inbox, publisher, worker de referências,
autenticação ou observabilidade completa. O teste de reinício ocorre após resposta
e commit confirmados; crash durante commit/ack de mensagens é escopo das fases futuras.

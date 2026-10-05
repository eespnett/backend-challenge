# Arquitetura — Fases 0 e 1

## Escopo implementado

Bootstrap NestJS executado por Bun 1.4.2, TypeScript strict, PostgreSQL 17,
MikroORM 6.5.8, SQS no LocalStack Community 4.0.3 e Docker Compose.
O domínio financeiro puro está em src/domain, sem imports de NestJS, ORM ou
infraestrutura. Ainda não há operações financeiras persistidas, controllers
financeiros, autenticação nem workers de negócio.

A migration inicial cria somente o schema wagering. O histórico de migrations
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
docker compose up -d --build app
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
Após DOWN, o schema wagering desaparece e o histórico fica vazio; a tabela de
controle public.mikro_orm_migrations permanece por desenho do MikroORM.
Nenhuma tabela da aplicação é criada nesta fase.

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
Um trigger simples de bloqueio UPDATE/DELETE do ledger poderá ser adicionado
sem comprometer prazo e estabilidade.

Money usa bigint em centavos no domínio, com parsing/serialização por strings.
Nenhuma quantia monetária passará por number. Contratos HTTP/SQS terão duas
casas decimais e a persistência será exata. Money foi implementado na Fase 1.

Idempotência terá UNIQUE(idempotency_key),
UNIQUE(provider_id, external_transaction_id), payloadHash e resultado original
persistido. O replay de PENDING será mantido simples, com a decisão contratual
documentada quando esse fluxo for implementado.

Autenticação não vale pontos e será omitida, com porta de identidade explícita
na fase correspondente e desenho de integração futura com IdP externo.
Implementação avança somente mediante aprovação, uma fase por vez.

## Domínio financeiro — Fase 1

O domínio não é importado pelo AppModule nesta fase. Não houve alteração de
schema, migrations, dependências, controllers, SQS ou persistência.

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
futura deverá associá-lo à transação interna OPENING e ao ledger na mesma SQL.
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
Unicidade player+currency, um ledger por transação/wallet, atomicidade e controle
de concorrência dependem da persistência das próximas fases; o domínio não
simula essas garantias com memória nem executa SQL.

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
Não há garantia de unicidade concorrente sem a futura constraint/transação SQL.

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

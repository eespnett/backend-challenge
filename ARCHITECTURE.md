# Arquitetura — Fase 0

## Escopo implementado

Bootstrap NestJS executado por Bun 1.4.2, TypeScript strict, PostgreSQL 17,
MikroORM 6.5.8, SQS no LocalStack Community 4.0.3 e Docker Compose.
Não há operações financeiras, entidades de domínio, autenticação nem workers de negócio.

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

Money será bigint em centavos no domínio, com parsing/serialização por strings.
Nenhuma quantia monetária passará por number. Contratos HTTP/SQS terão duas
casas decimais e a persistência será exata. Money não é implementado na Fase 0.

Idempotência terá UNIQUE(idempotency_key),
UNIQUE(provider_id, external_transaction_id), payloadHash e resultado original
persistido. O replay de PENDING será mantido simples, com a decisão contratual
documentada quando esse fluxo for implementado.

Autenticação não vale pontos e será omitida, com porta de identidade explícita
na fase correspondente e desenho de integração futura com IdP externo.
Implementação avança somente mediante aprovação, uma fase por vez.

# Fase 6 — SQS, inbox, retry e DLQ

O `MessagingModule` recebe comandos `WagerTransactionRequested` da fila FIFO
`wager-transactions.fifo`. O cliente AWS SDK usa o endpoint LocalStack configurado.
Não há publicação da outbox nem consumidor dos eventos nesta fase.

## Contrato e identidade

O envelope tem `messageId`, `type`, `occurredAt` (UTC ISO com milissegundos) e
`data`. `data` é o contrato HTTP acrescido de `idempotencyKey`. Valores monetários
continuam strings decimais exatas. OPENING não é aceito externamente.

`messageId` do envelope é a identidade da inbox; o `MessageId` do SQS identifica
a entrega de transporte. São distintos. O hash da inbox inclui todo o envelope,
com chaves ordenadas recursivamente. O hash financeiro permanece o JSON canônico
da Fase 3, sem metadados de transporte ou chave de idempotência.

Produtores devem usar `MessageGroupId` por wallet e fornecer
`MessageDeduplicationId`. A garantia financeira depende dos locks e constraints
do PostgreSQL, inclusive quando produtores escolhem grupos diferentes.

## Fronteira transacional

1. Validar envelope/payload com a mesma validação usada pelo HTTP.
2. Abrir transação READ COMMITTED, inserir inbox com ON CONFLICT e bloquear a linha.
3. Comparar hash. Inbox concluída recebe ack sem nova execução.
4. Chamar `ProcessWagerTransactionUseCase.executeInTransaction` na mesma unidade
   de trabalho. Lock da wallet, transaction, ledger, outbox e agendamento de
   referência pendente são os da implementação financeira existente.
5. Concluir inbox e commit. Só depois enviar DeleteMessage.

Colisão financeira de unicidade aborta a transação inteira e recupera em uma
nova transação. As constraints persistentes continuam protegendo IDs distintos
para a mesma operação. Resultados 422 e 202 são persistidos e recebem ack;
conflitos financeiros são auditados como REJECTED na inbox e recebem ack.
O callback transacional não chama nem aguarda APIs SQS. A renovação de visibility
ocorre em paralelo, fora desse callback.

Mensagens do mesmo grupo FIFO são executadas em ordem dentro do lote; grupos
diferentes avançam em paralelo. Após retry, o restante daquele grupo fica sem ack.

## Retry e DLQ

A configuração em `infra/localstack/init-queues.sh` já cria FIFO, visibility 30s,
redrive `maxReceiveCount=5`, retenção principal de 4 dias e DLQ de 14 dias.
O consumidor muda visibility para 1s, 2s, 4s, 8s, 16s (teto 30s) após falhas
transitórias. O redrive nativo encaminha a mensagem depois dos cinco recebimentos
sem sucesso; preserva corpo e identidade SQS. Nada é apagado nesse caminho.
Durante trabalho ativo, a visibility é renovada para 30s a cada 10s.

Erro permanente de envelope/payload, ou mesmo messageId com hash diferente,
gera encaminhamento explícito. A inbox original é preservada e
`consumer_dead_letters` guarda corpo original, identidade, erro e confirmação de
envio. SendMessage à DLQ usa deduplication ID SHA-256 estável e atributos
`OriginalMessageId`, `OriginalSqsMessageId`, `FailureCode` e `ConsumerName`.
Só após confirmação SQS e persistência de `sent_at` ocorre o delete da origem.

Se ocorrer crash depois do envio e antes de gravar `sent_at`, a origem continua
disponível. A FIFO elimina repetição de envio dentro de sua janela de cinco
minutos. Fora dessa janela pode existir uma cópia adicional na DLQ: não é possível
garantir commit atômico entre PostgreSQL e SQS. O contrato da DLQ é pelo menos uma
vez, com identidade original preservada para deduplicação. Após `sent_at`,
redelivery apenas conclui o delete sem novo envio. Não há publisher nesta fase.

## Shutdown

SIGTERM usa os hooks NestJS: interromper polling, não iniciar entregas novas e
aguardar a rodada ativa por `SQS_SHUTDOWN_TIMEOUT_MS` (padrão 10000).
Ao vencer o limite, abortar chamadas SQS/renovação e impedir ack/commit de trabalho
ainda não concluído. A conexão SQL em andamento continua sujeita aos limites já
existentes (lock 5s, statement 15s); a limpeza do pool pode aguardar essa consulta
terminar após o limite de drain. O Compose concede 30s de graça.
Trabalho confirmado sem ack é recuperado pela inbox. Trabalho sem commit é
recuperado pela visibility. O cliente SQS só é destruído no hook final, depois
da etapa de drain.

## Configuração e validação

- `SQS_CONSUMER_ENABLED=true` (permite desligar worker em testes HTTP).
- `SQS_TRANSACTION_QUEUE_NAME=wager-transactions.fifo`.
- `SQS_DLQ_QUEUE_NAME=wager-transactions-dlq.fifo`.
- `SQS_SHUTDOWN_TIMEOUT_MS=10000` (100–30000).

`bun run test:messaging` executa integração com bancos/filas isolados reais e os
testes de três processos independentes. Cada fixture remove apenas seus próprios
recursos aleatórios. PostgreSQL indisponível é testado bloqueando conexões apenas
ao banco da fixture e encerrando seus backends; o banco principal não é alterado.

No Windows, o harness despacha o handler SIGTERM registrado pelo NestJS, pois
POSIX signals não têm a mesma semântica. No Linux usa `child.kill('SIGTERM')`.
Para validar o sinal real em container:

```sh
docker compose build app
docker compose run --rm --no-deps app bun test test/concurrency/phase6-sqs-processes.test.ts --test-name-pattern SIGTERM --timeout 30000
```

Os testes também cobrem crash antes do commit, crash após commit antes de ack,
replay após restart, DLQ indisponível, retomada de encaminhamento e consistência
exata entre saldo e ledger. Outbox permanece apenas persistida, sem publicação.

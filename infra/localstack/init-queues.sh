#!/bin/bash
set -euo pipefail

dlq_arn=$(awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes '{"FifoQueue":"true","MessageRetentionPeriod":"1209600"}' \
  --query QueueUrl --output text)
dlq_arn=$(awslocal sqs get-queue-attributes \
  --queue-url "$dlq_arn" --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"VisibilityTimeout\":\"30\",\"MessageRetentionPeriod\":\"345600\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$dlq_arn\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

awslocal sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes '{"FifoQueue":"true","VisibilityTimeout":"30"}'

touch /tmp/wagering-queues-ready

import { BadRequestException, Body, ConflictException, Controller, Headers, Inject, Post, Res, ServiceUnavailableException } from '@nestjs/common';
import { ProcessWagerTransactionUseCase } from '../application/process-wager-transaction';
import { InfrastructureUnavailableError, InvalidWagerRequestError, ProcessingConflictError } from '../application/processing-errors';
import { DomainError } from '../domain/domain-error';

@Controller('wagering/transactions')
export class WageringController {
  constructor(@Inject(ProcessWagerTransactionUseCase) private readonly process: ProcessWagerTransactionUseCase) {}

  @Post()
  async submit(@Body() body: unknown, @Headers('idempotency-key') key: unknown,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: { status(code: number): unknown }) {
    try {
      const result = await this.process.execute(body, key, { correlationId });
      response.status(result.httpStatus);
      return result.body;
    } catch (error) {
      if (error instanceof InvalidWagerRequestError || error instanceof DomainError) {
        throw new BadRequestException({ failureCode: error.code, message: error.message });
      }
      if (error instanceof ProcessingConflictError) {
        throw new ConflictException({ failureCode: error.code, message: error.message });
      }
      if (error instanceof InfrastructureUnavailableError) {
        throw new ServiceUnavailableException({ failureCode: error.code, message: error.message });
      }
      throw error;
    }
  }
}

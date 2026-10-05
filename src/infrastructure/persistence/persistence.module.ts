import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { ConfigModule } from '../../config/config.module';
import { AppConfig } from '../../config/app-config';
import { createOrmConfig } from './mikro-orm.config';

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      imports: [ConfigModule],
      inject: [AppConfig],
      useFactory: (config: AppConfig) => createOrmConfig(config),
    }),
  ],
})
export class PersistenceModule {}

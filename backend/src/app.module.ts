import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { BusinessModule } from './business/business.module.js';
import { CategoryModule } from './category/category.module.js';
import databaseConfig from './config/typeorm.config.js';
import jwtConfig from './config/jwt.config.js';
import supabaseConfig from './config/supabase.config.js';
import { OrderModule } from './order/order.module.js';
import { ProductModule } from './product/product.module.js';
import { TableModule } from './table/table.module.js';
import { UserModule } from './user/user.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, jwtConfig, supabaseConfig],
    }),
    TypeOrmModule.forRootAsync({
      inject: [databaseConfig.KEY],
      useFactory: (config: ReturnType<typeof databaseConfig>) => config,
    }),
    BusinessModule,
    CategoryModule,
    ProductModule,
    OrderModule,
    TableModule,
    UserModule,
    AuthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

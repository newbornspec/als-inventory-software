import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { assertProductionSecrets } from './config/assert-production-secrets';

async function bootstrap() {
  // Before anything else: in production, refuse to boot on a public dev secret
  // (see assert-production-secrets.ts). Railway keeps the previous deployment
  // serving when the new one does not come up, so this fails safe.
  assertProductionSecrets();
  const app = await NestFactory.create(AppModule);
  // Base64 device-photo uploads exceed the default 100kb body limit.
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true, limit: '10mb' }));
  // CORS_ORIGIN unset -> allow all (local dev). In production, set it to
  // your Vercel deployment URL(s), comma-separated, to stop restricting to
  // wide-open origins once this is public.
  const corsOrigin = process.env.CORS_ORIGIN;
  app.enableCors({ origin: corsOrigin ? corsOrigin.split(',') : true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();

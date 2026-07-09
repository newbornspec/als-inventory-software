import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // CORS_ORIGIN unset -> allow all (local dev). In production, set it to
  // your Vercel deployment URL(s), comma-separated, to stop restricting to
  // wide-open origins once this is public.
  const corsOrigin = process.env.CORS_ORIGIN;
  app.enableCors({ origin: corsOrigin ? corsOrigin.split(',') : true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();

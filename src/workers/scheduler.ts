import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { Telegraf } from 'telegraf';
import OpenAI from 'openai';
import prisma from '../database';
import { evaluateInbox } from '../agents/dispatcher';
import { generateReply } from '../agents/communicator';
import { planDay } from '../agents/planner';

const connection = new IORedis({ maxRetriesPerRequest: null });
export const messageQueue = new Queue('message-queue', { connection });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

const worker = new Worker('message-queue', async (job) => {
  const { type, userId, context } = job.data;

  // 1. АВТО-ПЛАНИРОВЩИК (Ежедневный запуск утром)
  if (type === 'daily-planner') {
    console.log(`[Scheduler] 🌅 Доброе утро! Запускаю планирование дня для всех пользователей...`);
    const users = await prisma.user.findMany();
    for (const u of users) {
      await planDay(u.id); // Запускаем Сценариста для каждого юзера
    }
    return; // Завершаем задачу, дальше идти не нужно
  }

  const userBigInt = BigInt(userId);

  // 2. ВХОДЯЩИЕ СООБЩЕНИЯ (Диспетчер)
  if (type === 'process-inbox') {
    console.log(`[Dispatcher] Анализирую входящие для ${userId}...`);
    
    const decision = await evaluateInbox(userBigInt);
    console.log(`[Dispatcher] Решение: ${decision.action}. Причина: ${decision.reason}`);

    if (decision.action === 'reply_now') {
      await bot.telegram.sendChatAction(Number(userId), 'typing');
      const replyText = await generateReply(userBigInt);
      
      await prisma.message.create({
        data: { userId: userBigInt, sender: 'BOT', content: replyText }
      });
      await bot.telegram.sendMessage(Number(userId), replyText);

    } else if (decision.action === 'delay') {
      await messageQueue.add('delayed-reply', {
        type: 'process-inbox',
        userId: userId,
      }, {
        delay: decision.delayMinutes * 60000,
        jobId: `reply-${userId}` 
      });
      console.log(`[Dispatcher] Ответ отложен на ${decision.delayMinutes} мин.`);
    }
    else if (decision.action === 'user_busy') {
      // 1. Бот просто пишет "Ок" и не задает вопросов
      const replyText = "Alles klar, sag Bescheid wenn du Zeit hast! 👍"; // "Договорились, скажи как будет время"
      
      await prisma.message.create({
        data: { userId: userBigInt, sender: 'BOT', content: replyText }
      });
      await bot.telegram.sendMessage(Number(userId), replyText);

      // 2. Ставим таймер на 10 минут, чтобы аккуратно напомнить о себе
      await messageQueue.add('proactive-message', {
        type: 'proactive-message',
        userId: userId,
        context: "Пользователь просил подождать 10 минут назад. Узнай, освободился ли он. Можно скинуть смешной смайлик 🧐 или коротко спросить 'Bist du da?' (Ты тут?), но ни в коем случае не дави на него."
      }, {
        delay: 10 * 60000, // Ровно 10 минут
        jobId: `ping-${userId}` // Уникальный ID пинга
      });
      
      console.log(`[Dispatcher] Пользователь занят. Ответили Ок, ждем 10 мин.`);
    }
    
  }

  // 3. ИНИЦИАТИВА ОТ СЦЕНАРИСТА (Бот пишет первым)
  else if (type === 'proactive-message') {
    console.log(`[Worker] Инициатива для ${userId}. Событие: ${context}`);
    const user = await prisma.user.findUnique({ where: { id: userBigInt }, include: { persona: true } });
    if (!user || !user.persona) return;
    
    const recentMessages = await prisma.message.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 2 });
    let timeInstruction = "Вы еще не общались сегодня. Начни с приветствия.";
    
    if (recentMessages.length > 0) {
      const diffMinutes = Math.floor((Date.now() - recentMessages[0].createdAt.getTime()) / 60000);
      if (diffMinutes < 30) timeInstruction = "Вы общались только что! ЗАПРЕЩЕНО здороваться заново. Сделай плавный переход от прошлой темы.";
      else if (diffMinutes < 180) timeInstruction = "Вы общались пару часов назад. Можно перейти сразу к событию без долгих приветствий.";
    }

    const systemPrompt = `Ты человек из Германии. Имя: ${user.persona.name}.
СЕЙЧАС ТЫ ПИШЕШЬ ПЕРВЫМ. Событие: "${context}"
${timeInstruction}
Напиши коротко (1-3 предложения). Выдай только текст.`;

    const completion = await openai.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "system", content: systemPrompt }] });
    const replyText = completion.choices[0]?.message?.content;

    if (replyText) {
      await prisma.message.create({ data: { userId: user.id, sender: 'BOT', content: replyText } });
      await bot.telegram.sendMessage(Number(user.id), replyText);
    }
  }
}, { connection });

// НОВЫЙ СИНТАКСИС BULLMQ v5+ ДЛЯ КРОН-ЗАДАЧ
worker.on('ready', async () => {
  await messageQueue.upsertJobScheduler(
    'daily-planner-scheduler',
    { 
      pattern: '0 8 * * *', // Каждый день в 08:00
      tz: 'Europe/Berlin'   // По немецкому времени
    },
    {
      name: 'morning-planning',
      data: { type: 'daily-planner' }
    }
  );
  console.log('[Worker] Планировщик дня успешно настроен на 08:00 (Берлин)');
});
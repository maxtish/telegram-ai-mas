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
      await planDay(u.id);
    }
    return;
  }



  // --- НОВОЕ: АВТО-КВИЗ (Проверка слов) ---
  if (type === 'hourly-quiz') {
    console.log(`[Quiz] 🧠 Запуск ежечасной проверки слов...`);
    // Ищем всех пользователей, которые сейчас ничем не заняты (IDLE)
    const users = await prisma.user.findMany({ where: { botState: 'IDLE' } });
    
    for (const u of users) {
      // Проверяем, не переписывается ли он прямо сейчас (чтобы не перебить диалог)
      const lastMsg = await prisma.message.findFirst({
        where: { userId: u.id, sender: 'USER' },
        orderBy: { createdAt: 'desc' }
      });
      
      if (lastMsg && (Date.now() - lastMsg.createdAt.getTime() < 15 * 60000)) {
        continue; // Общались меньше 15 минут назад, не отвлекаем
      }

      // Ищем слово, которое пора повторять (игнорируем правила грамматики)
      const word = await prisma.vocabulary.findFirst({
        where: { 
          userId: u.id, 
          nextReview: { lte: new Date() },
          translation: { not: null } 
        },
        orderBy: { nextReview: 'asc' }
      });

      if (word) {
       // Переводим бота в режим проверки (мини-сессия на 1 слово)
        const sessionState = {
          type: 'QUIZ_SESSION',
          queue: [word.id],
          current: word.id,
          correct: 0,
          wrong: 0,
          total: 1
        };

        await prisma.user.update({
          where: { id: u.id },
          data: { botState: JSON.stringify(sessionState) }
        });
        
        const text = `Минутка практики! 🤓\nПомнишь, как будет по-немецки: <b>${word.translation}</b>?`;
        
        // Сохраняем вопрос в базу и отправляем
        await prisma.message.create({
          data: { userId: u.id, sender: 'BOT', content: text }
        });
        await bot.telegram.sendMessage(Number(u.id), text, { parse_mode: 'HTML' });
        console.log(`[Quiz] Отправлен вопрос пользователю ${u.id}`);
      }
    }
    return; // Завершаем задачу
  }
  // ------------------------------------------

// --- НОВОЕ: ПИНГ НЕАКТИВНОСТИ (Прошло 5 часов без ответа) ---
  if (type === 'inactivity-ping') {
    console.log(`[Ping] Проверяю чаты на долгое молчание...`);
    const users = await prisma.user.findMany({ include: { persona: true } });
    
    for (const u of users) {
      if (u.botState !== 'IDLE' || !u.persona) continue; // Не трогаем, если юзер на экзамене

      // Берем последние 10 сообщений для контекста
      const recentMessages = await prisma.message.findMany({
        where: { userId: u.id },
        orderBy: { createdAt: 'desc' },
        take: 10
      });

      if (recentMessages.length === 0) continue;

      const lastMsg = recentMessages[0];
      
      // Нас интересует только ситуация, когда ПОСЛЕДНИМ написал БОТ, а юзер молчит
      if (lastMsg.sender !== 'BOT') continue;

      const hoursPassed = (Date.now() - lastMsg.createdAt.getTime()) / (1000 * 60 * 60);
      
      // Ловим окно ровно между 5 и 6 часами молчания, чтобы бот написал ровно 1 раз, а не спамил каждый час
      if (hoursPassed >= 5 && hoursPassed < 6) {
        console.log(`[Ping] Пользователь ${u.id} молчит 5 часов. Генерируем вовлекающее сообщение.`);
        
        // Собираем историю диалога для анализа
        const chatHistory = recentMessages.reverse().map(m => `${m.sender === 'BOT' ? u.persona?.name : 'Пользователь'}: ${m.content}`).join('\n');

        const prompt = `Ты человек из Германии (Бавария). Имя: ${u.persona.name}, профессия: ${u.persona.profession}.
Твой собеседник не отвечает на твое последнее сообщение уже 5 часов. 

ТВОЯ ЗАДАЧА:
Написать ОДНО короткое сообщение (2-3 предложения), чтобы сменить тему и снова вовлечь его в разговор.
Сделай анализ истории переписки, чтобы понять, чем он увлекается (хобби, работа, интересы).

Выбери ОДИН из вариантов:
1. Поделись коротким интересным фактом из мира IT, технологий или инженерии.
2. Расскажи забавный факт или новость о Баварии/Германии.
3. Задай вопрос о его хобби, которое упоминалось в чате.

ПРАВИЛА:
- Не упрекай его за то, что он долго не отвечал.
- Пиши на немецком языке (можно добавить 1-2 слова по-русски, если это уместно для юмора).
- Будь дружелюбным и естественным.

История последних сообщений для анализа:
${chatHistory}`;

        try {
          const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: prompt }]
          });
          
          const replyText = completion.choices[0]?.message?.content;
          
          if (replyText) {
            await prisma.message.create({ data: { userId: u.id, sender: 'BOT', content: replyText } });
            await bot.telegram.sendMessage(Number(u.id), replyText);
          }
        } catch (e) {
          console.error(`[Ping] Ошибка при генерации пинга:`, e);
        }
      }
    }
    return; // Завершаем задачу
  }
  // -------------------------------------------------------------


  // Если это не планировщик и не квиз, значит работаем с конкретным юзером
  if (!userId) return;
  const userBigInt = BigInt(userId);

  // 2. ВХОДЯЩИЕ СООБЩЕНИЯ (Диспетчер)
  if (type === 'process-inbox') {
    console.log(`[Dispatcher] Анализирую входящие для ${userId}...`);
    
    const decision = await evaluateInbox(userBigInt);
    console.log(`[Dispatcher] Решение: ${decision.action}. Причина: ${decision.reason}`);

    if (decision.action === 'reply_now') {
      await bot.telegram.sendChatAction(Number(userId), 'typing');
      const replyText = await generateReply(userBigInt);
      
      await prisma.message.create({ data: { userId: userBigInt, sender: 'BOT', content: replyText } });
      await bot.telegram.sendMessage(Number(userId), replyText);

    } else if (decision.action === 'delay') {
      await messageQueue.add('delayed-reply', { type: 'process-inbox', userId: userId }, {
        delay: decision.delayMinutes * 60000,
        jobId: `reply-${userId}` 
      });
      console.log(`[Dispatcher] Ответ отложен на ${decision.delayMinutes} мин.`);

} else if (decision.action === 'enforce_german') {
      await bot.telegram.sendChatAction(Number(userId), 'typing');
      
      const user = await prisma.user.findUnique({ where: { id: userBigInt }, include: { persona: true } });
      const personaName = user?.persona?.name || "Бот";

      const prompt = `Ты ${personaName}. Пользователь написал тебе обычное сообщение на русском языке, хотя вы договаривались практиковать немецкий.
Ответь ему с юмором, подколи его и попроси написать то же самое, но по-немецки. 
Можешь использовать смешанный русско-немецкий или просто русский с немецкими словечками. Максимум 1-2 предложения. Но потом переходи на Немецкий! НЕ помогай ему с переводом, пусть сам думает!`;

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: prompt }]
      });

      const replyText = completion.choices[0]?.message?.content || "Эй, мы же договаривались общаться на немецком! А ну-ка переведи то, что сейчас сказал 😉";
      
      await prisma.message.create({ data: { userId: userBigInt, sender: 'BOT', content: replyText } });
      await bot.telegram.sendMessage(Number(userId), replyText);
      console.log(`[Dispatcher] Пользователь пишет на русском. Отправлен шуточный выговор.`);
    



    } else if (decision.action === 'user_busy') {
      const replyText = "Alles klar, sag Bescheid wenn du Zeit hast! 👍"; 
      await prisma.message.create({ data: { userId: userBigInt, sender: 'BOT', content: replyText } });
      await bot.telegram.sendMessage(Number(userId), replyText);

      await messageQueue.add('proactive-message', {
        type: 'proactive-message', userId: userId,
        context: "Пользователь просил подождать 10 минут назад. Узнай, освободился ли он."
      }, {
        delay: 10 * 60000, jobId: `ping-${userId}` 
      });
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
  // План на день (в 08:00)
  await messageQueue.upsertJobScheduler(
    'daily-planner-scheduler',
    { pattern: '0 8 * * *', tz: 'Europe/Berlin' },
    { name: 'morning-planning', data: { type: 'daily-planner' } }
  );

  // Авто-Квиз (каждый час, но только с 09:00 до 21:00, чтобы не будить по ночам)
  await messageQueue.upsertJobScheduler(
    'hourly-quiz-scheduler',
    { pattern: '0 9-21 * * *', tz: 'Europe/Berlin' },
    { name: 'hourly-quiz', data: { type: 'hourly-quiz' } }
  );

  // Проверка молчания (только днем с 10:00 до 22:00)
  await messageQueue.upsertJobScheduler(
    'inactivity-ping-scheduler',
    { pattern: '0 10-22 * * *', tz: 'Europe/Berlin' }, // <-- ИЗМЕНИЛИ ЗДЕСЬ
    { name: 'inactivity-ping', data: { type: 'inactivity-ping' } }
  )


  console.log('[Worker] Планировщик дня и Экзаменатор успешно настроены!');
});
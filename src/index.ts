require('dotenv').config(); // <-- Должно быть в самом начале!

import { analyzeMistakes } from './agents/teacher';
import { generateReply } from './agents/communicator';
import { Telegraf } from 'telegraf';
import prisma from './database';
import { generatePersona } from './agents/persona';
import './workers/scheduler';
import { planDay } from './agents/planner';
import { messageQueue } from './workers/scheduler';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

bot.start(async (ctx) => {
  const telegramId = ctx.from.id;
  const username = ctx.from.username || null;
  const firstName = ctx.from.first_name || '';

  try {
    let user = await prisma.user.findUnique({
      where: { id: BigInt(telegramId) },
      include: { persona: true }
    });

    if (user && user.persona) {
      return ctx.reply(`Привет! Мы же уже знакомы, я ${user.persona.name} из ${user.persona.city}. Как дела? 😉`);
    }

    ctx.reply("Привет! Дай мне секундочку, я настраиваюсь на твою волну... ⚙️");

    if (!user) {
      user = await prisma.user.create({
        data: {
          id: BigInt(telegramId),
          username: username,
          firstName: firstName,
        },
        include: { persona: true }
      });
    }

    const newPersonaData = await generatePersona();

    const savedPersona = await prisma.persona.create({
      data: {
        userId: user.id,
        name: newPersonaData.name,
        age: newPersonaData.age,
        profession: newPersonaData.profession,
        city: newPersonaData.city,
        hobbies: newPersonaData.hobbies,
        communicationStyle: newPersonaData.communicationStyle,
      }
    });

    await ctx.reply(
      `Всё готово! 🎉\n\nПривет, меня зовут ${savedPersona.name}! Мне ${savedPersona.age}, я живу в городе ${savedPersona.city} и работаю (${savedPersona.profession}).\nВ свободное время люблю: ${savedPersona.hobbies.join(', ')}.\n\nДавай общаться! Напиши мне что-нибудь на немецком.`
    );

  } catch (error) {
    console.error("Ошибка при обработке /start:", error);
    ctx.reply("Ой, что-то пошло не так. Попробуй еще раз чуть позже.");
  }
});

// --- СПЕЦИАЛЬНЫЕ КОМАНДЫ ДОЛЖНЫ БЫТЬ ВЫШЕ ТЕКСТОВОГО ОБРАБОТЧИКА ---

// Секретная команда для запуска Планировщика вручную
bot.command('plan', async (ctx) => {
  const telegramId = BigInt(ctx.from.id);
  ctx.reply("Запускаю генерацию расписания... ⏳");
  await planDay(telegramId);
  ctx.reply("Расписание создано! Жди сообщений от бота в ближайшие пару минут. 😉");
});

// --- ОБРАБОТЧИК ВСЕГО ОСТАЛЬНОГО ТЕКСТА ---

bot.on('text', async (ctx) => {
  const telegramId = BigInt(ctx.from.id);
  const text = ctx.message.text;

  if (text.startsWith('/')) return;

  try {
    const user = await prisma.user.findUnique({ where: { id: telegramId }, include: { persona: true } });
    if (!user || !user.persona) return ctx.reply("Для начала напиши /start");

    // 1. Сначала всегда сохраняем сообщение в базу
    await prisma.message.create({
      data: { userId: telegramId, sender: 'USER', content: text }
    });

    // 2. УДАЛЯЕМ старую задачу ответа (если она есть)
    const jobId = `reply-${telegramId}`;
    const existingJob = await messageQueue.getJob(jobId);
    if (existingJob) {
      await existingJob.remove(); // Отменяем старый таймер
    }

    // --- НОВОЕ: ОТМЕНЯЕМ ПИНГ ---
    // Если мы ждали пользователя 10 минут, а он пришел сам на 5-й минуте,
    // мы должны отменить напоминание, чтобы не выглядеть глупо.
    const pingJobId = `ping-${telegramId}`;
    const pingJob = await messageQueue.getJob(pingJobId);
    if (pingJob) {
      await pingJob.remove();
      console.log(`[Debounce] Пользователь вернулся сам. Напоминание через 10 мин отменено.`);
    }
    // -----------------------------
    

    // 3. СТАВИМ новый таймер на 10 секунд (Накопитель/Debounce)
    await messageQueue.add('process-inbox', {
      type: 'process-inbox',
      userId: telegramId.toString()
    }, {
      delay: 5000, // Ждем 5 секунд после последнего сообщения
      jobId: jobId // Уникальный ID задачи для этого юзера
    });

    // 4. Триггер Учителя (оставляем как было)
    const userMsgCount = await prisma.message.count({ where: { userId: telegramId, sender: 'USER' } });
    if (userMsgCount % 5 === 0) {
      analyzeMistakes(telegramId).catch(console.error);
    }

  } catch (error) {
    console.error("Ошибка при получении текста:", error);
  }
});

bot.launch(() => {
  console.log('Бот успешно запущен и ждет сообщений!');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
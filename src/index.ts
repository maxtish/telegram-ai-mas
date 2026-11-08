import { analyzeMistakes } from './agents/teacher';
import { generateReply } from './agents/communicator';
import { Telegraf } from 'telegraf';
import prisma from './database';
import { generatePersona } from './agents/persona';
require('dotenv').config();




const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

bot.start(async (ctx) => {
  const telegramId = ctx.from.id;
  const username = ctx.from.username || null;
  const firstName = ctx.from.first_name || '';

  try {
    // 1. Проверяем, есть ли уже такой пользователь в БД
    let user = await prisma.user.findUnique({
      where: { id: BigInt(telegramId) },
      include: { persona: true } // Сразу подтягиваем его ИИ-собеседника
    });

    if (user && user.persona) {
      return ctx.reply(`Привет! Мы же уже знакомы, я ${user.persona.name} из ${user.persona.city}. Как дела? 😉`);
    }

    // 2. Если пользователя нет, создаем его
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

    // 3. Вызываем ИИ-Агента для создания уникальной личности
    const newPersonaData = await generatePersona();

    // 4. Сохраняем личность в базу, привязывая к пользователю
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

    // 5. Бот представляется от лица созданной личности!
    await ctx.reply(
      `Всё готово! 🎉\n\nПривет, меня зовут ${savedPersona.name}! Мне ${savedPersona.age}, я живу в городе ${savedPersona.city} и работаю (${savedPersona.profession}).\nВ свободное время люблю: ${savedPersona.hobbies.join(', ')}.\n\nДавай общаться! Напиши мне что-нибудь на немецком.`
    );

  } catch (error) {
    console.error("Ошибка при обработке /start:", error);
    ctx.reply("Ой, что-то пошло не так. Попробуй еще раз чуть позже.");
  }
});

// Обработчик всех текстовых сообщений
bot.on('text', async (ctx) => {
  const telegramId = BigInt(ctx.from.id);
  const text = ctx.message.text;

  // Игнорируем команды (например /start)
  if (text.startsWith('/')) return;

  try {
    // 1. Проверяем, есть ли пользователь и персона в базе
    const user = await prisma.user.findUnique({
      where: { id: telegramId },
      include: { persona: true }
    });

    if (!user || !user.persona) {
      return ctx.reply("Для начала напиши /start, чтобы я настроился на общение!");
    }

    // 2. Показываем статус "печатает..." в Telegram (для реализма)
    await ctx.sendChatAction('typing');

    // 3. Сохраняем сообщение пользователя в базу данных
    await prisma.message.create({
      data: {
        userId: telegramId,
        sender: 'USER',
        content: text
      }
    });

    // 4. Вызываем агента-Коммуникатора (он сам заберет историю из БД)
    const replyText = await generateReply(telegramId);

    // 5. Сохраняем ответ бота в БД
    await prisma.message.create({
      data: {
        userId: telegramId,
        sender: 'BOT',
        content: replyText
      }
    });

    // 6. Отправляем ответ в Telegram
    await ctx.reply(replyText);

 // --- НОВЫЙ БЛОК: ТРИГГЕР УЧИТЕЛЯ ---
    // Считаем, сколько сообщений написал пользователь
    const userMsgCount = await prisma.message.count({ 
      where: { userId: telegramId, sender: 'USER' } 
    });

    // Каждое 5-е сообщение запускаем фоновый анализ
    if (userMsgCount % 5 === 0) {
      // Обрати внимание: мы НЕ пишем await. Функция уходит работать в фон.
      analyzeMistakes(telegramId).catch(console.error);
    }

  } catch (error) {
    console.error("Ошибка при текстовом ответе:", error);
    ctx.reply("Прости, у меня тут связь барахлит. Можешь повторить?");
  }
});


// Запускаем бота
bot.launch(() => {
  console.log('Бот успешно запущен и ждет сообщений!');
});

// Плавная остановка при закрытии сервера
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));


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

// Запускаем бота
bot.launch(() => {
  console.log('Бот успешно запущен и ждет сообщений!');
});

// Плавная остановка при закрытии сервера
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
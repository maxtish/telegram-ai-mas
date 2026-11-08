require('dotenv').config(); // <-- Должно быть в самом начале!

import { analyzeMistakes } from './agents/teacher';
import { generateReply } from './agents/communicator';
import { Telegraf, Markup } from 'telegraf';
import prisma from './database';
import { generatePersona } from './agents/persona';
import './workers/scheduler';
import { planDay } from './agents/planner';
import { messageQueue } from './workers/scheduler';
import { checkWordQuiz } from './agents/examiner';
import { processNewWords, fixBrokenWords } from './agents/dictionary';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);


// Главное меню с кнопками
const mainMenu = Markup.keyboard([
  ['📘 Добавить слова', '🧠 Повторять слова'],
  ['📜 Мой словарь'] // <-- НОВАЯ КНОПКА
]).resize();

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
      return ctx.reply(`Привет! Мы же уже знакомы, я ${user.persona.name} из ${user.persona.city}. Как дела? 😉`, mainMenu);
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
      `Всё готово! 🎉\n\nПривет, меня зовут ${savedPersona.name}...\n\nДавай общаться!`,
      mainMenu
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

// Секретная команда для запуска экзамена вручную
bot.command('quiz', async (ctx) => {
  const telegramId = BigInt(ctx.from.id);
  
  // Ищем 1 слово, которое пора повторять (и у которого ЕСТЬ перевод)
  const wordToReview = await prisma.vocabulary.findFirst({
    where: { 
      userId: telegramId, 
      nextReview: { lte: new Date() },
      translation: { not: null } // <-- ИСПРАВЛЕНИЕ: игнорируем грамматику от Учителя
    },
    orderBy: { nextReview: 'asc' }
  });

  if (!wordToReview) {
    return ctx.reply("Пока нет слов для повторения! Можешь отдыхать ☕");
  }

  // Переводим бота в режим проверки конкретного слова
  await prisma.user.update({
    where: { id: telegramId },
    data: { botState: `QUIZ_${wordToReview.id}` }
  });

  ctx.reply(`🧠 Время проверки!\nКак будет по-немецки: <b>${wordToReview.translation}</b>?`, { parse_mode: 'HTML' });
});

// Секретная команда для починки сломанных слов в словаре
bot.command('fixdb', async (ctx) => {
  const telegramId = BigInt(ctx.from.id);
  
  const msg = await ctx.reply("🛠 Ищу сломанные слова в базе...");
  
  try {
    const fixedCount = await fixBrokenWords(telegramId);
    
    if (fixedCount === 0) {
      return ctx.reply("Всё чисто! Сломанных слов не найдено. ✅");
    }
    
    return ctx.reply(`Ремонт завершен! Успешно восстановлен перевод для ${fixedCount} слов. 🔧`);
  } catch (error) {
    console.error("Ошибка при починке БД:", error);
    ctx.reply("Упс, произошла ошибка при починке.");
  }
});



// --- ОБРАБОТЧИК ВСЕГО ОСТАЛЬНОГО ТЕКСТА ---

bot.on('text', async (ctx) => {
  const telegramId = BigInt(ctx.from.id);
  const text = ctx.message.text;

  if (text.startsWith('/')) return;

  try {
    const user = await prisma.user.findUnique({ where: { id: telegramId }, include: { persona: true } });
    if (!user || !user.persona) return ctx.reply("Для начала напиши /start");


    // --- ОБРАБОТКА КНОПОК И СОСТОЯНИЙ ---
    if (text === '📘 Добавить слова') {
      await prisma.user.update({ where: { id: telegramId }, data: { botState: 'WAITING_WORDS' } });
      return ctx.reply("Отправь мне слова, которые хочешь выучить (на русском или немецком). Можно списком или в строчку.", Markup.keyboard([['❌ Отмена']]).resize());
    }

   if (text === '❌ Отмена' || text === '❌ Завершить тренировку') {
      await prisma.user.update({ where: { id: telegramId }, data: { botState: 'IDLE' } });
      return ctx.reply("Тренировка прервана. Возвращаемся к диалогу!", mainMenu);
    }

    // --- КНОПКА: МОЙ СЛОВАРЬ ---
    if (text === '📜 Мой словарь') {
      // Достаем все слова с переводом, сортируем по дате добавления (новые внизу)
      const words = await prisma.vocabulary.findMany({
        where: { userId: telegramId, translation: { not: null } },
        orderBy: { id: 'asc' }
      });

      if (words.length === 0) {
        return ctx.reply("Твой словарь пока пуст. Нажми «📘 Добавить слова», чтобы это исправить!", mainMenu);
      }

      let responseText = "📚 <b>Твой словарь:</b>\n\n";
      
      words.forEach((w, index) => {
        // Выводим с прогрессом изучения (от 0 до 5)
        const progress = '🟢'.repeat(w.score) + '⚪'.repeat(5 - w.score);
        responseText += `${index + 1}. 🇩🇪 <b>${w.wordOrRule}</b> — 🇷🇺 ${w.translation} <i>[${progress}]</i>\n`;
      });

      // Защита от лимита Telegram (4096 символов). Разбиваем текст на части.
      const maxLength = 3900;
      if (responseText.length > maxLength) {
        // Режем текст на куски так, чтобы не обрывать на середине слова
        const chunks = responseText.match(new RegExp(`[\\s\\S]{1,${maxLength}}`, 'g')) || [];
        for (const chunk of chunks) {
          await ctx.reply(chunk, { parse_mode: 'HTML', ...mainMenu });
        }
        return;
      }

      return ctx.reply(responseText, { parse_mode: 'HTML', ...mainMenu });
    }

    // --- КНОПКА: ПОВТОРЯТЬ СЛОВА (ЗАПУСК СЕССИИ) ---
    if (text === '🧠 Повторять слова') {
      // Ищем до 20 слов, которые пора повторять
      const wordsToReview = await prisma.vocabulary.findMany({
        where: { 
          userId: telegramId, 
          nextReview: { lte: new Date() },
          translation: { not: null } 
        },
        orderBy: { nextReview: 'asc' },
        take: 20
      });

      if (wordsToReview.length === 0) {
        return ctx.reply("Все слова повторены! Пока нет новых слов для проверки. Можешь отдыхать ☕", mainMenu);
      }

      // Сохраняем состояние сессии в формате JSON в поле botState
      // queue - массив ID слов, которые нужно спросить
      // current - ID текущего слова
      // correct/wrong - статистика для финального отчета
      const sessionState = {
        type: 'QUIZ_SESSION',
        queue: wordsToReview.map(w => w.id),
        current: wordsToReview[0].id,
        correct: 0,
        wrong: 0,
        total: wordsToReview.length
      };

      await prisma.user.update({
        where: { id: telegramId },
        data: { botState: JSON.stringify(sessionState) }
      });

      return ctx.reply(`🧠 Начинаем тренировку!\nСлов в очереди: <b>${wordsToReview.length}</b>.\n\nКак будет по-немецки: <b>${wordsToReview[0].translation}</b>?`, {
        parse_mode: 'HTML',
        ...Markup.keyboard([['❌ Завершить тренировку']]).resize() 
      });
    }



    // Если бот ждет слова от пользователя:
    if (user.botState === 'WAITING_WORDS') {
      await ctx.sendChatAction('typing');
      const addedWords = await processNewWords(telegramId, text);
      
      // Возвращаем состояние в обычный режим
      await prisma.user.update({ where: { id: telegramId }, data: { botState: 'IDLE' } });
      
      if (addedWords.length > 0) {
        return ctx.reply(`✅ Добавлено в словарь:\n\n${addedWords.join('\n')}\n\nБуду периодически спрашивать их перевод!`, Markup.keyboard([['📘 Добавить слова']]).resize());
      } else {
        return ctx.reply("Не нашел новых слов для добавления (возможно, они уже есть в словаре).", Markup.keyboard([['📘 Добавить слова']]).resize());
      }
    }

    /// --- ПРОВЕРКА СЛОВ (ЭКЗАМЕН) ---
 // --- ПРОВЕРКА СЛОВ (СЕССИЯ ТРЕНИРОВКИ) ---
    if (user.botState.includes('QUIZ_SESSION')) {
      await ctx.sendChatAction('typing');
      
      // Читаем текущее состояние сессии
      const session = JSON.parse(user.botState);
      const wordId = session.current;
      
      // Проверяем ответ через LLM (функция checkWordQuiz делает всё как раньше)
      const result = await checkWordQuiz(telegramId, wordId, text);
      
      if (result.isTypo) {
        // Если опечатка — даем второй шанс, не меняем состояние сессии
        return ctx.reply(result.feedback, Markup.keyboard([['❌ Завершить тренировку']]).resize());
      }
      
      // Если ответ точный или совсем неверный, обновляем статистику
      if (result.feedback.includes("wrong") || result.newState === 'IDLE') { 
        // Небольшой хак: checkWordQuiz возвращает IDLE при correct и wrong. 
        // Мы сами посчитаем статистику, просто опираясь на внутреннюю логику.
        // Но для надежности лучше доверять базе (score): если он стал 0, значит ответил неверно.
        const updatedWord = await prisma.vocabulary.findUnique({ where: { id: wordId } });
        if (updatedWord && updatedWord.score > 0) {
          session.correct += 1;
        } else {
          session.wrong += 1;
        }
      }

      // Убираем проверенное слово из очереди
      session.queue = session.queue.filter((id: number) => id !== wordId);

      // Проверяем, остались ли еще слова
      if (session.queue.length > 0) {
        // Берем следующее слово
        session.current = session.queue[0];
        
        // Сохраняем обновленную сессию
        await prisma.user.update({ 
          where: { id: telegramId }, 
          data: { botState: JSON.stringify(session) } 
        });

        // Достаем текст следующего слова
        const nextWord = await prisma.vocabulary.findUnique({ where: { id: session.current } });
        
        return ctx.reply(`${result.feedback}\n\nСледующее слово (${session.total - session.queue.length + 1}/${session.total}):\nКак будет по-немецки: <b>${nextWord?.translation}</b>?`, {
          parse_mode: 'HTML',
          ...Markup.keyboard([['❌ Завершить тренировку']]).resize()
        });
      } else {
        // Очередь пуста! Выдаем отчет и возвращаем IDLE
        await prisma.user.update({ where: { id: telegramId }, data: { botState: 'IDLE' } });
        
        const report = `🏁 <b>Тренировка завершена!</b>\n\n` +
                       `✅ Правильно: <b>${session.correct}</b>\n` +
                       `❌ Ошибок: <b>${session.wrong}</b>\n\n` +
                       `Возвращаемся к обычному общению.`;
                       
        return ctx.reply(`${result.feedback}\n\n${report}`, { parse_mode: 'HTML', ...mainMenu });
      }
    }
    // ------------------------------------
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
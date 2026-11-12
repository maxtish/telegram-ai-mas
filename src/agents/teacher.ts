import OpenAI from 'openai';
import prisma from '../database';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function analyzeMistakes(userId: bigint) {
  console.log(`[Teacher] Запуск фонового анализа для пользователя ${userId}...`);

  // 1. Берем последние 10 сообщений диалога
  const recentMessages = await prisma.message.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 10
  });

  // Если диалог еще слишком короткий, анализировать нечего
  if (recentMessages.length < 4) return;

  // 2. Формируем текст диалога для анализа
  const dialogText = recentMessages
    .reverse()
    .map(m => `${m.sender === 'USER' ? 'Студент' : 'Бот'}: ${m.content}`)
    .join('\n');

  // 3. Строгий промпт, чтобы ИИ вернул только JSON
  const systemPrompt = `Ты методист немецкого языка. 
Проанализируй диалог между Студентом и Ботом. 
Найди 1-2 главные грамматические или лексические ошибки Студента.
Верни результат СТРОГО в формате JSON. Если ошибок нет, верни пустой массив.
Формат:
{
  "items": [
    {
      "wordOrRule": "Название правила или слово (например: Dativ с предлогом mit)",
      "notes": "Короткая подсказка для бота (например: Студент забывает менять артикль. Задай вопрос с предлогом mit)"
    }
  ]
}`;

  try {
    // 4. Запрос к дешевой и быстрой модели
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: dialogText }
      ],
      response_format: { type: "json_object" },
    });

    const result = JSON.parse(completion.choices[0]?.message?.content || '{"items":[]}');

    // 5. Сохраняем найденные ошибки в базу
    for (const item of result.items) {
      // Проверяем, не добавляли ли мы уже это правило
      const existing = await prisma.vocabulary.findFirst({
        where: { userId, wordOrRule: item.wordOrRule }
      });

      if (!existing) {
        await prisma.vocabulary.create({
          data: {
            userId,
            wordOrRule: item.wordOrRule,
            status: 'needs_practice',
            notes: item.notes
          }
        });
        console.log(`[Teacher] Найдена ошибка. В словарь добавлено: ${item.wordOrRule}`);
      }
    }
  } catch (error) {
    console.error("[Teacher] Ошибка при анализе текста:", error);
  }
}


// ============================================================================
// 1. ЗАПУСК ИЛИ ВОЗОБНОВЛЕНИЕ УРОКА
// ============================================================================
export async function startTeacherSession(userId: bigint): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return "Ошибка загрузки профиля.";

  const summaryPrompt = user.lessonSummary
    ? `\n\nВы ПРОДОЛЖАЕТЕ прошлый урок. Резюме ваших прошлых занятий:\n${user.lessonSummary}\n\nОбязательно учитывай это резюме. НЕ давай на перевод те фразы и слова, которые вы уже прошли.`
    : "";

  // Вытаскиваем интересы, чтобы строить на их основе подсказки
  const userInterests = user.interests.length > 0
    ? `Интересы ученика для примеров: ${user.interests.join(', ')}.`
    : "";

  const prompt = `Ты строгий, но поддерживающий учитель немецкого языка.
Ученик имеет уровень ${user.learningLevel}, тема для тренировки: "${user.learningTopic}". ${userInterests}${summaryPrompt}

Сгенерируй ОДНО короткое, жизненное предложение на русском для перевода на немецкий по этой теме.

В качестве подсказки (hint) НЕ давай перевод слов из самого задания. Вместо этого напиши короткий ПРИМЕР на немецком с абсолютно ТАКОЙ ЖЕ грамматической структурой (порядок слов, падежи, время), но с ДРУГИМИ словами, опираясь на интересы ученика.
Например, если задание про мотоциклы ("Я должен заменить масло"), подсказка может быть про 3D-печать: "Аналогичная структура: Ich muss das Modell drucken".

Верни СТРОГО JSON: 
{ 
  "russianSentence": "Текст предложения", 
  "hint": "Текст подсказки по аналогии",
  "correctGerman": "Правильный перевод" 
}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "system", content: prompt }],
    response_format: { type: "json_object" }
  });

  const data = JSON.parse(completion.choices[0]?.message?.content || '{}');

  const text = `🎯 <b>Новое задание</b>\n\n` +
    `💡 <i>Подсказка: ${data.hint}</i>\n\n` +
    `➡️ <b>Переведи:</b>\n${data.russianSentence}`;

  await prisma.message.create({ data: { userId, sender: 'BOT', content: text } });

  return text;
}

// ============================================================================
// 2. ПРОВЕРКА ПЕРЕВОДА С УЧЕТОМ КОНТЕКСТА УРОКА
// ============================================================================
export async function processTeacherTask(userId: bigint, userText: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return "Ошибка профиля.";

  // 1. ВЫГРУЖАЕМ ИСТОРИЮ УРОКА (последние 10 сообщений)
  const recentMessages = await prisma.message.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 10
  });

  // Разворачиваем в хронологическом порядке (старые сверху, новые снизу)
  recentMessages.reverse();

  // Достаем последнее задание для базы данных (вытаскиваем текст после "Переведи:")
  let lastTask = "Неизвестное предложение";
  const lastBotMsg = recentMessages.slice().reverse().find(m => m.sender === 'BOT');
  if (lastBotMsg && lastBotMsg.content.includes('Переведи:\n')) {
    lastTask = lastBotMsg.content.split('Переведи:\n')[1].trim();
  }

  // 2. Ищем старые ошибки (Интервальное повторение)
  const dueMistakes = await prisma.grammarMistake.findMany({
    where: { userId, nextReview: { lte: new Date() } }
  });

  // 3. АЛГОРИТМ 70/30
  const isReviewTask = Math.random() < 0.30 && dueMistakes.length > 0;
  let nextTaskPrompt = "";

  if (isReviewTask) {
    const mistake = dueMistakes[Math.floor(Math.random() * dueMistakes.length)];
    nextTaskPrompt = `ЗАДАЧА 2: Следующее задание — ПОВТОРЕНИЕ СТАРОЙ ОШИБКИ. 
Дай на перевод вот это предложение: "${mistake.russianSentence}".`;
  } else {
    nextTaskPrompt = `ЗАДАЧА 2: Следующее задание — НОВОЕ ПРЕДЛОЖЕНИЕ. 
Тема: "${user.learningTopic}", Уровень: ${user.learningLevel}. 
Обязательно посмотри в историю чата выше и НЕ повторяй те слова и предложения, которые мы уже переводили в этой сессии!`;
  }



  // 4. СОБИРАЕМ МАССИВ СООБЩЕНИЙ ДЛЯ OPENAI
  // Если у нас уже есть сжатое резюме прошлых блоков, передаем его Учителю
  // 4. СОБИРАЕМ МАССИВ СООБЩЕНИЙ ДЛЯ OPENAI
  const summaryPrompt = user.lessonSummary ? `\n\nСЖАТОЕ РЕЗЮМЕ ПРОШЛОЙ ЧАСТИ УРОКА:\n${user.lessonSummary}` : "";
  const userInterests = user.interests.length > 0 ? `Интересы ученика: ${user.interests.join(', ')}.` : "";

  const messagesArray: any[] = [
    {
      role: "system",
      content: `Ты профессиональный репетитор немецкого. Твоя задача — вести урок с учеником (Уровень: ${user.learningLevel}, Тема: "${user.learningTopic}").${summaryPrompt}\n\nНиже будет приведена история вашей текущей сессии.`
    }
  ];

  recentMessages.forEach(msg => {
    if (msg.content !== userText) {
      messagesArray.push({
        role: msg.sender === 'BOT' ? 'assistant' : 'user',
        content: msg.content
      });
    }
  });

  messagesArray.push({
    role: "system",
    content: `Ученик только что прислал свой вариант перевода: "${userText}".
Его нужно сравнить с заданием: "${lastTask}".

ЗАДАЧА 1 (ОЦЕНКА):
Оцени перевод. Прощай мелкие опечатки, но строго суди грамматику и порядок слов.

${nextTaskPrompt}

Для нового задания придумай подсказку (nextHint). НЕ переводи слова из нового задания! Вместо этого дай ПРИМЕР на немецком с ТАКОЙ ЖЕ грамматической структурой, но на другую тему, используя интересы ученика (${userInterests}).
Например: "Пример похожей структуры: Ich habe die Platine gelötet".

Верни СТРОГО JSON:
{
  "isCorrect": boolean,
  "userVariant": "Вариант ученика",
  "correctVariant": "Идеальный правильный перевод",
  "explanation": "Объяснение ошибки (или похвала) на русском.",
  "mistakeCategory": "Категория ошибки (или null)",
  "nextRussianSentence": "Следующее предложение на русском",
  "nextHint": "Подсказка-аналогия для следующего задания",
  "nextCorrectGerman": "Идеальный перевод следующего предложения"
}`
  });



  // ОТПРАВЛЯЕМ В LLM
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: messagesArray,
    response_format: { type: "json_object" }
  });

  const data = JSON.parse(completion.choices[0]?.message?.content || '{}');


  // 5. ОБНОВЛЯЕМ БАЗУ ОШИБОК (Интервальное повторение)
  const existingMistake = await prisma.grammarMistake.findFirst({
    where: { userId, russianSentence: lastTask }
  });

  if (!data.isCorrect) {
    // Если ошибся — сбрасываем прогресс и спрашиваем снова завтра
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    if (existingMistake) {
      await prisma.grammarMistake.update({
        where: { id: existingMistake.id },
        data: { streak: 0, nextReview: tomorrow }
      });
    } else {
      await prisma.grammarMistake.create({
        data: {
          userId,
          russianSentence: lastTask,
          correctGerman: data.correctedLastGerman || "Определяется ИИ",
          mistakeCategory: data.mistakeCategory || "Грамматика",
          nextReview: tomorrow
        }
      });
    }
  } else if (data.isCorrect && existingMistake) {
    // Если правильно перевел СТАРУЮ ошибку — увеличиваем интервал (2, 4, 6 дней...)
    const newStreak = existingMistake.streak + 1;
    const daysToAdd = newStreak * 2;
    await prisma.grammarMistake.update({
      where: { id: existingMistake.id },
      data: { streak: newStreak, nextReview: new Date(Date.now() + daysToAdd * 24 * 60 * 60 * 1000) }
    });
  }

  // 6. ФОРМИРУЕМ ОТВЕТ
  const icon = data.isCorrect ? "✅ <b>Отлично!</b>" : "❌ <b>Есть ошибка!</b>";
  const replyText = `${icon}\n\n` +
    `🗣 <b>Твой вариант:</b> <i>${data.userVariant}</i>\n` +
    `🎓 <b>Правильно:</b> <b>${data.correctVariant}</b>\n\n` +
    `🧠 <b>Объяснение:</b>\n${data.explanation}\n\n` +
    `➖➖➖➖➖➖➖➖➖➖\n\n` +
    `🎯 <b>Следующее задание:</b>\n` +
    `💡 <i>Подсказка: ${data.nextHint}</i>\n\n` +
    `➡️ <b>Переведи:</b>\n${data.nextRussianSentence}`;

  // Сохраняем в историю диалога и отправляем
  await prisma.message.create({ data: { userId, sender: 'BOT', content: replyText } });

  // Запускаем Архиватор в фоне
  compressTeacherContext(userId).catch(console.error);

  return replyText;
}


// ============================================================================
// АРХИВАТОР: Сжатие контекста урока (Rolling Context)
// ============================================================================
async function compressTeacherContext(userId: bigint) {
  // Берем последние 16 сообщений
  const messages = await prisma.message.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 16
  });

  // Если сообщений мало — ничего не делаем
  if (messages.length < 14) return;

  const user = await prisma.user.findUnique({ where: { id: userId } });

  // Оставляем 2 самых свежих сообщения (вопрос бота и ответ юзера), чтобы не сломать текущий ход урока
  const messagesToKeep = messages.slice(0, 2);
  const messagesToCompress = messages.slice(2).reverse(); // Старые сверху вниз

  const dialogText = messagesToCompress.map(m => `${m.sender === 'BOT' ? 'Учитель' : 'Студент'}: ${m.content}`).join('\n');

  const prompt = `Ты аналитик урока немецкого языка.
Текущее резюме прошлых уроков: ${user?.lessonSummary || 'Пока нет'}

Вот кусок старой переписки (он будет удален):
${dialogText}

Составь очень краткое и емкое резюме (до 50-70 слов) для Учителя: какие конструкции и слова тренировали, какие типичные ошибки делал студент в этом блоке. 
Твое резюме ПОЛНОСТЬЮ заменит эту переписку, поэтому сохрани суть!`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o", // Дешевая и быстрая модель идеально подходит для саммаризации
      messages: [{ role: "system", content: prompt }]
    });

    const newSummary = completion.choices[0]?.message?.content || "";

    // 1. Обновляем саммари в базе
    await prisma.user.update({
      where: { id: userId },
      data: { lessonSummary: newSummary }
    });

    // 2. Удаляем старые сообщения
    const idsToDelete = messagesToCompress.map(m => m.id);
    await prisma.message.deleteMany({
      where: { id: { in: idsToDelete } }
    });

    console.log(`[Teacher] Контекст сжат. Удалено ${idsToDelete.length} старых сообщений.`);
  } catch (error) {
    console.error("[Teacher] Ошибка при сжатии контекста:", error);
  }
}

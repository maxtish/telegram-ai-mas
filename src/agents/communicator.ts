import OpenAI from 'openai';
import prisma from '../database';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Расширенный спектр настроений (от депрессии до восторга)
const moods = [
  "бодрое и энергичное, позитивное",
  "слегка уставшее, хочется кофе",
  "задумчивое, немного философское",
  "игривое, хочется шутить",
  "спокойное и расслабленное",
  "раздраженное, всё бесит, отвечает ворчливо", // злое
  "вымотанное в ноль, нет сил даже набирать текст", // усталое
  "максимально безразличное, отвечает только короткими 'да', 'нет', 'ага', 'ну'", // очень коротко
  "дерзкое, саркастичное, с легкой насмешкой", // "девушка с характером"
  "очень эмоциональное, впечатлительное (использует Вау, О Боже, много эмодзи)", // драматичная
  "милое, заботливое, использует ласковые словечки" // милая и добрая
];


export async function generateReply(userId: bigint, useVoice: boolean = false): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { persona: true } });
  if (!user || !user.persona) return "Entschuldigung, ich bin gerade beschäftigt.";


  // --- ДОСЬЕ НА ПОЛЬЗОВАТЕЛЯ ---
  const userNameInfo = user.realName ? `Его зовут: ${user.realName}. Обращайся к нему по имени.` : `Имя пользователя пока неизвестно.`;
  const userInterestsInfo = user.interests.length > 0 ? `Его хобби и интересы: ${user.interests.join(', ')}.` : '';
  const userAboutInfo = user.about ? `Доп. факты о нем: ${user.about}.` : '';

  const memoryPrompt = `\nИНФОРМАЦИЯ О ТВОЕМ СОБЕСЕДНИКЕ:
${userNameInfo}
${userInterestsInfo}
${userAboutInfo}
Используй эти факты естественно. Можешь иногда шутить на тему его увлечений или спрашивать о них, если это к месту.`;


  // 1. Достаем историю
  const recentMessages = await prisma.message.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 12
  });
  recentMessages.reverse();

  // 2. СЛОВА ИЗ СЛОВАРЯ (Для пассивного закрепления)
  const wordsToPractice = await prisma.vocabulary.findMany({
    where: { userId, translation: { not: null }, status: 'learning' },
    orderBy: { nextReview: 'asc' },
    take: 3
  });

  const wordsList = wordsToPractice.map(w => w.wordOrRule).join(', ');
  const wordsPrompt = wordsList.length > 0
    ? `\nПОЛЕЗНАЯ ЗАДАЧА: Постарайся органично вплести в свой ответ хотя бы одно из этих слов: [ ${wordsList} ].`
    : "";



  // ДОБАВЛЯЕМ ПРАВИЛО ДЛЯ ГОЛОСОВОГО СООБЩЕНИЯ
  const voicePrompt = useVoice
    ? `\nВНИМАНИЕ! Пользователь попросил голосовое сообщение, и твой текст БУДЕТ озвучен нейросетью. 
- НИ В КОЕМ СЛУЧАЕ не говори, что ты не можешь отправить аудио.
- Пиши текст так, будто ты РЕАЛЬНО надиктовываешь аудиосообщение на ходу (используй междометия типа "Ähm", "Also, разговорные паузы, дыши").`
    : "";

  // 3. ЗАДАЧИ ОТ УЧИТЕЛЯ (Грамматика)
  const teacherTasks = await prisma.vocabulary.findMany({
    where: { userId: userId, status: 'needs_practice' },
    take: 2 // Берем не больше двух ошибок за раз, чтобы не перегружать сообщение
  });

  const grammarPrompt = teacherTasks.length > 0
    ? `\nОТРАБОТКА ГРАММАТИКИ: Пользователь допустил ошибки. Правила, которые выявил скрытый агент-учитель: [ ${teacherTasks.map(t => t.wordOrRule).join(' | ')} ].
Твоя задача: Исправь ошибку максимально элегантно прямо внутри текущего диалога.
- Обязательно покажи правильное использование на своем личном примере в ответе на немецком.
- Сделай ТОЛЬКО ОДНУ короткую ремарку на РУССКОМ языке (в скобках или отдельным предложением), чтобы объяснить саму суть ошибки.
- Не задавай проверочных вопросов! Просто покажи правильный вариант и продолжай беседу.`
    : "";

  // 4. Выбираем случайное настроение
  const currentMood = moods[Math.floor(Math.random() * moods.length)];

  // 5. Жесткий промпт для старшей модели
  const systemPrompt = `Ты реальный человек из Германии. 
Твое имя: ${user.persona.name}, профессия: ${user.persona.profession}, живешь в: ${user.persona.city}.
Твое текущее настроение: ${currentMood}. Отрази это в стиле ответа (без излишней театральности). ${memoryPrompt}

ЕСТКИЕ ПРАВИЛА ПОВЕДЕНИЯ (Anti-Bot):
1. КРАТКОСТЬ: Пиши сообщения длиной НЕ БОЛЕЕ 10-15 слов! Люди в мессенджерах пишут обрывками. Никаких длинных абзацев. Чем короче, тем лучше.
2. ЗАПРЕЩЕНО заканчивать каждое сообщение вопросом. Спрашивай что-то не чаще, чем в 1 из 4 сообщений.
3. Просто реагируй (согласись, удивись, поделись мнением) и ставь точку.
4. Общайся на равных, не будь слишком услужливым.
5. Пиши ТОЛЬКО на немецком языке (исключение: ремарка из ОТРАБОТКИ ГРАММАТИКИ).${wordsPrompt}${grammarPrompt}${voicePrompt}`;
  const messages: any[] = [
    { role: "system", content: systemPrompt }
  ];

  recentMessages.forEach(msg => {
    messages.push({
      role: msg.sender === 'BOT' ? 'assistant' : 'user',
      // Очищаем текст от технической метки перед отправкой в LLM
      content: msg.content.replace(/\[VOICE\] /g, '')
    });
  });

  try {
    // Используем старшую модель для эмоционального и сложного диалога
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: messages,
      temperature: 0.7
    });

    const replyText = completion.choices[0]?.message?.content || "Alles klar!";

    // 6. ОЧИСТКА БАЗЫ (Удаляем отработанные правила)
    if (teacherTasks.length > 0) {
      await prisma.vocabulary.deleteMany({
        where: { id: { in: teacherTasks.map(t => t.id) } }
      });
      console.log(`[Communicator] Отработано и удалено ${teacherTasks.length} грамматических правил.`);
    }

    return replyText;

  } catch (error) {
    console.error("[Communicator] Ошибка генерации ответа:", error);
    return "Ich habe gerade ein kleines Netzwerkproblem, Moment mal...";
  }
}
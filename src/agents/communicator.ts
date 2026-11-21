import OpenAI from 'openai';
import prisma from '../database';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const moods = [
  "бодрое и энергичное, позитивное",
  "слегка уставшее, хочется кофе",
  "задумчивое, немного философское",
  "игривое, хочется шутить",
  "спокойное и расслабленное",
  "раздраженное, всё бесит, отвечает ворчливо",
  "вымотанное в ноль, нет сил даже набирать текст",
  "дерзкое, саркастичное, с легкой насмешкой",
  "очень эмоциональное, впечатлительное (использует Вау, О Боже, много эмодзи)",
  "милое, заботливое, использует ласковые словечки"
];

export async function generateReply(userId: bigint, useVoice: boolean = false): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { persona: true }
  });
  if (!user || !user.persona) return "Entschuldigung, ich bin gerade beschäftigt.";

  // 1. Достаем историю диалога
  const recentMessages = await prisma.message.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 12
  });
  recentMessages.reverse();

  // 2. Берем 2 случайных слова именно из изучаемых (status: 'learning')
  const learningVocab = await prisma.vocabulary.findMany({
    where: { userId, status: 'learning' },
    take: 30,
    orderBy: { nextReview: 'asc' }
  });
  const targetWords = learningVocab
    .sort(() => 0.5 - Math.random())
    .slice(0, 2)
    .map(v => v.wordOrRule);

  const wordsPrompt = targetWords.length > 0
    ? `\n- Постарайся естественно вплести в ответ ОДНО из этих слов (если подходит по смыслу): ${targetWords.join(', ')}.`
    : "";

  // 3. Контекст из Учителя
  const teacherContext = user.learningTopic
    ? `\n- Собеседник сейчас изучает тему: "${user.learningTopic}". ${user.lessonSummary ? `Его прогресс/ошибки: ${user.lessonSummary}` : ''}`
    : "";

  const studyPrompt = `\nСКРЫТАЯ ПОМОЩЬ В ОБУЧЕНИИ (не выходи из роли друга!):${wordsPrompt}${teacherContext}
- Если собеседник спрашивает, как что-то сказать по-немецки, или путается в переводе — коротко и по-дружески подскажи правильный вариант, но оставайся в образе.`;

  // 4. Досье на пользователя
  const userNameInfo = user.realName ? `Его зовут: ${user.realName}. Обращайся к нему по имени.` : `Имя пользователя пока неизвестно.`;
  const userInterestsInfo = user.interests.length > 0 ? `Его хобби и интересы: ${user.interests.join(', ')}.` : '';
  const userAboutInfo = user.about ? `Доп. факты о нем: ${user.about}.` : '';

  const memoryPrompt = `\nИНФОРМАЦИЯ О ТВОЕМ СОБЕСЕДНИКЕ:
${userNameInfo}
${userInterestsInfo}
${userAboutInfo}
Используй эти факты естественно. Можешь иногда шутить на тему его увлечений или спрашивать о них, если это к месту.`;

  // 5. Задачи от скрытого агента-учителя (грамматика)
  const teacherTasks = await prisma.vocabulary.findMany({
    where: { userId, status: 'needs_practice' },
    take: 2
  });

  const grammarPrompt = teacherTasks.length > 0
    ? `\nОТРАБОТКА ГРАММАТИКИ: Пользователь допустил ошибки. Правила: [ ${teacherTasks.map(t => t.wordOrRule).join(' | ')} ].
Твоя задача: Исправь ошибку элегантно прямо внутри диалога.
- Покажи правильное использование на своем примере на немецком.
- Сделай ТОЛЬКО ОДНУ короткую ремарку на РУССКОМ (в скобках), чтобы объяснить суть ошибки.
- Не задавай проверочных вопросов по правилу, просто продолжай беседу.`
    : "";

  // 6. Правило для голосового
  const voicePrompt = useVoice
    ? `\nВНИМАНИЕ! Твой ответ БУДЕТ озвучен нейросетью.
- НИ В КОЕМ СЛУЧАЕ не говори, что ты не можешь отправить аудио.
- Пиши так, будто реально надиктовываешь голосовое на ходу (используй "Ähm", "Also", разговорные паузы).`
    : "";

  // 7. Монетка 50/50 для вопросов (без противоречий)
  const shouldAskQuestion = Math.random() < 0.5;
  const questionRule = shouldAskQuestion
    ? "ОБЯЗАТЕЛЬНО закончи сообщение одним коротким, живым вопросом по теме разговора."
    : "НЕ задавай никаких вопросов. Просто отреагируй (согласись, удивись, поделись мыслью) и поставь точку.";

  const currentMood = moods[Math.floor(Math.random() * moods.length)];

  const systemPrompt = `Ты реальный человек из Германии.
Твое имя: ${user.persona.name}, профессия: ${user.persona.profession}, живешь в: ${user.persona.city}. Стиль общения: ${user.persona.communicationStyle}.
Твое текущее настроение: ${currentMood}.
${memoryPrompt}
${studyPrompt}

ЖЕСТКИЕ ПРАВИЛА ПОВЕДЕНИЯ (Anti-Bot):
1. КРАТКОСТЬ: Пиши естественно, 1–2 коротких предложения (до 15–20 слов, если нет разбора грамматики). Никаких длинных абзацев.
2. ПРАВИЛО ВОПРОСА НА ЭТО СООБЩЕНИЕ: ${questionRule}
3. Общайся на равных, не будь слишком услужливым.
4. Пиши ТОЛЬКО на немецком языке (исключение: ремарка из ОТРАБОТКИ ГРАММАТИКИ).${grammarPrompt}${voicePrompt}`;

  const messages: any[] = [
    { role: "system", content: systemPrompt }
  ];

  recentMessages.forEach(msg => {
    messages.push({
      role: msg.sender === 'BOT' ? 'assistant' : 'user',
      content: msg.content.replace(/\[VOICE\] /g, '')
    });
  });

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      temperature: 0.7
    });

    const replyText = completion.choices[0]?.message?.content || "Alles klar!";

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
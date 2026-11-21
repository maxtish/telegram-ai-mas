import OpenAI from 'openai';
import prisma from '../database';
import { messageQueue } from '../workers/scheduler';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function planDay(userId: bigint) {
  console.log(`[Planner] Создаю расписание для ${userId}...`);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { persona: true }
  });

  if (!user || !user.persona) return;

  // Если пользователь сейчас в режиме Учителя — не планируем отвлекающие пинги
  if (user.botState !== 'IDLE') {
    console.log(`[Planner] Пропуск: пользователь ${userId} сейчас в режиме ${user.botState}.`);
    return;
  }

  const topics = [...user.interests];
  if (user.learningTopic) topics.push(user.learningTopic);
  const pickedTopic = topics.length > 0
    ? topics[Math.floor(Math.random() * topics.length)]
    : "планы на день";

  const prompt = `Ты планировщик инициативных сообщений для персонажа ${user.persona.name} (${user.persona.profession} из ${user.persona.city}).
Собеседник: ${user.realName || 'друг'}. Его интересы/тема обучения: "${pickedTopic}".

ЗАДАЧА:
Запланируй 1 или 2 живых инициативных сообщения на ближайшие часы (например, через 4–6 часов, то есть от 14400 до 21600 секунд).

ЗАПРЕЩЕНО:
- Писать банальности про погоду, "как спалось", "пью кофе" и сухое "wie geht's?".
- Выдумывать скучные или нелепые истории.

В поле "context" напиши короткую идею/зацепку для сообщения на немецком (1–2 предложения) по теме "${pickedTopic}" — вопрос о том, как продвигаются дела, или короткая живая мысль. Можно начать с "Servus" или "Hey".

Верни СТРОГО JSON в таком формате:
{
  "events": [
    {
      "delaySeconds": 18000,
      "context": "Servus! Wie läuft es eigentlich mit ...?"
    }
  ]
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-6-luna",
      messages: [{ role: "system", content: prompt }],
      response_format: { type: "json_object" },

    });

    const result = JSON.parse(completion.choices[0]?.message?.content || '{"events":[]}');

    if (!Array.isArray(result.events) || result.events.length === 0) {
      console.log(`[Planner] Нет запланированных событий для ${userId}.`);
      return;
    }

    for (const event of result.events) {
      if (!event.delaySeconds || !event.context) continue;

      await messageQueue.add('send-message', {
        type: 'proactive-message',
        userId: userId.toString(),
        context: event.context
      }, {
        delay: event.delaySeconds * 1000
      });

      console.log(`[Planner] Запланировано сообщение через ${event.delaySeconds} сек. Контекст: ${event.context}`);
    }
  } catch (error) {
    console.error("[Planner] Ошибка генерации расписания:", error);
  }
}
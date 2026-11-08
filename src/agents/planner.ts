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
  const persona = user.persona;

  const prompt = `Ты сценарист жизней. Твоя задача придумать 2 коротких события, которые произойдут с человеком сегодня, из-за которых он напишет своему другу (пользователю) в Telegram.
Личность: ${persona.name}, работает как ${persona.profession}, живет в ${persona.city}. Хобби: ${persona.hobbies.join(', ')}.

ВАЖНО: Для тестирования запланируй первое событие через 30 секунд, а второе через 90 секунд.
Верни СТРОГО JSON формат.
Пример:
{
  "events": [
    { "delaySeconds": 30, "context": "Едет в метро на работу, жалуется на толпу и погоду" },
    { "delaySeconds": 90, "context": "Увидел смешную собаку на улице, хочет поделиться эмоциями" }
  ]
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: prompt }],
      response_format: { type: "json_object" }
    });

    const result = JSON.parse(completion.choices[0]?.message?.content || '{"events":[]}');

    for (const event of result.events) {
      // Кладём задачу в очередь. BullMQ принимает задержку в миллисекундах.
      await messageQueue.add('send-message', {
        type: 'proactive-message',
        userId: userId.toString(), // В JSON нельзя передавать BigInt напрямую
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
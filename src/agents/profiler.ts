import OpenAI from 'openai';
import prisma from '../database';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function analyzeUserProfile(userId: bigint, text: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return;

    const prompt = `Ты аналитик профиля. Прочитай сообщение пользователя и найди факты о нем.
Его текущие данные в базе:
Имя: ${user.realName || 'Неизвестно'}
Интересы: ${user.interests.join(', ') || 'Пусто'}
О себе: ${user.about || 'Пусто'}

Сообщение пользователя: "${text}"

Есть ли в тексте новая информация о пользователе? (Его имя, хобби, работа, семья, предпочтения).
Если ничего нового нет, верни hasNewFacts: false.
Если есть, аккуратно обнови поля. Старые интересы НЕ удаляй, а дополняй.

Верни СТРОГО JSON:
{
  "hasNewFacts": true | false,
  "realName": "Имя пользователя (если назвал)",
  "interests": ["список", "всех", "интересов", "с учетом", "новых"],
  "about": "Краткая выжимка фактов о пользователе (например: Работает механиком, есть сын, любит программировать)"
}`;

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini", // Дешевая модель идеально справится с парсингом
            messages: [{ role: "system", content: prompt }],
            response_format: { type: "json_object" }
        });

        const data = JSON.parse(completion.choices[0]?.message?.content || '{"hasNewFacts":false}');

        if (data.hasNewFacts) {
            await prisma.user.update({
                where: { id: userId },
                data: {
                    realName: data.realName || user.realName,
                    interests: data.interests || user.interests,
                    about: data.about || user.about
                }
            });
            console.log(`[Profiler] Обновлено досье пользователя ${userId}`);
        }
    } catch (error) {
        console.error("[Profiler] Ошибка:", error);
    }
}
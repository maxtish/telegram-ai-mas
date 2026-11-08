import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function generatePersona() {
  console.log("Генерируем новую личность...");
  
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini", // Дешевая и быстрая модель, отлично подходит для задач форматирования
    messages: [
      {
        role: "system",
        content: `Ты генератор реалистичных персонажей для Telegram-бота. 
Цель бота: непринужденное общение с пользователем для практики немецкого языка.
Создай случайного жителя Германии (20-40 лет). 
Ответь СТРОГО в формате JSON со следующими ключами:
{
  "name": "Имя (только имя)",
  "age": 28,
  "profession": "Профессия на русском/немецком",
  "city": "Город в Германии",
  "hobbies": ["хобби 1", "хобби 2"],
  "communicationStyle": "Краткое описание стиля: как часто пишет, использует ли голосовые, эмодзи, сленг (например: Пишет коротко, часто использует эмодзи, дружелюбный)"
}`
      }
    ],
    response_format: { type: "json_object" },
  });

  const result = JSON.parse(completion.choices[0].message.content || "{}");
  return result;
}
require('dotenv').config();
import OpenAI, { toFile } from 'openai'; // <-- Добавили toFile

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const voices: ("nova" | "shimmer")[] = ["nova", "shimmer"];

// Генерация голоса (остается без изменений)
export async function generateVoice(text: string, personaId: number): Promise<Buffer> {
    const voiceIndex = personaId % voices.length;
    const response = await openai.audio.speech.create({
        model: "tts-1",
        voice: voices[voiceIndex],
        input: text,
        response_format: "opus"
    });
    return Buffer.from(await response.arrayBuffer());
}


// --- ПЕРЕВОД АУДИО В ТЕКСТ ---
export async function transcribeAudio(fileUrl: string): Promise<string> {
    // Скачиваем аудиофайл из Telegram
    const response = await fetch(fileUrl);
    // Конвертируем в формат, понятный OpenAI
    const file = await toFile(response, 'voice.ogg');

    // Отправляем в Whisper с жесткой затравкой
    const transcription = await openai.audio.transcriptions.create({
        file: file,
        model: "whisper-1",
        // Затравка (prompt) заставляет Whisper сохранить оригинальный язык и не переводить
        prompt: "Das ist ein Dialog",
        temperature: 0
    });

    // ВЫВОДИМ В КОНСОЛЬ, ЧТОБЫ ВИДЕТЬ, ЧТО УСЛЫШАЛ БОТ
    console.log(`[Whisper] Распознано из аудио: "${transcription.text}"`);

    return transcription.text;
}
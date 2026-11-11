import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Оставляем только женские голоса
const voices: ("nova" | "shimmer")[] = ["nova", "shimmer"];

export async function generateVoice(text: string, personaId: number): Promise<Buffer> {
    // Выбираем один из женских голосов на основе ID персоны
    const voiceIndex = personaId % voices.length;

    const response = await openai.audio.speech.create({
        model: "tts-1",
        voice: voices[voiceIndex],
        input: text,
        response_format: "opus"
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer;
}
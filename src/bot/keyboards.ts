import { Markup } from 'telegraf';

export const mainMenu = Markup.keyboard([
    ['📘 Добавить слова', '🧠 Повторять слова'],
    ['📜 Мой словарь', '🔄 Сменить собеседника'],
    ['🆘 Помощь'] // <-- Новая кнопка
]).resize();

export const cancelKeyboard = Markup.keyboard([
    ['❌ Отмена']
]).resize();

export const quizKeyboard = Markup.keyboard([
    ['❌ Завершить тренировку']
]).resize();
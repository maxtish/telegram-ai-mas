import { Markup } from 'telegraf';

export const mainMenu = Markup.keyboard([
    ['📘 Добавить слова', '🧠 Повторять слова'],
    ['📜 Мой словарь', '🔄 Сменить собеседника'],
    ['🎓 Режим Учителя', '🆘 Помощь'] // <-- Добавили Учителя
]).resize();

// --- ВЫБОР УРОВНЯ ЯЗЫКА ---
export const levelMenu = Markup.keyboard([
    ['A1', 'A2', 'B1'],
    ['B2', 'C1', 'C2'],
    ['❌ Отмена']
]).resize();

// --- МЕНЮ ВО ВРЕМЯ УРОКА ---
export const teacherMenu = Markup.keyboard([
    ['🛑 Закончить урок']
]).resize();


export const cancelKeyboard = Markup.keyboard([
    ['❌ Отмена']
]).resize();

export const quizKeyboard = Markup.keyboard([
    ['❌ Завершить тренировку']
]).resize();
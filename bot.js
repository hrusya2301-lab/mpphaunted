// bot.js
const SERVER_URL = "wss://mpphaunted.onrender.com";
const BOT_NAME = "HauntedBot";
const BOT_COLOR = "#00e5ff";

console.log(`[BOT] Пытаюсь подключиться к ${SERVER_URL}...`);

const ws = new WebSocket(SERVER_URL);

ws.onopen = () => {
    console.log("[BOT] Подключение установлено! Захожу в Lobby...");
    ws.send(JSON.stringify({
        type: "join",
        name: BOT_NAME,
        color: BOT_COLOR,
        room: "Lobby",
        secretKey: null,
        invisible: false,
        isBot: true
    }));
};

ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    switch (data.type) {
        case "playerList":
            break;
        case "chatMessage":
            if (data.name !== BOT_NAME) {
                handleChatCommand(data.text, data.name);
            }
            break;
    }
};

function handleChatCommand(text, senderName) {
    const lowerText = text.toLowerCase();
    
    if (lowerText.includes("привет") || lowerText.includes("hello")) {
        sendChat(`Привет, ${senderName}! Я просто бот, но я умею играть на пианино. Напиши "!play" чтобы я сыграл ноту.`);
    } 
    else if (lowerText === "!play") {
        sendNote(60);
        sendChat("Я сыграл ноту C4!");
    }
    else if (lowerText === "!help") {
        sendChat("Мои команды: 'привет', '!play'.");
    }
}

function sendChat(text) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: "chatMessage",
            name: BOT_NAME,
            text: text,
            color: BOT_COLOR
        }));
    }
}

function sendNote(midi) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: "noteOn",
            midi: midi,
            instrument: "acoustic_grand_piano",
            isSynth: false
        }));
    }
}

ws.onclose = () => {
    console.log("[BOT] Соединение потеряно. Переподключение через 5 секунд...");
    setTimeout(() => {
        process.exit(1);
    }, 5000);
};
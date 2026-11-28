import { serve } from "bun";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const PORT = 3000;
const SECRET_OWNER_KEY = "hauntedIScoolcLAn20226"; 
const OWNER_CLIENT_ID = "VlADA_HAUNTED_001"; // Твой личный ID

const MIME_TYPES = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
};

const SYSTEM_ROOMS = ["Lobby", "test/awkward"];
const rooms = {
    "Lobby": { id: "Lobby", ownerId: null, visible: true, chatEnabled: true, onlyOwnerCanPlay: false, bgColor: "#1a0b2e", players: {} },
    "test/awkward": { id: "test/awkward", ownerId: null, visible: true, chatEnabled: true, onlyOwnerCanPlay: false, bgColor: "#1a0b2e", players: {} }
};

const sockets = {};
const bannedIPs = new Map(); 

function broadcastPlayers(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    
    const players = Object.values(room.players);
    for (const p of players) {
        const ws = sockets[p.id];
        if (ws && ws.readyState === WebSocket.OPEN) {
            const safePlayers = players.filter(vp => !vp.invisible || vp.isOwner).map(vp => ({
                id: vp.id,
                name: vp.name,
                color: vp.color,
                isOwner: vp.isOwner,
                isBot: vp.isBot,
                isMuted: vp.isMuted,
                invisible: vp.invisible
            }));
            ws.send(JSON.stringify({ type: "playerList", players: safePlayers }));
        }
    }
}

function broadcastRoomsList() {
    const roomsData = Object.values(rooms)
        .filter(r => r.visible)
        .map(r => ({
            id: r.id,
            ownerId: r.ownerId,
            players: Object.values(r.players).filter(p => !p.invisible).map(p => ({ name: p.name, color: p.color }))
        }));
    
    const msg = JSON.stringify({ type: "roomsList", rooms: roomsData });
    for (const ws of Object.values(sockets)) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
}

const server = serve({
    port: PORT,
    fetch(req, server) {
        const ip = server.requestIP(req)?.address || "unknown";
        const banInfo = bannedIPs.get(ip);
        if (banInfo) {
            if (Date.now() > banInfo.expireTime) bannedIPs.delete(ip); 
            else return new Response("Banned", { status: 403 }); 
        }

        if (server.upgrade(req, { data: { ip: ip } })) return;

        let url = new URL(req.url);
        let filePath = url.pathname === "/" ? "/piano.html" : url.pathname;
        let fullPath = join(import.meta.dir, filePath);

        if (existsSync(fullPath)) {
            const ext = fullPath.substring(fullPath.lastIndexOf("."));
            const mime = MIME_TYPES[ext] || "text/plain";
            return new Response(readFileSync(fullPath), { headers: { "Content-Type": mime } });
        }
        return new Response("Not Found", { status: 404 });
    },
    websocket: {
        open(ws) {
            const socketId = crypto.randomUUID();
            const ip = ws.data?.ip || "unknown";
            ws.data = { id: socketId, ip: ip, room: null, noteTimes: [], lastMessageTime: 0 };
            sockets[socketId] = ws;
        },
        message(ws, message) {
            const data = JSON.parse(message);
            const socketId = ws.data.id;
            let currentRoom = ws.data.room || null;

            switch (data.type) {
                case "join": {
                    const targetRoom = data.room || "Lobby";
                    
                    // ПРОВЕРКА ОВНЕРА (Ключ + Твой ID)
                    const isOwner = (data.secretKey === SECRET_OWNER_KEY) && (data.clientId === OWNER_CLIENT_ID);
                    
                    if (!rooms[targetRoom]) {
                        rooms[targetRoom] = { id: targetRoom, ownerId: isOwner ? socketId : null, visible: false, chatEnabled: true, onlyOwnerCanPlay: false, bgColor: "#000000", players: {} };
                    }

                    if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socketId]) {
                        delete rooms[currentRoom].players[socketId];
                        broadcastPlayers(currentRoom);
                    }

                    ws.data.room = targetRoom;
                    currentRoom = targetRoom;
                    
                    rooms[currentRoom].players[socketId] = {
                        id: socketId,
                        name: data.name,
                        color: data.color,
                        isOwner: isOwner,
                        isBot: data.isBot || false,
                        isMuted: false,
                        invisible: false
                    };

                    // Отправляем клиенту его ID, чтобы он знал, кто он
                    ws.send(JSON.stringify({ type: "welcome", myId: socketId, isOwner: isOwner }));
                    
                    broadcastPlayers(currentRoom);
                    broadcastRoomsList();
                    break;
                }
                // СМЕНА СВОЕГО ЦВЕТА
                case "selfAction": {
                    if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socketId]) {
                        if (data.action === "changeColor") {
                            rooms[currentRoom].players[socketId].color = data.newColor;
                            broadcastPlayers(currentRoom);
                        }
                    }
                    break;
                }
                // ДЕЙСТВИЯ АДМИНА
                case "adminAction": {
                    const player = rooms[currentRoom]?.players[socketId];
                    if (player && player.isOwner) {
                        const targetPlayer = rooms[currentRoom].players[data.targetId];
                        const targetWs = sockets[data.targetId];

                        if (data.action === "changeColor" && targetPlayer) {
                            targetPlayer.color = data.newColor;
                            broadcastPlayers(currentRoom);
                        }
                        if (data.action === "changeName" && targetPlayer) {
                            targetPlayer.name = data.newName;
                            broadcastPlayers(currentRoom);
                        }
                        if (data.action === "kick" && targetWs) {
                            targetWs.send(JSON.stringify({ type: "kicked" }));
                            targetWs.close();
                        }
                        if (data.action === "ban" && targetPlayer && targetWs) {
                            const ip = targetWs.data.ip;
                            const expireTime = Date.now() + (data.duration * 1000);
                            bannedIPs.set(ip, { reason: data.reason, expireTime });
                            targetWs.send(JSON.stringify({ type: "banned", reason: data.reason, expireTime }));
                            targetWs.close();
                        }
                        if (data.action === "mute" && targetPlayer) {
                            targetPlayer.isMuted = true;
                            targetPlayer.muteEndTime = Date.now() + (data.duration * 1000);
                            if (targetWs) targetWs.send(JSON.stringify({ type: "muted", reason: data.reason, duration: data.duration }));
                            broadcastPlayers(currentRoom);
                        }
                    }
                    break;
                }
                case "noteOn": {
                    if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socketId]) {
                        const player = rooms[currentRoom].players[socketId];
                        if (player.isMuted) return; 

                        // Анти-спам (макс 25 нот в секунду)
                        const now = Date.now();
                        ws.data.noteTimes = ws.data.noteTimes.filter(t => now - t < 1000);
                        if (ws.data.noteTimes.length > 25) return;
                        ws.data.noteTimes.push(now);
                        
                        const msg = JSON.stringify({
                            type: "notePlayed", midi: data.midi,
                            color: player.color, name: player.name
                        });
                        
                        for (const p of Object.values(rooms[currentRoom].players)) {
                            if (p.id !== socketId) {
                                const targetWs = sockets[p.id];
                                if (targetWs && targetWs.readyState === WebSocket.OPEN) targetWs.send(msg);
                            }
                        }
                    }
                    break;
                }
                case "chatMessage": {
                    if (currentRoom && rooms[currentRoom] && rooms[currentRoom].chatEnabled) {
                        const player = rooms[currentRoom].players[socketId];
                        if (player?.isMuted) return;

                        const now = Date.now();
                        if (now - ws.data.lastMessageTime < 1000) return; // Анти-спам чата
                        ws.data.lastMessageTime = now;

                        const msg = JSON.stringify({
                            type: "chatMessage", name: player.name,
                            text: data.text, color: player.color, senderId: socketId
                        });
                        for (const p of Object.values(rooms[currentRoom].players)) {
                            const targetWs = sockets[p.id];
                            if (targetWs && targetWs.readyState === WebSocket.OPEN) targetWs.send(msg);
                        }
                    }
                    break;
                }
            }
        },
        close(ws) {
            if (!ws.data) return; 
            const socketId = ws.data.id;
            const currentRoom = ws.data.room;
            if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socketId]) {
                delete rooms[currentRoom].players[socketId];
                broadcastPlayers(currentRoom);
                broadcastRoomsList();
            }
            delete sockets[socketId];
        }
    }
});

console.log(`✅ BUN СЕРВЕР РАБОТАЕТ! 👉 http://localhost:${PORT}`);

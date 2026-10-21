// server.js
import { serve } from "bun";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const PORT = 3000;
const SECRET_OWNER_KEY = "hauntedIScoolcLAn20226";

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
const activeReports = [];

setInterval(() => {
    const now = Date.now();
    for (const roomId in rooms) {
        const room = rooms[roomId];
        for (const pId in room.players) {
            const player = room.players[pId];
            if (player.isMuted && player.muteEndTime && now > player.muteEndTime) {
                player.isMuted = false;
                player.muteEndTime = 0;
                player.muteReason = "";
                
                const ws = sockets[pId];
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "unmuted" }));
                }
                broadcastPlayers(roomId);
            }
        }
    }
}, 1000);

function cleanupRoom(roomId) {
    if (SYSTEM_ROOMS.includes(roomId)) return; 
    if (rooms[roomId] && Object.keys(rooms[roomId].players).length === 0) {
        delete rooms[roomId];
        broadcastRoomsList();
    }
}

function broadcastPlayers(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    
    const players = Object.values(room.players);
    
    for (const p of players) {
        const ws = sockets[p.id];
        if (ws && ws.readyState === WebSocket.OPEN) {
            const visiblePlayers = players.filter(vp => !vp.invisible || vp.isOwner);
            const safePlayers = visiblePlayers.map(vp => ({
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

function broadcastRoomSettings(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const { players, ...settings } = room;
    const msg = JSON.stringify({ type: "roomSettingsUpdated", settings: { ...settings, ownerId: room.ownerId } });
    for (const p of Object.values(room.players)) {
        const ws = sockets[p.id];
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
}

function notifyOwnerNewReport(report) {
    for (const p of Object.values(rooms)) {
        for (const player of Object.values(p.players)) {
            if (player.isOwner) {
                const ws = sockets[player.id];
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "newReport", report }));
                }
            }
        }
    }
}

const server = serve({
    port: PORT,
    fetch(req, server) {
        const ip = server.requestIP(req)?.address || "unknown";
        
        const banInfo = bannedIPs.get(ip);
        if (banInfo) {
            if (Date.now() > banInfo.expireTime) {
                bannedIPs.delete(ip); 
            } else {
                return new Response("Banned", { status: 403 }); 
            }
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
            
            const banInfo = bannedIPs.get(ip);
            if (banInfo && Date.now() < banInfo.expireTime) {
                ws.send(JSON.stringify({ type: "banned", reason: banInfo.reason, expireTime: banInfo.expireTime }));
                ws.close();
                return;
            }

            ws.data = { id: socketId, ip: ip, lastMessageTime: 0, noteTimes: [] };
            sockets[socketId] = ws;
        },
        message(ws, message) {
            const data = JSON.parse(message);
            const socketId = ws.data.id;
            let currentRoom = ws.data.room || null;

            switch (data.type) {
                case "join": {
                    const targetRoom = data.room || "Lobby";
                    const isOwner = data.secretKey === SECRET_OWNER_KEY;
                    
                    if (!rooms[targetRoom]) {
                        rooms[targetRoom] = { id: targetRoom, ownerId: isOwner ? socketId : null, visible: false, chatEnabled: true, onlyOwnerCanPlay: false, bgColor: "#000000", players: {} };
                    }

                    if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socketId]) {
                        delete rooms[currentRoom].players[socketId];
                        broadcastPlayers(currentRoom);
                        cleanupRoom(currentRoom); 
                    }

                    ws.data.room = targetRoom;
                    currentRoom = targetRoom;
                    
                    rooms[currentRoom].players[socketId] = {
                        id: socketId,
                        name: data.name,
                        color: data.color,
                        isOwner: isOwner || rooms[currentRoom].ownerId === socketId,
                        isBot: data.isBot || false,
                        isMuted: rooms[currentRoom].players[socketId]?.isMuted || false,
                        muteReason: rooms[currentRoom].players[socketId]?.muteReason || "",
                        muteEndTime: rooms[currentRoom].players[socketId]?.muteEndTime || 0,
                        invisible: data.invisible || false
                    };

                    broadcastPlayers(currentRoom);
                    broadcastRoomsList();
                    broadcastRoomSettings(currentRoom);
                    break;
                }
                case "requestRoomsList":
                    broadcastRoomsList();
                    break;

                case "createRoom": {
                    const { roomName, isVisible } = data;
                    if (!rooms[roomName]) {
                        rooms[roomName] = {
                            id: roomName,
                            ownerId: socketId,
                            visible: isVisible,
                            chatEnabled: true,
                            onlyOwnerCanPlay: false,
                            bgColor: "#000000",
                            players: {}
                        };
                        broadcastRoomsList();
                        ws.send(JSON.stringify({ type: "roomCreated", roomName }));
                    } else {
                        ws.send(JSON.stringify({ type: "roomError", error: 'ROOM_EXISTS' }));
                    }
                    break;
                }

                case "reportPlayer": {
                    const report = {
                        id: crypto.randomUUID(),
                        reporterName: data.reporterName,
                        targetName: data.targetName,
                        targetId: data.targetId,
                        reason: data.reason,
                        room: currentRoom,
                        timestamp: Date.now()
                    };
                    activeReports.push(report);
                    notifyOwnerNewReport(report);
                    ws.send(JSON.stringify({ type: "systemMessage", text: "REPORT_SENT" }));
                    break;
                }

                case "adminAction": {
                    if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socketId]?.isOwner) {
                        const { action, targetId, reason, duration } = data;
                        const targetWs = sockets[targetId];
                        const targetPlayer = Object.values(rooms[currentRoom].players).find(p => p.id === targetId);

                        if (action === "kick" && targetWs) {
                            targetWs.send(JSON.stringify({ type: "kicked" }));
                            targetWs.close();
                        }
                        if (action === "ban" && targetPlayer && targetWs) {
                            const ip = targetWs.data.ip;
                            const expireTime = Date.now() + (duration * 1000);
                            bannedIPs.set(ip, { reason, expireTime });
                            targetWs.send(JSON.stringify({ type: "banned", reason, expireTime }));
                            targetWs.close();
                        }
                        if (action === "mute" && targetPlayer) {
                            rooms[currentRoom].players[targetId].isMuted = true;
                            rooms[currentRoom].players[targetId].muteReason = reason;
                            rooms[currentRoom].players[targetId].muteEndTime = Date.now() + (duration * 1000);
                            
                            const targetWs = sockets[targetId];
                            if (targetWs) {
                                targetWs.send(JSON.stringify({ type: "muted", reason, duration }));
                            }
                            broadcastPlayers(currentRoom);
                        }
                        if (action === "toggleInvisible") {
                            rooms[currentRoom].players[socketId].invisible = !rooms[currentRoom].players[socketId].invisible;
                            ws.send(JSON.stringify({ type: "invisibleToggled", invisible: rooms[currentRoom].players[socketId].invisible }));
                            broadcastPlayers(currentRoom);
                        }
                        if (action === "clearChat") {
                            const msg = JSON.stringify({ type: "clearChat" });
                            for (const p of Object.values(rooms[currentRoom].players)) {
                                const targetWs = sockets[p.id];
                                if (targetWs && targetWs.readyState === WebSocket.OPEN) targetWs.send(msg);
                            }
                        }
                    }
                    break;
                }
                case "noteOn": {
                    if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socketId]) {
                        const room = rooms[currentRoom];
                        const player = room.players[socketId];
                        
                        if (room.onlyOwnerCanPlay && !player.isOwner) return;
                        if (player.isMuted) return; 

                        const now = Date.now();
                        ws.data.noteTimes = ws.data.noteTimes.filter(t => now - t < 1000);
                        if (ws.data.noteTimes.length > 25) return;
                        ws.data.noteTimes.push(now);
                        
                        const msg = JSON.stringify({
                            type: "notePlayed",
                            midi: data.midi,
                            instrument: data.instrument,
                            isSynth: data.isSynth,
                            color: player.color,
                            name: player.name
                        });
                        
                        for (const p of Object.values(room.players)) {
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
                        if (now - ws.data.lastMessageTime < 2000) {
                            ws.send(JSON.stringify({ type: "systemMessage", text: "RATE_LIMIT" }));
                            return;
                        }
                        ws.data.lastMessageTime = now;

                        const msg = JSON.stringify({
                            type: "chatMessage",
                            name: data.name,
                            text: data.text,
                            color: data.color,
                            senderId: socketId
                        });
                        for (const p of Object.values(rooms[currentRoom].players)) {
                            const targetWs = sockets[p.id];
                            if (targetWs && targetWs.readyState === WebSocket.OPEN) targetWs.send(msg);
                        }
                    }
                    break;
                }
                case "leave": {
                    if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socketId]) {
                        delete rooms[currentRoom].players[socketId];
                        broadcastPlayers(currentRoom);
                        broadcastRoomsList();
                        cleanupRoom(currentRoom); 
                        ws.data.room = null;
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
                cleanupRoom(currentRoom); 
            }
            delete sockets[socketId];
        }
    }
});

console.log(`✅ BUN СЕРВЕР РАБОТАЕТ! 👉 http://localhost:${PORT}`);
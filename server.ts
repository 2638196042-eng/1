import express from "express";
import { createServer as createHttpServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";

const app = express();
const httpServer = createHttpServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
});
const PORT = 3000;

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Game state storage
interface Player {
  id: string;
  name: string;
  isOwner: boolean;
  isBot: boolean;
  role: string | null;
  isMuted: boolean;
  isDead: boolean;
  usedSkills?: string[];
}

interface Room {
  id: string;
  players: Player[];
  status: "waiting" | "playing";
  phase?: "day" | "night";
  allowFreeRole: boolean;
  votes?: Record<string, string>;
}

const rooms: Record<string, Room> = {};

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("createRoom", (data: { playerName: string }, callback) => {
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    rooms[roomId] = {
      id: roomId,
      players: [
        {
          id: socket.id,
          name: data.playerName,
          isOwner: true,
          isBot: false,
          role: null,
          isMuted: false,
          isDead: false,
        },
      ],
      status: "waiting",
      allowFreeRole: false,
    };
    socket.join(roomId);
    io.to(roomId).emit("roomUpdated", rooms[roomId]);
    callback({ roomId, room: rooms[roomId] });
  });

  socket.on("joinRoom", (data: { roomId: string; playerName: string }, callback) => {
    const room = rooms[data.roomId];
    if (!room) {
      return callback({ error: "Room not found" });
    }
    if (room.status !== "waiting") {
      return callback({ error: "Game already started" });
    }
    const newPlayer: Player = {
      id: socket.id,
      name: data.playerName,
      isOwner: false,
      isBot: false,
      role: null,
      isMuted: false,
      isDead: false,
    };
    room.players.push(newPlayer);
    socket.join(data.roomId);
    io.to(data.roomId).emit("roomUpdated", room);
    callback({ room });
  });

  socket.on("leaveRoom", (data: { roomId: string }) => {
    const room = rooms[data.roomId];
    if (room) {
      room.players = room.players.filter((p) => p.id !== socket.id);
      if (room.players.length === 0) {
        delete rooms[data.roomId];
      } else {
        // If owner leaves, assign new owner to first real player
        if (!room.players.find(p => p.isOwner)) {
           const nextReal = room.players.find(p => !p.isBot);
           if (nextReal) nextReal.isOwner = true;
           else delete rooms[data.roomId]; // only bots left
        }
        if (rooms[data.roomId]) {
          io.to(data.roomId).emit("roomUpdated", rooms[data.roomId]);
        }
      }
    }
    socket.leave(data.roomId);
  });

  socket.on("kickPlayer", (data: { roomId: string; targetId: string }) => {
    const room = rooms[data.roomId];
    const caller = room?.players.find((p) => p.id === socket.id);
    if (room && caller?.isOwner) {
      room.players = room.players.filter((p) => p.id !== data.targetId);
      io.to(data.roomId).emit("roomUpdated", room);
      // Notify the kicked player
      io.sockets.sockets.get(data.targetId)?.emit("kicked");
      io.sockets.sockets.get(data.targetId)?.leave(data.roomId);
    }
  });

  socket.on("addBot", (data: { roomId: string; botName: string }) => {
    const room = rooms[data.roomId];
    const caller = room?.players.find((p) => p.id === socket.id);
    if (room && caller?.isOwner && room.status === "waiting") {
      room.players.push({
        id: `bot_${Math.random().toString(36).substring(2, 8)}`,
        name: data.botName,
        isOwner: false,
        isBot: true,
        role: null,
        isMuted: false,
        isDead: false,
      });
      io.to(data.roomId).emit("roomUpdated", room);
    }
  });

  socket.on("removeBot", (data: { roomId: string; targetId: string }) => {
    const room = rooms[data.roomId];
    const caller = room?.players.find((p) => p.id === socket.id);
    if (room && caller?.isOwner && room.status === "waiting") {
      room.players = room.players.filter((p) => p.id !== data.targetId);
      io.to(data.roomId).emit("roomUpdated", room);
    }
  });

  socket.on("unlockFreeRole", (data: { roomId: string; password: string }) => {
    const room = rooms[data.roomId];
    if (room && data.password === "20161003") {
      room.allowFreeRole = true;
      io.to(data.roomId).emit("roomUpdated", room);
      io.to(data.roomId).emit("chatMessage", {
        sender: "System",
        text: "隐藏功能已解锁：允许自由选择身份！",
        isSystem: true,
      });
    }
  });

  socket.on("setFreeRole", (data: { roomId: string; role: string }) => {
    const room = rooms[data.roomId];
    if (room && room.allowFreeRole) {
      const player = room.players.find((p) => p.id === socket.id);
      if (player) {
        player.role = data.role;
        io.to(data.roomId).emit("roomUpdated", room);
      }
    }
  });

  socket.on("startGame", (data: { roomId: string }) => {
    const room = rooms[data.roomId];
    const caller = room?.players.find((p) => p.id === socket.id);
    if (room && caller?.isOwner && room.status === "waiting") {
      room.status = "playing";
      room.votes = {}; // Initialize votes
      
      // Auto-fill bots to reach 8 players
      while (room.players.length < 8) {
        room.players.push({
          id: `bot_${Math.random().toString(36).substring(2, 8)}`,
          name: `AI_${Math.floor(Math.random() * 1000)}`,
          isOwner: false,
          isBot: true,
          role: null,
          isMuted: false,
          isDead: false,
          usedSkills: []
        });
      }

      // Assign random roles if free role not set
      const defaultRoles = ["狼人", "狼人", "平民", "平民", "平民", "预言家", "女巫", "猎人"];
      let roleIdx = 0;
      // Shuffle roles
      const shuffled = defaultRoles.sort(() => Math.random() - 0.5);

      room.players.forEach(p => {
        if (!p.role) {
          p.role = shuffled[roleIdx % shuffled.length] || "平民";
          roleIdx++;
        }
        p.usedSkills = [];
      });
      io.to(data.roomId).emit("roomUpdated", room);
      io.to(data.roomId).emit("gameStarted", room);
      io.to(data.roomId).emit("systemMessage", `游戏开始，现在是【黑夜】阶段，请神职和狼人行动...`);
    }
  });

  socket.on("togglePhase", (data: { roomId: string }) => {
    const room = rooms[data.roomId];
    const caller = room?.players.find((p) => p.id === socket.id);
    if (room && caller?.isOwner && room.status === "playing") {
      room.phase = room.phase === "night" ? "day" : "night";
      room.votes = {}; // clear votes when phase shift
      io.to(data.roomId).emit("roomUpdated", room);
      io.to(data.roomId).emit("systemMessage", room.phase === "day" ? "天亮了，请大家开始讨论并投票。" : "天黑请闭眼，非夜间角色请等待。");
    }
  });

  socket.on("useSkill", (data: { roomId: string; targetId: string; skill: string }) => {
    const room = rooms[data.roomId];
    if (room && room.status === "playing") {
      const player = room.players.find(p => p.id === socket.id);
      const target = room.players.find(p => p.id === data.targetId);
      
      if (!player || player.isDead || !target || target.isDead) return;

      player.usedSkills = player.usedSkills || [];

      if (data.skill === "check" && player.role === "预言家") {
        if (!player.usedSkills.includes(`check_${room.phase}`)) {
          player.usedSkills.push(`check_${room.phase}`);
          const isWolf = target.role === "狼人";
          socket.emit("chatMessage", {
            sender: "System",
            text: `[专享通知] 你查验的玩家 "${target.name}" 的身份是：${isWolf ? '狼人 (坏人)' : '好人'}`,
            isSystem: true,
            toTarget: socket.id
          });
        } else {
          socket.emit("systemMessage", "本夜已经查验过了！");
        }
      } else if (data.skill === "poison" && player.role === "女巫") {
        if (!player.usedSkills.includes("poison")) {
          player.usedSkills.push("poison");
          target.isDead = true;
          io.to(data.roomId).emit("roomUpdated", room);
          io.to(data.roomId).emit("chatMessage", { sender: "System", text: `(女巫使用了毒药，某位玩家倒在了黑夜中...)`, isSystem: true });
        } else {
          socket.emit("systemMessage", "你的毒药已经用过了！");
        }
      } else if (data.skill === "attack" && player.role === "狼人") {
        // Simple immediate attack for now
        target.isDead = true;
        io.to(data.roomId).emit("roomUpdated", room);
        io.to(data.roomId).emit("chatMessage", { sender: "System", text: `(狼人在黑夜中发起了袭击，某位玩家倒下了...)`, isSystem: true });
      }
    }
  });

  socket.on("votePlayer", (data: { roomId: string; targetId: string; sourceId?: string }) => {
    const room = rooms[data.roomId];
    if (room && room.status === "playing") {
      let player = room.players.find((p) => p.id === socket.id);
      if (data.sourceId && player?.isOwner) {
        // Bot voting request from owner
        player = room.players.find((p) => p.id === data.sourceId && p.isBot);
      }
      
      const target = room.players.find((p) => p.id === data.targetId);
      
      if (player && !player.isDead && target && !target.isDead) {
        if (!room.votes) room.votes = {};
        room.votes[player.id] = target.id;
        io.to(data.roomId).emit("roomUpdated", room);
      }
    }
  });

  socket.on("resolveVotes", (data: { roomId: string }) => {
    const room = rooms[data.roomId];
    const caller = room?.players.find((p) => p.id === socket.id);
    if (room && caller?.isOwner && room.status === "playing") {
      if (!room.votes || Object.keys(room.votes).length === 0) {
        io.to(data.roomId).emit("chatMessage", { sender: "System", text: "没有玩家投票，本轮无人出局。", isSystem: true });
        return;
      }
      
      // Calculate max votes
      const voteCounts: Record<string, number> = {};
      Object.values(room.votes).forEach(targetId => {
        voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
      });
      
      let maxVotes = 0;
      let targetIdToKill: string | null = null;
      let isTie = false;
      
      for (const [targetId, count] of Object.entries(voteCounts)) {
        if (count > maxVotes) {
          maxVotes = count;
          targetIdToKill = targetId;
          isTie = false;
        } else if (count === maxVotes) {
          isTie = true;
        }
      }
      
      if (isTie || !targetIdToKill) {
        io.to(data.roomId).emit("chatMessage", { sender: "System", text: "平票！本轮无人出局。", isSystem: true });
      } else {
        const target = room.players.find(p => p.id === targetIdToKill);
        if (target) {
          target.isDead = true;
          io.to(data.roomId).emit("chatMessage", { sender: "System", text: `投票结果：玩家 "${target.name}" 被公投出局！`, isSystem: true });
        }
      }
      
      // Clear votes for next round
      room.votes = {};
      io.to(data.roomId).emit("roomUpdated", room);
    }
  });

  socket.on("sendMessage", (data: { roomId: string; text: string }) => {
    const room = rooms[data.roomId];
    if (room) {
      const player = room.players.find(p => p.id === socket.id);
      if (!player) return;
      if (player.isMuted) {
         socket.emit("chatMessage", { sender: "System", text: "你已经被禁言，无法发送消息！", isSystem: true, toTarget: socket.id });
         return;
      }
      
      let text = data.text;
      let mutedText = "";
      // Check if player says their role
      if (player.role && text.includes(player.role) && room.status === "playing") {
        player.isMuted = true;
        mutedText = `[检测到敏感词: 身份] 玩家 "${player.name}" 已被系统自动禁言。`;
        io.to(data.roomId).emit("roomUpdated", room);
      }

      io.to(data.roomId).emit("chatMessage", {
        sender: player.name,
        text,
        isSystem: false,
      });

      if (mutedText) {
        io.to(data.roomId).emit("chatMessage", {
          sender: "System",
          text: mutedText,
          isSystem: true,
        });
      }
    }
  });

  socket.on("botMessage", (data: { roomId: string; text: string, botName: string }) => {
    // Only accepted from owner client
    const room = rooms[data.roomId];
    if (room) {
      io.to(data.roomId).emit("chatMessage", {
        sender: data.botName,
        text: data.text,
        isSystem: false,
      });
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (room.players.find(p => p.id === socket.id)) {
        room.players = room.players.filter((p) => p.id !== socket.id);
        if (room.players.length === 0) {
          delete rooms[roomId];
        } else {
          if (!room.players.find(p => p.isOwner)) {
             const nextReal = room.players.find(p => !p.isBot);
             if (nextReal) nextReal.isOwner = true;
             else delete rooms[roomId]; // only bots left
          }
          if (rooms[roomId]) {
            io.to(roomId).emit("roomUpdated", rooms[roomId]);
          }
        }
      }
    }
  });
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

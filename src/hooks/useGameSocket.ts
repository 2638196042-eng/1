import { useEffect, useState } from "react";
import { io, Socket } from "socket.io-client";
import { Room, ChatMessage } from "../types";

const socket: Socket = io();

export function useGameSocket() {
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [room, setRoom] = useState<Room | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [kicked, setKicked] = useState(false);

  useEffect(() => {
    function onConnect() {
      setIsConnected(true);
    }
    function onDisconnect() {
      setIsConnected(false);
    }
    function onRoomUpdated(newRoom: Room) {
      setRoom(newRoom);
    }
    function onGameStarted(newRoom: Room) {
      setRoom(newRoom);
      setMessages((prev) => [...prev, { sender: "System", text: "游戏开始了！请查看你的身份。", isSystem: true }]);
    }
    function onChatMessage(msg: ChatMessage) {
      setMessages((prev) => [...prev, msg]);
    }
    function onSystemMessage(text: string) {
      setMessages((prev) => [...prev, { sender: "System", text, isSystem: true }]);
    }
    function onKicked() {
      setKicked(true);
      setRoom(null);
    }

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("roomUpdated", onRoomUpdated);
    socket.on("gameStarted", onGameStarted);
    socket.on("chatMessage", onChatMessage);
    socket.on("systemMessage", onSystemMessage);
    socket.on("kicked", onKicked);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("roomUpdated", onRoomUpdated);
      socket.off("gameStarted", onGameStarted);
      socket.off("chatMessage", onChatMessage);
      socket.off("systemMessage", onSystemMessage);
      socket.off("kicked", onKicked);
    };
  }, []);

  return { socket, isConnected, room, messages, kicked, setKicked, setRoom, setMessages };
}

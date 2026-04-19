export interface Player {
  id: string;
  name: string;
  isOwner: boolean;
  isBot: boolean;
  role: string | null;
  isMuted: boolean;
  isDead: boolean;
  usedSkills?: string[];
}

export interface Room {
  id: string;
  players: Player[];
  status: "waiting" | "playing";
  phase?: "day" | "night";
  allowFreeRole: boolean;
  votes?: Record<string, string>;
}

export interface ChatMessage {
  sender: string;
  text: string;
  isSystem: boolean;
  toTarget?: string; // If the message is a private whisper (e.g. from System to Prophet)
}

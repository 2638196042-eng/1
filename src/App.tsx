import React, { useState, useEffect, useRef } from "react";
import { useGameSocket } from "./hooks/useGameSocket";
import { Mic, MicOff, Send, Volume2, UserPlus, Play, LogOut, Settings, Mic2 } from "lucide-react";
import { PCMRecorder, PCMPlayer } from "./lib/audio";
import { GoogleGenAI, LiveServerMessage } from "@google/genai";
import { motion } from "motion/react";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const ROLES = ["狼人", "平民", "预言家", "女巫", "猎人", "守卫"];

export default function App() {
  const { socket, isConnected, room, messages, kicked, setKicked, setRoom, setMessages } = useGameSocket();
  const [playerName, setPlayerName] = useState("");
  const [joinRoomId, setJoinRoomId] = useState("");
  const [chatInput, setChatInput] = useState("");
  
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    if (roomParam) {
      setJoinRoomId(roomParam.toUpperCase());
    }
  }, []);

  // Voice AI State
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [inputVolume, setInputVolume] = useState(1);
  const [outputVolume, setOutputVolume] = useState(1);
  const recorderRef = useRef<PCMRecorder | null>(null);
  const playerRef = useRef<PCMPlayer | null>(null);
  const sessionPromiseRef = useRef<any>(null);

  // Bot Logic State
  const prevMessagesLength = useRef(messages.length);

  const [unlockPassword, setUnlockPassword] = useState("");
  const [showUnlock, setShowUnlock] = useState(false);

  // Role reveal animation state
  const [revealState, setRevealState] = useState<"hidden" | "drawing" | "revealed">("hidden");
  
  const currentPlayer = room?.players.find((p) => p.id === socket.id);
  const isOwner = currentPlayer?.isOwner || false;

  // Bot Periodic Action (Voting)
  useEffect(() => {
    if (isOwner && room?.status === "playing") {
      const interval = setInterval(() => {
        const activeBots = room.players.filter(p => p.isBot && !p.isDead);
        const alivePlayers = room.players.filter(p => !p.isDead);
        
        if (room.phase === "day" && activeBots.length > 0 && alivePlayers.length > 0) {
           // AI randomly votes during daytime
           activeBots.forEach(bot => {
              if (Math.random() > 0.7) {
                 const randomTarget = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
                 if (randomTarget.id !== bot.id) {
                   socket.emit("votePlayer", { roomId: room.id, targetId: randomTarget.id, sourceId: bot.id });
                 }
              }
           });
        }
      }, 10000);
      return () => clearInterval(interval);
    }
  }, [isOwner, room, socket]);

  // Basic AI Bot logic (Chat)
  useEffect(() => {
    if (isOwner && room && room.status === "playing") {
      const bots = room.players.filter(p => p.isBot && !p.isDead);
      if (bots.length > 0 && messages.length > prevMessagesLength.current) {
        const lastMsg = messages[messages.length - 1];
        if (!lastMsg.isSystem && lastMsg.sender !== bots[0].name) {
          if (Math.random() > 0.6) {
             const bot = bots[Math.floor(Math.random() * bots.length)];
             
             // Use Gemini API for bot messages
             setTimeout(async () => {
                try {
                  const chatContext = messages.slice(-5).map(m => `${m.sender}: ${m.text}`).join("\n");
                  const prompt = `这是一场狼人杀游戏，你是其中一个玩家叫${bot.name}，你的身份是${bot.role}。
其他正在发生对话：
${chatContext}
请给出一句不超过15个字的简短中文发言参与讨论（如果不需要暴露可以隐瞒身份，只分析局势）：`;
                  
                  const response = await ai.models.generateContent({
                    model: "gemini-3.1-flash-lite-preview",
                    contents: prompt,
                  });
                  const replyText = response.text?.trim() || "我同意大家的想法。";
                  
                  socket.emit("botMessage", {
                    roomId: room.id,
                    botName: bot.name,
                    text: replyText
                  });
                } catch (err) {
                  // Fallback
                  socket.emit("botMessage", {
                    roomId: room.id,
                    botName: bot.name,
                    text: `我觉得 ${lastMsg.sender} 有点可疑。`
                  });
                }
             }, 3000 + Math.random() * 2000);
          }
        }
      }
    }
    prevMessagesLength.current = messages.length;
  }, [messages, isOwner, room]);

  useEffect(() => {
    const onGameStarted = () => {
      setRevealState("drawing");
      setTimeout(() => setRevealState("revealed"), 3000);
    };
    
    socket.on("gameStarted", onGameStarted);
    return () => {
      socket.off("gameStarted", onGameStarted);
    };
  }, [socket]);

  const toggleVoice = async () => {
    if (isVoiceActive) {
      setIsVoiceActive(false);
      if (recorderRef.current) recorderRef.current.stop();
      if (playerRef.current) playerRef.current.stop();
      recorderRef.current = null;
      playerRef.current = null;
      sessionPromiseRef.current = null;
    } else {
      setIsVoiceActive(true);
      recorderRef.current = new PCMRecorder();
      playerRef.current = new PCMPlayer(outputVolume);
      
      const sessionPromise = ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        callbacks: {
          onopen: () => {
            recorderRef.current?.start(inputVolume).then(() => {
              recorderRef.current!.onData = (base64Url: string) => {
                sessionPromise.then((session: any) =>
                  session.sendRealtimeInput({
                    audio: { data: base64Url, mimeType: "audio/pcm;rate=16000" },
                  })
                );
              };
            });
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && playerRef.current) {
              playerRef.current.playBase64PCM(base64Audio);
            }
          },
        },
        config: {
          responseModalities: ["AUDIO" as any],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } },
          },
          systemInstruction: "你是一个狼人杀的法官或者辅助助手，你需要用中文简短地和玩家互动。",
        },
      });
      sessionPromiseRef.current = sessionPromise;
    }
  };

  const updateInputVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setInputVolume(v);
    if (recorderRef.current) recorderRef.current.setVolume(v);
  };

  const updateOutputVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setOutputVolume(v);
    if (playerRef.current) playerRef.current.setVolume(v);
  };

  const createRoom = () => {
    if (!playerName) return;
    socket.emit("createRoom", { playerName }, (res: any) => {
      if (res.error) alert(res.error);
    });
  };

  const joinRoom = () => {
    if (!playerName || !joinRoomId) return;
    socket.emit("joinRoom", { roomId: joinRoomId, playerName }, (res: any) => {
      if (res.error) alert(res.error);
    });
  };

  const addBot = () => {
    if (room) {
      socket.emit("addBot", { roomId: room.id, botName: `AI_${Math.floor(Math.random() * 1000)}` });
    }
  };

  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (chatInput.trim() && room) {
      socket.emit("sendMessage", { roomId: room.id, text: chatInput.trim() });
      setChatInput("");
    }
  };

  if (kicked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-900 text-zinc-100">
        <div className="bg-slate-800 p-8 rounded-2xl shadow-xl text-center border border-slate-700">
          <h2 className="text-2xl font-bold mb-4 text-slate-50">你已经被踢出房间</h2>
          <button onClick={() => setKicked(false)} className="bg-sky-400 hover:bg-sky-500 text-slate-900 px-6 py-2 rounded-md font-semibold transition-colors">返回首页</button>
        </div>
      </div>
    );
  }

  if (!room) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-900 text-slate-50 font-sans p-4">
        <div className="w-full max-w-md bg-slate-800 p-8 rounded-xl border border-slate-700 shadow-2xl">
          <h1 className="text-4xl font-extrabold mb-8 text-center tracking-tight text-slate-50">狼人杀 <span className="text-sky-400">PRO</span></h1>
          
          <div className="space-y-6">
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">你的昵称</label>
              <input
                className="w-full bg-slate-900 border border-slate-700 rounded-md px-4 py-3 text-slate-50 focus:outline-none focus:border-sky-400 transition-colors"
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                placeholder="输入昵称..."
              />
            </div>

            <button onClick={createRoom} className="w-full bg-sky-400 text-slate-900 font-semibold py-3 rounded-md hover:bg-sky-500 transition-colors">
              创建房间
            </button>

            <div className="flex items-center gap-4 my-2">
              <div className="h-px bg-slate-700 flex-1"></div>
              <span className="text-xs text-slate-400 font-bold uppercase tracking-wider">或加入</span>
              <div className="h-px bg-slate-700 flex-1"></div>
            </div>

            <div className="flex gap-2">
              <input
                className="flex-1 bg-slate-900 border border-slate-700 rounded-md px-4 py-3 text-slate-50 focus:outline-none focus:border-sky-400 font-mono tracking-widest uppercase"
                value={joinRoomId}
                onChange={(e) => setJoinRoomId(e.target.value.toUpperCase())}
                placeholder="房间号"
                maxLength={6}
              />
              <button onClick={joinRoom} className="bg-transparent border border-slate-700 text-slate-50 font-semibold px-6 rounded-md hover:bg-slate-700 transition-colors">
                加入
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-50 font-sans p-4 md:p-6 flex flex-col items-center">
      
      {/* Role Reveal Overlay */}
      {revealState !== "hidden" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/95 backdrop-blur-md overflow-hidden">
          {revealState === "drawing" ? (
            <motion.div 
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col items-center"
            >
               <motion.div 
                 animate={{ rotateY: [0, 360] }}
                 transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
                 className="w-32 h-48 bg-slate-800 rounded-xl border-2 border-slate-600 flex items-center justify-center mb-8 shadow-[0_0_30px_rgba(30,41,59,0.8)]"
               >
                  <div className="text-5xl text-slate-500 font-black">?</div>
               </motion.div>
               <motion.h2 
                 animate={{ opacity: [0.3, 1, 0.3] }}
                 transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
                 className="text-xl font-bold text-sky-400 tracking-widest uppercase"
               >
                 系统正在为您分配身份...
               </motion.h2>
            </motion.div>
          ) : (
            <motion.div 
              initial={{ opacity: 0, scale: 0.5, y: 50 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ type: "spring", damping: 15, stiffness: 200 }}
              className="flex flex-col items-center"
            >
               <div className="w-64 h-96 bg-slate-800 rounded-2xl border-4 border-sky-400 flex flex-col items-center justify-center mb-10 shadow-[0_0_80px_rgba(56,189,248,0.4)] relative overflow-hidden">
                  <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-sky-400/20 via-transparent to-transparent"></div>
                  <h3 className="text-xl font-bold text-slate-400 mb-8 z-10 tracking-widest break-keep">你的神秘身份是</h3>
                  <motion.h1 
                    initial={{ scale: 0.5 }}
                    animate={{ scale: 1 }}
                    transition={{ delay: 0.2, type: "spring", stiffness: 200 }}
                    className="text-6xl font-black text-sky-400 z-10 drop-shadow-lg"
                  >
                    {currentPlayer?.role}
                  </motion.h1>
               </div>
               <motion.button 
                 whileHover={{ scale: 1.05 }}
                 whileTap={{ scale: 0.95 }}
                 onClick={() => setRevealState("hidden")} 
                 className="bg-sky-400 text-slate-900 px-10 py-3.5 rounded-full font-bold hover:bg-sky-500 transition-colors shadow-lg text-lg"
               >
                  确认身份并进入游戏
               </motion.button>
            </motion.div>
          )}
        </div>
      )}

      <div className="w-full max-w-6xl flex flex-col md:flex-row gap-1 h-[90vh] bg-slate-700 p-px rounded-xl overflow-hidden">
        
        {/* Left Panel: Players & Controls */}
        <div className="flex-[3] bg-slate-900 flex flex-col relative overflow-hidden">
          <div className="flex justify-between items-center p-4 md:p-6 border-b border-slate-700 bg-slate-900/80">
            <div className="flex items-center gap-4">
              <span className="bg-sky-400 text-slate-900 px-2 py-1 rounded text-xs font-bold cursor-pointer hover:bg-sky-500 transition shadow-[0_0_10px_rgba(56,189,248,0.4)]" onClick={() => {
                let currentHref = window.location.href;
                // Automatically convert developer preview URL to shared public URL for Google AI Studio
                if (currentHref.includes("ais-dev-")) {
                  currentHref = currentHref.replace("ais-dev-", "ais-pre-");
                }
                const url = new URL(currentHref);
                url.searchParams.set('room', room.id);
                navigator.clipboard.writeText(url.toString());
                alert('房间邀请链接已复制！\n分享给朋友即可快速进入。\n（注意：必须在 AI Studio 右上角点击“分享/Share”应用后，朋友才能正常打开链接，否则会显示 403）');
              }} title="点击复制邀请链接">
                ROOM #{room.id} 🔗
              </span>
              <span className="font-semibold hidden md:inline">暗影之夜 | 标准局</span>
              <span className="text-sm text-slate-400">状态: {room.status === "waiting" ? "等待中..." : room.phase === "night" ? "🌙 黑夜" : "☀️ 白天"} ({room.players.length}/12)</span>
            </div>
            <div className="flex items-center gap-2">
              {isOwner && room.status === "playing" && (
                <button onClick={() => socket.emit("togglePhase", { roomId: room.id })} className="text-[10px] uppercase font-bold bg-indigo-500/20 text-indigo-400 px-3 py-1.5 rounded hover:bg-indigo-500/40 transition">
                  昼夜交替
                </button>
              )}
              <button onClick={() => {
                socket.emit("leaveRoom", { roomId: room.id });
                setRoom(null);
                setMessages([]);
                setRevealState("hidden");
                setJoinRoomId("");
              }} className="p-2 text-slate-400 hover:text-red-500 transition-colors">
                <LogOut size={20} />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 md:p-6 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 auto-rows-max gap-4 bg-[radial-gradient(circle_at_center,_#1e293b_0%,_#0f172a_100%)] custom-scrollbar">
            {room.players.map(p => (
              <div key={p.id} className={`group bg-slate-800 border ${p.isOwner ? 'border-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.2)]' : 'border-slate-700'} rounded-lg p-3 flex flex-col items-center justify-center gap-2 relative ${p.isDead ? 'opacity-50 grayscale' : ''}`}>
                {p.isOwner && <span className="absolute -top-2 -right-2 bg-sky-400 text-slate-900 text-[9px] font-extrabold px-1.5 py-0.5 rounded z-10">房主</span>}
                {isOwner && room.status === "waiting" && p.id !== socket.id && (
                  <button onClick={() => socket.emit(p.isBot ? "removeBot" : "kickPlayer", { roomId: room.id, targetId: p.id })} className="absolute top-1 left-2 text-red-500 opacity-60 hover:opacity-100 font-bold text-lg leading-none">×</button>
                )}
                <div className={`w-12 h-12 rounded-full flex items-center justify-center font-bold border-2 overflow-hidden ${p.isDead ? 'bg-slate-900 border-red-900 opacity-50' : 'bg-slate-700 border-slate-700'}`}>
                  {p.isBot ? <span className="text-indigo-400 text-sm">AI</span> : <span className="text-slate-300">{p.name.charAt(0)}</span>}
                </div>
                <div className={`text-sm font-medium text-center truncate w-full ${p.isDead ? 'text-slate-600 line-through' : ''}`}>{p.name} {p.id === socket.id && <span className="text-slate-400 text-xs">(你)</span>}</div>
                
                {p.id === socket.id && p.role ? (
                  <div className="text-[10px] px-1.5 py-0.5 rounded bg-sky-400 text-slate-900 font-bold">{p.isDead ? "出局 " : ""}{p.role}</div>
                ) : (
                  <div className="text-[10px] px-1.5 py-0.5 rounded bg-slate-600 text-slate-300">{p.isDead ? '已出局' : p.isBot ? '已就绪' : p.role ? '角色保密' : '准备中'}</div>
                )}

                {room.status === "playing" && !p.isDead && (
                  <div className="absolute inset-x-0 bottom-[-10px] flex justify-center translate-y-full opacity-0 group-hover:opacity-100 transition-opacity z-20 gap-1 flex-wrap">
                    {room.phase === "day" && (
                      <button 
                        onClick={() => socket.emit("votePlayer", { roomId: room.id, targetId: p.id })}
                        disabled={currentPlayer?.isDead || p.id === socket.id}
                        className="text-xs bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white font-bold px-3 py-1 rounded shadow-lg"
                      >
                        投票
                      </button>
                    )}
                    {room.phase === "night" && !currentPlayer?.isDead && p.id !== socket.id && (
                      <>
                         {currentPlayer?.role === "狼人" && p.role !== "狼人" && (
                           <button onClick={() => socket.emit("useSkill", { roomId: room.id, targetId: p.id, skill: "attack" })} className="text-xs bg-red-900 hover:bg-red-800 text-white font-bold px-3 py-1 rounded shadow-lg">袭击</button>
                         )}
                         {currentPlayer?.role === "女巫" && !currentPlayer?.usedSkills?.includes("poison") && (
                           <button onClick={() => socket.emit("useSkill", { roomId: room.id, targetId: p.id, skill: "poison" })} className="text-xs bg-purple-600 hover:bg-purple-500 text-white font-bold px-3 py-1 rounded shadow-lg">毒杀</button>
                         )}
                         {currentPlayer?.role === "预言家" && !currentPlayer?.usedSkills?.includes(`check_${room.phase}`) && (
                           <button onClick={() => socket.emit("useSkill", { roomId: room.id, targetId: p.id, skill: "check" })} className="text-xs bg-indigo-500 hover:bg-indigo-400 text-white font-bold px-3 py-1 rounded shadow-lg">查验</button>
                         )}
                      </>
                    )}
                  </div>
                )}
                {room.status === "playing" && room.votes && Object.values(room.votes).filter(v => v === p.id).length > 0 && (
                  <div className="absolute -top-2 -left-2 bg-red-500 text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center">
                    {Object.values(room.votes).filter(v => v === p.id).length}
                  </div>
                )}
                {room.status === "playing" && room.votes?.[socket.id] === p.id && (
                  <div className="absolute inset-0 border-2 border-red-500 rounded-lg pointer-events-none"></div>
                )}
              </div>
            ))}
          </div>

          {/* Owner Controls */}
          {room.status === "waiting" && (
            <div className="p-4 md:p-6 border-t border-slate-700 bg-slate-900">
              {isOwner && (
                <div className="flex gap-4">
                  <button onClick={addBot} className="flex-[1] bg-transparent border border-slate-700 flex items-center justify-center gap-2 py-2.5 rounded-md font-semibold hover:bg-slate-800 transition text-slate-50">
                    <UserPlus size={16} /> 添加AI
                  </button>
                  <button onClick={() => socket.emit("startGame", { roomId: room.id })} className="flex-[2] bg-sky-400 text-slate-900 flex items-center justify-center gap-2 py-2.5 rounded-md font-semibold hover:bg-sky-500 transition shadow-[0_0_15px_rgba(56,189,248,0.3)]">
                    <Play size={16} fill="currentColor" /> 开始游戏 (Host)
                  </button>
                </div>
              )}
              
              <div className="flex justify-end mt-4">
                <button onClick={() => setShowUnlock(!showUnlock)} className="text-slate-400 hover:text-slate-200 flex items-center gap-1 text-xs"><Settings size={14} /> 房间设置</button>
              </div>
              {showUnlock && !room.allowFreeRole && (
                <div className="flex gap-2 border border-slate-700 p-2 rounded-md bg-slate-800 mt-2">
                  <input type="password" placeholder="输入隐藏 PIN..." className="flex-1 bg-transparent text-sm px-2 outline-none text-slate-50 placeholder-slate-500" value={unlockPassword} onChange={e => setUnlockPassword(e.target.value)} />
                  <button onClick={() => {socket.emit("unlockFreeRole", { roomId: room.id, password: unlockPassword }); setUnlockPassword("");}} className="text-xs bg-slate-700 hover:bg-slate-600 px-3 py-1 rounded text-slate-50 font-bold transition">解锁</button>
                </div>
              )}
              {room.allowFreeRole && (
                <div className="bg-slate-800 border-l-2 border-emerald-500 p-3 rounded-r-md mt-2">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
                    <span className="text-xs font-semibold text-emerald-500">隐藏房主模式已激活: 自由身份选择</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {ROLES.map(r => (
                      <button key={r} onClick={() => socket.emit("setFreeRole", { roomId: room.id, role: r })} className={`text-xs px-2.5 py-1 rounded font-medium transition-colors border ${currentPlayer?.role === r ? 'border-sky-400 bg-sky-400/10 text-sky-400' : 'border-slate-600 text-slate-300 hover:bg-slate-700'}`}>
                        {r}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Playing Controls */}
          {room.status === "playing" && isOwner && (
            <div className="p-4 md:p-6 border-t border-slate-700 bg-slate-900">
              <button onClick={() => socket.emit("resolveVotes", { roomId: room.id })} className="w-full bg-red-500 text-white flex items-center justify-center gap-2 py-2.5 rounded-md font-semibold hover:bg-red-600 transition shadow-[0_0_15px_rgba(239,68,68,0.2)]">
                结算公投结果
              </button>
            </div>
          )}
        </div>

        {/* Right Panel: Chat & AI Voice */}
        <div className="flex-[2] flex flex-col bg-slate-900 overflow-hidden">
          
          {/* AI Voice Dashboard */}
          <div className="bg-[linear-gradient(135deg,_#1e1b4b_0%,_#1e293b_100%)] p-4 md:p-6 border-b border-slate-700">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-slate-50 flex items-center gap-2 text-sm uppercase tracking-wider"><Mic2 className="text-sky-400" size={18}/> Gemini Live API</h3>
              <button 
                onClick={toggleVoice} 
                className={`w-8 h-8 rounded-full flex items-center justify-center transition-all ${isVoiceActive ? 'bg-red-500/20 text-red-500 border border-red-500 animate-pulse' : 'bg-sky-400/20 text-sky-400 border border-sky-400/50 hover:bg-sky-400/30'}`}
              >
                {isVoiceActive ? <MicOff size={14} fill="currentColor" /> : <Mic size={14} fill="currentColor" />}
              </button>
            </div>
            
            <div className="grid grid-cols-2 gap-6 pt-2">
              <div>
                <div className="flex justify-between items-center mb-1.5"><span className="text-[10px] text-slate-400 uppercase">MIC INPUT</span><span className="text-[10px] font-bold text-sky-400">{Math.round(inputVolume * 100)}%</span></div>
                <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden relative">
                   <input type="range" min="0" max="2" step="0.1" value={inputVolume} onChange={updateInputVolume} className="absolute inset-0 opacity-0 w-full cursor-pointer z-10" />
                   <div className="h-full bg-sky-400 rounded-full" style={{ width: `${(inputVolume / 2) * 100}%`}}></div>
                </div>
              </div>
              <div>
                <div className="flex justify-between items-center mb-1.5"><span className="text-[10px] text-slate-400 uppercase">AI AUDIO</span><span className="text-[10px] font-bold text-sky-400">{Math.round(outputVolume * 100)}%</span></div>
                <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden relative">
                   <input type="range" min="0" max="2" step="0.1" value={outputVolume} onChange={updateOutputVolume} className="absolute inset-0 opacity-0 w-full cursor-pointer z-10" />
                   <div className="h-full bg-sky-400 rounded-full" style={{ width: `${(outputVolume / 2) * 100}%`}}></div>
                </div>
              </div>
            </div>
          </div>

          {/* Chat Window */}
          <div className="flex-1 flex flex-col overflow-hidden bg-slate-800/30">
            <div className="px-4 py-3 border-b border-slate-700 bg-slate-900/50 text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center justify-between">
              <span>房间内聊天</span>
              <span className="text-sky-400/70">实时拦截违规发言</span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.filter(msg => !msg.toTarget || msg.toTarget === socket.id).map((msg, i) => (
                <div key={i} className={`flex flex-col ${msg.isSystem ? 'items-center' : 'items-start'}`}>
                  {!msg.isSystem && <span className="text-[11px] font-semibold text-sky-400 mb-0.5">{msg.sender}</span>}
                  {msg.isSystem ? (
                    <div className="text-[11px] italic text-slate-400 mt-2 mb-1">{msg.text}</div>
                  ) : (
                    <div className={`text-[13px] leading-relaxed text-slate-200 ${msg.text.includes('[检测到敏感词') ? 'bg-red-500/10 text-red-400 px-3 py-1.5 rounded border border-red-500/20' : ''}`}>
                      {msg.text}
                    </div>
                  )}
                </div>
              ))}
            </div>
            
            <form onSubmit={sendMessage} className="p-4 bg-slate-900 border-t border-slate-700 flex flex-col gap-2">
              <div className="flex gap-2">
                <input
                  className="flex-1 bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-sky-400 transition-colors placeholder-slate-500"
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  placeholder={currentPlayer?.isMuted ? "已禁言 (Sensitive Content Detected)" : "输入消息..."}
                  disabled={currentPlayer?.isMuted}
                />
                <button disabled={currentPlayer?.isMuted || !chatInput.trim()} type="submit" className="bg-sky-400 hover:bg-sky-500 disabled:opacity-50 disabled:hover:bg-sky-400 text-slate-900 px-4 rounded font-bold transition-colors">
                  <Send size={16} />
                </button>
              </div>
            </form>
          </div>
        </div>

      </div>
    </div>
  );
}

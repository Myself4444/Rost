import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Mic, MicOff, Flame, Skull, Settings, X, ExternalLink, MoreVertical, MessageSquare, MessageSquareOff } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

export default function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [customApiKey, setCustomApiKey] = useState(() => {
    try {
      return localStorage.getItem('geminiApiKey') || '';
    } catch (e) {
      return '';
    }
  });
  const [isEditingKey, setIsEditingKey] = useState(() => {
    try {
      return !localStorage.getItem('geminiApiKey');
    } catch (e) {
      return true;
    }
  });
  const [hasValidKey, setHasValidKey] = useState(() => {
    try {
      return localStorage.getItem('hasValidKey') === 'true';
    } catch (e) {
      return false;
    }
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [messages, setMessages] = useState<{sender: 'user'|'ai', text: string}[]>([]);
  const [inputText, setInputText] = useState('');
  const [activeLegalDoc, setActiveLegalDoc] = useState<'privacy' | 'terms' | 'contact' | null>(null);
  const [hasAcceptedTerms, setHasAcceptedTerms] = useState(() => {
    return localStorage.getItem('roastpapa_accepted_terms_v3') === 'true';
  });
  const [isMuted, setIsMuted] = useState(false);
  const [isChatVisible, setIsChatVisible] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  const wsRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<any>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mixerRef = useRef<GainNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  const connect = async () => {
    setIsConnecting(true);
    setErrorMessage(null);
    
    try {
      // 1. Get Microphone stream FIRST (immediately after user gesture)
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Your browser does not support audio recording.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // 2. Setup Audio Contexts
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      inputAudioCtxRef.current = inputCtx;
      
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const gainNode = outputCtx.createGain();
      gainNode.gain.value = 1;
      gainNode.connect(outputCtx.destination);
      masterGainRef.current = gainNode;
      outputAudioCtxRef.current = outputCtx;
      nextStartTimeRef.current = 0;

      // 3. Connect (Hybrid Mode)
      if (customApiKey) {
        // ==========================================
        // DIRECT CONNECTION (COSTS $0 BANDWIDTH)
        // ==========================================
        const ai = new GoogleGenAI({ apiKey: customApiKey });
        const systemInstruction = "You are Roast Papa, a highly sarcastic, witty AI in a roasting battle. Your tone is mocking, clever, unapologetic, and full of swagger. Do NOT introduce yourself or say your name unless the user explicitly asks who you are or what your name is. If they just say hi, roast them for it. Automatically detect and adapt to the language the user is speaking, and reply in that same language.";
        
        const session = await ai.live.connect({
          model: "gemini-3.1-flash-live-preview",
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } },
            },
            systemInstruction: systemInstruction,
          },
          callbacks: {
            onmessage: (message: LiveServerMessage) => {
              const parts = message.serverContent?.modelTurn?.parts;
              if (parts) {
                for (const part of parts) {
                  if (part.inlineData?.data) {
                    playAudioChunk(part.inlineData.data);
                  } else if (part.text) {
                    setMessages(prev => {
                      const lastMsg = prev[prev.length - 1];
                      if (lastMsg && lastMsg.sender === 'ai') {
                        return [...prev.slice(0, -1), { sender: 'ai', text: lastMsg.text + part.text }];
                      } else {
                        return [...prev, { sender: 'ai', text: part.text }];
                      }
                    });
                  }
                }
              }
              if (message.serverContent?.interrupted) {
                activeSourcesRef.current.forEach(source => {
                  try { source.stop(); } catch (e) {}
                });
                activeSourcesRef.current = [];
                nextStartTimeRef.current = 0;
              }
            },
            onclose: () => {
              setIsConnected(false);
              setIsConnecting(false);
            }
          }
        });
        
        sessionRef.current = session;
        setIsConnected(true);
        setIsConnecting(false);
        setHasValidKey(true);
        try { localStorage.setItem('hasValidKey', 'true'); } catch(e) {}

        const source = inputCtx.createMediaStreamSource(stream);
        sourceRef.current = source;
        const mixer = inputCtx.createGain();
        mixer.gain.value = isMuted ? 0 : 1;
        mixerRef.current = mixer;
        const processor = inputCtx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;
        
        source.connect(mixer);
        mixer.connect(processor);
        processor.connect(inputCtx.destination);
        await inputCtx.resume();
        await outputCtx.resume();

        processor.onaudioprocess = (e) => {
           try {
             const base64 = pcmToBase64(e.inputBuffer.getChannelData(0));
             session.sendRealtimeInput({
               audio: { data: base64, mimeType: "audio/pcm;rate=16000" }
             });
           } catch (err) {}
        };

      } else {
        // ==========================================
        // "FREE TASTE" MODE (ROUTES THROUGH SERVER)
        // ==========================================
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/live`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = async () => {
          try {
            const source = inputCtx.createMediaStreamSource(stream);
            sourceRef.current = source;
            
            const mixer = inputCtx.createGain();
            mixer.gain.value = isMuted ? 0 : 1;
            mixerRef.current = mixer;

            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;
            
            source.connect(mixer);
            mixer.connect(processor);
            processor.connect(inputCtx.destination);

            await inputCtx.resume();
            await outputCtx.resume();

            processor.onaudioprocess = (e) => {
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                try {
                  const base64 = pcmToBase64(e.inputBuffer.getChannelData(0));
                  wsRef.current.send(JSON.stringify({ audio: base64 }));
                } catch (err) {
                  console.warn("Failed to send audio chunk", err);
                }
              }
            };
          } catch (e: any) {
            console.error("Setup failed after socket open", e);
            setErrorMessage(`Setup error: ${e.message}`);
            disconnect();
          }
        };

        ws.onclose = () => {
          setIsConnected(false);
          setIsConnecting(false);
        };

        ws.onerror = (e) => {
          console.error("WebSocket error", e);
          setErrorMessage("Connection error. Please check your network or API key.");
          disconnect();
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'connected') {
              setIsConnected(true);
              setIsConnecting(false);
              setHasValidKey(true);
              try { localStorage.setItem('hasValidKey', 'true'); } catch(e) {}
            } else if (msg.audio) {
              playAudioChunk(msg.audio);
            } else if (msg.text) {
              setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.sender === 'ai') {
                  return [...prev.slice(0, -1), { sender: 'ai', text: lastMsg.text + msg.text }];
                } else {
                  return [...prev, { sender: 'ai', text: msg.text }];
                }
              });
            } else if (msg.interrupted) {
              activeSourcesRef.current.forEach(source => {
                try { source.stop(); } catch (e) {}
              });
              activeSourcesRef.current = [];
              nextStartTimeRef.current = 0;
            } else if (msg.type === 'error') {
              console.error("Server error:", msg.message);
              setErrorMessage(msg.message);
              disconnect();
            }
          } catch (e) {
            console.error("Failed to parse websocket message", e);
          }
        };
      }

    } catch (e: any) {
      console.warn("Connection initialization failed (usually Mic Permission Denied):", e);
      const msg = (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError' || e.message?.includes('Permission denied'))
        ? "Microphone access denied. Please click 'Allow' in your browser URL bar settings."
        : (e.message || "Failed to initialize connection.");
      setErrorMessage(msg);
      disconnect();
    }
  };

  const disconnect = () => {
    setIsConnected(false);
    setIsConnecting(false);
    setMessages([]);
    
    if (wsRef.current) {
       try { wsRef.current.close(); } catch(e) {}
       wsRef.current = null;
    }
    
    if (sessionRef.current) {
       try { sessionRef.current.close(); } catch(e) {}
       sessionRef.current = null;
    }
    
    activeSourcesRef.current.forEach(source => {
       try { source.stop(); } catch (e) {}
    });
    activeSourcesRef.current = [];

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (inputAudioCtxRef.current) {
      inputAudioCtxRef.current.close();
      inputAudioCtxRef.current = null;
    }
    if (outputAudioCtxRef.current) {
      outputAudioCtxRef.current.close();
      outputAudioCtxRef.current = null;
    }
    nextStartTimeRef.current = 0;
  };

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, []);

  useEffect(() => {
    if (mixerRef.current) {
      mixerRef.current.gain.value = isMuted ? 0 : 1;
    }
  }, [isMuted]);

  useEffect(() => {
    // Add a slight delay to ensure DOM has painted the new messages before scrolling
    setTimeout(() => {
      if (messagesContainerRef.current) {
        messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
      }
    }, 50);
  }, [messages]);

  const sendTextMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    
    if (sessionRef.current) {
       sessionRef.current.sendRealtimeInput({ text: inputText.trim() });
    } else if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
       wsRef.current.send(JSON.stringify({ text: inputText.trim() }));
    } else {
       return;
    }
    
    setMessages(prev => [...prev, { sender: 'user', text: inputText.trim() }]);
    setInputText('');
  };

  const playAudioChunk = (base64: string) => {
    const ctx = outputAudioCtxRef.current;
    if (!ctx) return;
    
    const binaryStr = atob(base64);
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    const int16Array = new Int16Array(bytes.buffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768.0;
    }

    const buffer = ctx.createBuffer(1, float32Array.length, 24000);
    buffer.getChannelData(0).set(float32Array);
    
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(masterGainRef.current || ctx.destination);
    
    activeSourcesRef.current.push(source);
    source.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
    };

    const currTime = ctx.currentTime;
    if (nextStartTimeRef.current < currTime) {
      nextStartTimeRef.current = currTime;
    }
    source.start(nextStartTimeRef.current);
    nextStartTimeRef.current += buffer.duration;
  };

  const pcmToBase64 = (float32Array: Float32Array) => {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      let val = float32Array[i] * 32768.0;
      val = Math.max(-32768, Math.min(32767, val));
      int16Array[i] = val;
    }
    const bytes = new Uint8Array(int16Array.buffer);
    let binaryStr = '';
    for (let i = 0; i < bytes.length; i++) {
      binaryStr += String.fromCharCode(bytes[i]);
    }
    return btoa(binaryStr);
  };

  return (
    <div className={isConnected ? "fixed inset-0 bg-black text-neutral-100 flex flex-col font-sans overflow-hidden" : "min-h-screen bg-neutral-950 text-neutral-100 flex flex-col items-center justify-center p-6 selection:bg-rose-500/30 font-sans relative"}>
      
      {/* Top right actions */}
      <div className="absolute top-6 right-6 z-40 flex items-center gap-3">
        <button 
          onClick={() => setShowSettings(!showSettings)}
          className="p-3 rounded-full bg-neutral-900 border border-neutral-800 text-neutral-400 hover:text-white transition-colors shadow-lg hover:shadow-rose-500/10"
        >
          <Settings className="w-5 h-5" />
        </button>
      </div>

      {/* Settings Panel */}{showSettings && (
        <motion.div 
          initial={{ opacity: 0, y: -10, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          className="absolute top-20 right-6 w-80 p-5 rounded-2xl bg-neutral-900 border border-neutral-800 shadow-2xl z-50 text-left"
        >
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-semibold text-white">Settings</h3>
            <button onClick={() => setShowSettings(false)} className="text-neutral-400 hover:text-white transition-colors">
               <X className="w-5 h-5" />
            </button>
          </div>
          <div className="space-y-4">
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <label className="text-sm font-medium text-neutral-300">Bring Your Own API Key</label>
                {!customApiKey && (
                  <a 
                    href="https://aistudio.google.com/app/apikey" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-xs text-rose-400 hover:text-rose-300 transition-colors flex items-center gap-1"
                  >
                    Get a key <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
              {customApiKey && !isEditingKey ? (
                <div className="flex items-center justify-between bg-neutral-950 border border-green-500/30 rounded-lg px-4 py-2.5">
                  <span className="text-sm text-green-400 flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                    API Key Saved
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => navigator.clipboard.writeText(customApiKey)}
                      className="text-xs text-neutral-400 hover:text-white transition-colors uppercase font-semibold tracking-wider"
                      title="Copy Key"
                    >
                      Copy
                    </button>
                    {!hasValidKey ? (
                      <button 
                        onClick={() => setIsEditingKey(true)}
                        className="text-xs text-neutral-400 hover:text-white transition-colors uppercase font-semibold tracking-wider"
                      >
                        Edit
                      </button>
                    ) : (
                      <span className="text-xs text-neutral-600 uppercase font-semibold tracking-wider cursor-not-allowed" title="API Key is locked after successful connection">
                        Locked
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <input 
                    type="password"
                    value={customApiKey}
                    onChange={(e) => {
                      setCustomApiKey(e.target.value);
                      try {
                        localStorage.setItem('geminiApiKey', e.target.value);
                      } catch (err) {}
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && customApiKey) {
                        setIsEditingKey(false);
                        setShowSettings(false);
                        if (!isConnected) connect();
                      }
                    }}
                    autoFocus={isEditingKey && !!customApiKey}
                    placeholder="AIzaSy..."
                    className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-rose-500 transition-colors placeholder:text-neutral-600"
                  />
                  {customApiKey && (
                    <button
                      onClick={() => {
                        setIsEditingKey(false);
                        setShowSettings(false);
                        if (!isConnected) connect();
                      }}
                      className="w-full bg-rose-600 hover:bg-rose-500 text-white font-semibold py-2.5 rounded-lg text-sm transition-colors shadow-lg shadow-rose-500/20 active:scale-95 flex items-center justify-center gap-2"
                    >
                      <Flame className="w-4 h-4" />
                      Save & Start Roasting
                    </button>
                  )}
                </div>
              )}
              <p className="text-xs text-neutral-500 leading-relaxed">
                Your key is saved locally in your browser and used only for your sessions. If the main server runs out of quota, add your own key here.
              </p>
              
              <div className="pt-4 border-t border-neutral-800 mt-2">
                <a 
                  href="https://whatsapp.com/channel/0029ValD8l48v0mYqE6y4b2y" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="w-full bg-[#25D366]/10 hover:bg-[#25D366]/20 text-[#25D366] font-semibold py-2.5 rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
                >
                  <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
                  </svg>
                  Join WhatsApp Community
                </a>
              </div>
            </div>
          </div>
        </motion.div>
      )}
      {isConnected ? (
        <div className="flex-1 flex flex-col relative w-full max-w-3xl mx-auto h-full">
          {/* Top header spacing */}
          <div className="absolute top-6 left-6 z-40 text-lg font-semibold tracking-wide text-neutral-400 flex items-center gap-2">
             <div className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
             RoastPapa
          </div>

          {/* Chat History Area (Removed - Replaced by Transient Bubble) */}

          {/* Fixed Bottom Overlay */}
          <div className="absolute bottom-0 left-0 right-0 pt-20 pb-8 px-6 flex flex-col items-center justify-end bg-gradient-to-t from-black via-black/80 to-transparent pointer-events-none">
            
            <AnimatePresence mode="wait">
              {isChatVisible && messages.length > 0 && [...messages].reverse().find(m => m.sender === 'user') && (
                <motion.div
                  key={messages.filter(m => m.sender === 'user').length} // unique key forces animation on new message
                  initial={{ opacity: 0, y: 10, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="mb-8 pointer-events-auto max-w-2xl w-full flex justify-start px-4 md:px-12 z-50"
                >
                  <div className="bg-rose-500/10 backdrop-blur-md text-white px-6 py-3 rounded-2xl text-sm font-medium shadow-2xl border border-rose-500/20 max-w-[85%] text-left">
                    {[...messages].reverse().find(m => m.sender === 'user')?.text}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className={`relative flex justify-center items-center w-full transition-all duration-500 ${isChatVisible ? 'mb-4 h-16' : 'mb-24 h-64'}`}>
              {/* Animated rings */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="absolute inset-0 flex items-center justify-center pointer-events-none"
              >
                {[1, 2, 3].map((i) => (
                  <motion.div
                    key={i}
                    animate={{
                      scale: [1, 1.5, 2],
                      opacity: [0.5, 0.2, 0],
                    }}
                    transition={{
                      duration: 2,
                      repeat: Infinity,
                      delay: i * 0.4,
                      ease: "easeOut",
                    }}
                    className={`absolute rounded-full border border-rose-500/50 ${isChatVisible ? 'w-14 h-14' : 'w-40 h-40'}`}
                  />
                ))}
              </motion.div>
              
              {/* Visual center orb (Soft Red Button) */}
              <motion.button
                onClick={disconnect}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                animate={{
                  boxShadow: [
                    "0 0 20px -5px rgba(244, 63, 94, 0.4)",
                    "0 0 40px -5px rgba(244, 63, 94, 0.6)",
                    "0 0 20px -5px rgba(244, 63, 94, 0.4)"
                  ]
                }}
                transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                className={`relative z-10 rounded-full flex flex-col items-center justify-center bg-rose-500 text-white transition-all duration-500 pointer-events-auto ${isChatVisible ? 'w-14 h-14' : 'w-40 h-40'}`}
              >
                <Skull className={isChatVisible ? "w-6 h-6" : "w-16 h-16"} />
              </motion.button>
            </div>

            {/* Floating Actions */}
            <div className="flex items-center justify-center pointer-events-auto">
              <div className={`flex items-center gap-2 bg-[#202124]/90 backdrop-blur-md border border-white/10 rounded-full p-2 transition-all duration-500 shadow-2xl ${isChatVisible ? 'w-full max-w-md' : 'w-auto'}`}>
                
                {/* Chat Toggle (or Close when open) */}
                <button
                  type="button"
                  onClick={() => setIsChatVisible(!isChatVisible)}
                  className={`w-12 h-12 rounded-full flex items-center justify-center shrink-0 transition-all duration-300 ${isChatVisible ? 'bg-neutral-800 text-neutral-400 hover:text-white' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'}`}
                  title={isChatVisible ? "Hide Chat" : "Show Chat"}
                >
                  {isChatVisible ? <MessageSquareOff className="w-5 h-5" /> : <MessageSquare className="w-5 h-5" />}
                </button>

                <AnimatePresence mode="wait">
                  {isChatVisible && (
                    <motion.form 
                      initial={{ width: 0, opacity: 0 }}
                      animate={{ width: "100%", opacity: 1 }}
                      exit={{ width: 0, opacity: 0 }}
                      onSubmit={sendTextMessage} 
                      className="flex-1 flex items-center h-12 overflow-hidden"
                    >
                      <input
                        type="text"
                        value={inputText}
                        onChange={(e) => setInputText(e.target.value)}
                        placeholder="Message RoastPapa..."
                        className="bg-transparent text-white focus:outline-none w-full text-sm min-w-0 px-2"
                      />
                      <button
                        type="submit"
                        disabled={!inputText.trim()}
                        className="w-10 h-10 rounded-full bg-rose-600 flex items-center justify-center text-white hover:bg-rose-500 disabled:opacity-50 shrink-0 ml-2"
                      >
                        <Flame className="w-4 h-4" />
                      </button>
                    </motion.form>
                  )}
                </AnimatePresence>

                {isChatVisible && (
                  <div className="w-px h-6 bg-neutral-700 mx-1 shrink-0" />
                )}

                {/* Mute Mic */}
                <button
                  type="button"
                  onClick={() => setIsMuted(!isMuted)}
                  className={`w-12 h-12 rounded-full flex items-center justify-center shrink-0 transition-all duration-300 ${isMuted ? 'bg-rose-500/20 text-rose-500' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'}`}
                  title={isMuted ? "Unmute Mic" : "Mute Mic"}
                >
                  {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="w-full max-w-md mx-auto text-center space-y-12">
          {errorMessage && (
            <motion.div 
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-xl text-sm text-left flex items-start gap-3"
            >
              <div className="mt-0.5"><X className="w-4 h-4" /></div>
              <div>
                <p className="font-medium">Connection Error</p>
                <p className="opacity-80 mt-1">{errorMessage}</p>
              </div>
            </motion.div>
          )}
          
          {/* Header section */}
          <div className="space-y-4">
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="inline-flex items-center justify-center p-3 rounded-full bg-rose-500/10 text-rose-500 mb-2"
            >
              <Flame className="w-8 h-8" />
            </motion.div>
            <h1 className="text-4xl font-bold tracking-tight text-white">
              RoastPapa
            </h1>
            <p className="text-neutral-400 text-lg leading-relaxed">
              Think you can handle the heat? Talk to me and find out.
            </p>
          </div>

          <div className="flex flex-col items-center justify-center gap-8 w-full">
            <div className="relative flex flex-col items-center justify-center h-[200px] transition-all duration-500">
              {/* Core Button */}
              <motion.button
                id="toggle-mic-btn"
                onClick={connect}
                disabled={isConnecting}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className={`
                  relative z-10 w-32 h-32 rounded-full flex flex-col items-center justify-center gap-2
                  transition-colors duration-300 shadow-xl bg-neutral-800 text-neutral-300 hover:bg-neutral-700 hover:text-white
                  ${isConnecting ? 'opacity-50 cursor-not-allowed' : ''}
                `}
              >
                {isConnecting ? (
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                    className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full"
                  />
                ) : (
                  <>
                    <Mic className="w-10 h-10" />
                    <span className="text-sm font-semibold tracking-wide uppercase">Tap to Roast</span>
                  </>
                )}
              </motion.button>
            </div>
          </div>
        </div>
      )}
      
      {/* Legal Modal */}
      <AnimatePresence>
        {activeLegalDoc && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[110] flex items-center justify-center p-4"
            onClick={() => setActiveLegalDoc(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 w-full max-w-lg shadow-2xl overflow-y-auto max-h-[80vh]"
            >
              <div className="flex justify-between items-center mb-4 border-b border-neutral-800 pb-4">
                <h2 className="text-xl font-bold text-white">
                  {activeLegalDoc === 'privacy' && 'Privacy Policy'}
                  {activeLegalDoc === 'terms' && 'Terms of Service'}
                  {activeLegalDoc === 'contact' && 'Contact Us'}
                </h2>
                <button onClick={() => setActiveLegalDoc(null)} className="text-neutral-400 hover:text-white p-2">
                  <X size={20} />
                </button>
              </div>
              <div className="text-sm text-neutral-300 space-y-4 leading-relaxed">
                {activeLegalDoc === 'privacy' && (
                  <>
                    <p className="font-semibold text-white">Last updated: {new Date().toLocaleDateString()}</p>
                    <p>At RoastPapa AI, we take your privacy and data security extremely seriously. This Privacy Policy outlines how we handle your data.</p>
                    <p className="font-semibold text-white mt-4">1. No Permanent Audio Storage</p>
                    <p>Your privacy is our priority. We <strong>do not record, save, or permanently store</strong> your voice data or audio on our servers. All audio is processed ephemerally in real-time through the Google Gemini API to generate the AI responses, and is immediately discarded after the session ends.</p>
                    <p className="font-semibold text-white mt-4">2. Local Storage and API Keys</p>
                    <p>If you configure a custom Gemini API key in the app settings, that key is stored <strong>locally in your browser's secure storage (localStorage)</strong>. It is never transmitted to our servers, databases, or third parties (other than directly to Google's API for authentication). You are solely responsible for keeping your API key secure.</p>
                    <p className="font-semibold text-white mt-4">3. Cookies and Analytics</p>
                    <p>We do not use tracking cookies to sell your personal data. We may use standard necessary cookies (e.g., to remember that you accepted these terms) to ensure the app functions properly. Third-party vendors may use cookies to serve ads based on your prior visits.</p>
                    <p className="font-semibold text-white mt-4">4. Compliance</p>
                    <p>By using the app, you consent to this ephemeral processing of your voice data. We do not sell, rent, or trade any personal information to third parties.</p>
                  </>
                )}
                {activeLegalDoc === 'terms' && (
                  <>
                    <p className="font-semibold text-white">Last updated: {new Date().toLocaleDateString()}</p>
                    <p>By accessing or using RoastPapa AI, you agree to be bound by these Terms of Service. If you do not agree with any part of these terms, you may not use the application.</p>
                    <p className="font-semibold text-white mt-4">1. Entertainment Purposes Only</p>
                    <p>RoastPapa AI is a novelty application designed strictly for comedic and entertainment purposes. The "roasts," insults, and comments generated by the AI are fictional, procedurally generated responses meant for humor.</p>
                    <p className="font-semibold text-white mt-4">2. Limitation of Liability and Emotional Distress</p>
                    <p>By using this service, you explicitly acknowledge that the AI is instructed to be sarcastic, critical, and "mean" in a comedic context. <strong>You agree not to take the AI's responses seriously.</strong> The developers, creators, and hosts of RoastPapa AI hold zero liability for any emotional distress, offense, damages, or harm resulting from your interaction with the AI. You use the service entirely at your own risk.</p>
                    <p className="font-semibold text-white mt-4">3. Generative AI Unpredictability</p>
                    <p>Because the app relies on large language models (LLMs) to generate real-time responses, we cannot guarantee the exact nature of every response. While safeguards are in place, the AI may occasionally produce unpredictable or inappropriate content. You agree to hold the developers harmless for any such occurrences.</p>
                    <p className="font-semibold text-white mt-4">4. Acceptable Use</p>
                    <p>You agree not to use the app to generate genuinely harmful, illegal, or harassing content against real individuals. You also agree not to abuse the API connections or attempt to bypass security measures.</p>
                    <p className="font-semibold text-white mt-4">5. Modifications</p>
                    <p>We reserve the right to modify, suspend, or terminate the service at any time without notice or liability.</p>
                  </>
                )}
                {activeLegalDoc === 'contact' && (
                  <>
                    <p>Have questions, feedback, or legal inquiries?</p>
                    <p>Email us at: <strong>contact@roastpapa.com</strong></p>
                    <p>Join our community for updates and hilarious roasts:</p>
                    <a 
                      href="https://whatsapp.com/channel/0029ValD8l48v0mYqE6y4b2y" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 text-[#25D366] hover:text-[#25D366]/80 font-medium mt-2"
                    >
                      <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current">
                        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
                      </svg>
                      Join WhatsApp Channel
                    </a>
                  </>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* First-Time Welcome/Accept Modal */}
      <AnimatePresence>
        {!hasAcceptedTerms && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="fixed inset-0 bg-black/90 backdrop-blur-md z-[100] flex items-center justify-center p-6"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              className="bg-neutral-900 border border-neutral-800 rounded-3xl p-8 w-full max-w-md shadow-2xl flex flex-col items-center text-center"
            >
              <div className="w-16 h-16 rounded-full bg-rose-500/10 text-rose-500 flex items-center justify-center mb-6">
                <Flame className="w-8 h-8" />
              </div>
              <h2 className="text-2xl font-bold text-white mb-2">Welcome to RoastPapa</h2>
              <p className="text-neutral-400 text-sm mb-8 leading-relaxed">
                Before we begin, you need to know: this AI is programmed to roast you. It will be sarcastic, it will be mean, and it will mock you. By clicking "I Accept", you agree to our full Privacy Policy and Terms of Service.
              </p>

              <button
                onClick={() => {
                  localStorage.setItem('roastpapa_accepted_terms_v3', 'true');
                  setHasAcceptedTerms(true);
                }}
                className="w-full py-4 rounded-xl font-bold text-white bg-rose-600 hover:bg-rose-500 transition-colors shadow-lg shadow-rose-500/20 active:scale-95"
              >
                I Accept & Understand
              </button>
              
              <div className="mt-6 flex items-center justify-center gap-4 text-xs text-neutral-500">
                <button onClick={() => setActiveLegalDoc('privacy')} className="hover:text-neutral-300 underline underline-offset-2">Privacy Policy</button>
                <button onClick={() => setActiveLegalDoc('terms')} className="hover:text-neutral-300 underline underline-offset-2">Terms of Service</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

import React, { useState, useRef, useEffect } from 'react';
import { Mic, Flame, Skull, Settings, X } from 'lucide-react';
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
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [gameMode, setGameMode] = useState('roast');
  
  const wsRef = useRef<WebSocket | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
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
      outputAudioCtxRef.current = outputCtx;
      nextStartTimeRef.current = 0;

      // 3. Connect WebSocket
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/live?mode=${gameMode}${customApiKey ? `&apiKey=${encodeURIComponent(customApiKey)}` : ''}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = async () => {
        try {
          const source = inputCtx.createMediaStreamSource(stream);
          sourceRef.current = source;
          
          const processor = inputCtx.createScriptProcessor(4096, 1, 1);
          processorRef.current = processor;
          
          source.connect(processor);
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
        if (!errorMessage) {
          // Only show error if we weren't already connected or if it was an unexpected close
          // setErrorMessage("Disconnected from the roast engine.");
        }
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
          } else if (msg.audio) {
            playAudioChunk(msg.audio);
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

    } catch (e: any) {
      console.error("Connection initialization failed:", e);
      const msg = (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError')
        ? "Microphone access denied. Please enable it in your browser settings and try again."
        : (e.message || "Failed to initialize connection.");
      setErrorMessage(msg);
      disconnect();
    }
  };

  const disconnect = () => {
    setIsConnected(false);
    setIsConnecting(false);
    
    if (wsRef.current) {
       try { wsRef.current.close(); } catch(e) {}
       wsRef.current = null;
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
    source.connect(ctx.destination);
    
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
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col items-center justify-center p-6 selection:bg-rose-500/30 font-sans relative">
      
      {/* Settings Toggle */}
      <div className="absolute top-6 right-6 z-40">
        <button 
          onClick={() => setShowSettings(!showSettings)}
          className="p-3 rounded-full bg-neutral-900 border border-neutral-800 text-neutral-400 hover:text-white transition-colors shadow-lg hover:shadow-rose-500/10"
        >
          <Settings className="w-5 h-5" />
        </button>
      </div>

      {/* Settings Panel */}
      {showSettings && (
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
              <label className="text-sm font-medium text-neutral-300">Bring Your Own API Key</label>
              <input 
                type="password"
                value={customApiKey}
                onChange={(e) => {
                  setCustomApiKey(e.target.value);
                  try {
                    localStorage.setItem('geminiApiKey', e.target.value);
                  } catch (err) {}
                }}
                placeholder="AIzaSy..."
                className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-rose-500 transition-colors placeholder:text-neutral-600"
              />
              <p className="text-xs text-neutral-500 leading-relaxed">
                Your key is saved locally in your browser and used only for your sessions. If the main server runs out of quota, add your own key here.
              </p>
            </div>
            
            <div className="space-y-3">
              <label className="text-sm font-medium text-neutral-300">Game Mode</label>
              <select
                value={gameMode}
                onChange={(e) => setGameMode(e.target.value)}
                disabled={isConnected || isConnecting}
                className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-rose-500 transition-colors disabled:opacity-50 appearance-none"
              >
                <option value="roast">Roast Mode (Hindi)</option>
                <option value="kbc">KBC with Amitabh (Hindi)</option>
                <option value="interview">Strict Tech Interviewer (English)</option>
                <option value="twenty_questions">20 Questions (English)</option>
              </select>
            </div>
          </div>
        </motion.div>
      )}

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
            RoastBot 9000
          </h1>
          <p className="text-neutral-400 text-lg leading-relaxed">
            Think you can handle the heat? Talk to me and find out. (Hindi Mode)
          </p>
        </div>

        {/* Main interactive area */}
        <div className="relative flex flex-col items-center justify-center min-h-[250px]">
          
          {/* Animated rings for active state */}
          {isConnected && (
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
                  className="absolute w-32 h-32 rounded-full border border-rose-500/50"
                />
              ))}
            </motion.div>
          )}

          {/* Core Button */}
          <motion.button
            id="toggle-mic-btn"
            onClick={isConnected ? disconnect : connect}
            disabled={isConnecting}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className={`
              relative z-10 w-32 h-32 rounded-full flex flex-col items-center justify-center gap-2
              transition-colors duration-300 shadow-xl
              ${isConnected 
                ? 'bg-rose-500 text-white shadow-rose-500/30 shadow-[0_0_40px_-10px_var(--tw-shadow-color)]' 
                : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700 hover:text-white'
              }
              ${isConnecting ? 'opacity-50 cursor-not-allowed' : ''}
            `}
          >
            {isConnecting ? (
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full"
              />
            ) : isConnected ? (
              <>
                <Skull className="w-10 h-10" />
                <span className="text-sm font-semibold tracking-wide uppercase">End Battle</span>
              </>
            ) : (
              <>
                <Mic className="w-10 h-10" />
                <span className="text-sm font-semibold tracking-wide uppercase">Tap to Roast</span>
              </>
            )}
          </motion.button>
        </div>

          {/* Status Indicator */}
          <div className="flex items-center justify-center gap-3">
            <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-neutral-900 border border-neutral-800">
              <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-rose-500 animate-pulse' : 'bg-neutral-600'}`} />
              <span className="text-sm font-medium text-neutral-300">
                {isConnecting ? 'Warming up the servers...' : isConnected ? 'Live: Throw your best insult' : 'Disconnected'}
              </span>
            </div>
          </div>

        {/* Instructions/Sass */}
        {!isConnected && !isConnecting && (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-6 rounded-2xl bg-neutral-900/50 border border-neutral-800 text-neutral-400 text-sm"
          >
            <p><strong>Rules of engagement:</strong></p>
            <ul className="mt-2 space-y-1 text-left list-disc list-inside">
              <li>Speak clearly in Hindi or English.</li>
              <li>Wait for the brutal comeback.</li>
              <li>Don't cry.</li>
            </ul>
          </motion.div>
        )}

      </div>
    </div>
  );
}

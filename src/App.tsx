import { useState, useRef, useEffect } from 'react';
import { Mic, MicOff, Flame, Skull, Key } from 'lucide-react';
import { motion } from 'motion/react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';

export default function App() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('gemini_api_key') || '');
  const [isApiKeySet, setIsApiKeySet] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  
  const sessionRef = useRef<any>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nextStartTimeRef = useRef<number>(0);

  useEffect(() => {
    if (apiKey) {
      localStorage.setItem('gemini_api_key', apiKey);
    }
  }, [apiKey]);

  const handleSetApiKey = (e: React.FormEvent) => {
    e.preventDefault();
    if (apiKey.trim()) {
      setIsApiKeySet(true);
    }
  };

  const connect = async () => {
    if (!apiKey) return;
    
    setIsConnecting(true);
    
    try {
      const ai = new GoogleGenAI({ apiKey: apiKey.trim() });
      
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      inputAudioCtxRef.current = inputCtx;
      
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      outputAudioCtxRef.current = outputCtx;
      nextStartTimeRef.current = 0;

      const session = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } },
          },
          systemInstruction: "You are a highly sarcastic, witty AI in a roasting battle. The user is trying to roast you, and you must roast them back in Hindi. Your tone should be mocking, clever, and unapologetic. Always reply in Hindi.",
        },
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
             const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
             if (audio) {
                playAudioChunk(audio);
             }
             if (message.serverContent?.interrupted) {
                nextStartTimeRef.current = 0;
             }
          },
          onclose: () => {
            disconnect();
          },
        },
      });

      sessionRef.current = session;
      
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        
        const source = inputCtx.createMediaStreamSource(stream);
        sourceRef.current = source;
        
        const processor = inputCtx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;
        
        source.connect(processor);
        processor.connect(inputCtx.destination);

        processor.onaudioprocess = (e) => {
          if (sessionRef.current) {
            const base64 = pcmToBase64(e.inputBuffer.getChannelData(0));
            sessionRef.current.sendRealtimeInput({
              audio: { data: base64, mimeType: "audio/pcm;rate=16000" },
            });
          }
        };
        
        setIsConnected(true);
        setIsConnecting(false);
      } catch (e) {
        console.error("Microphone access denied or failed", e);
        disconnect();
      }

    } catch (e) {
      console.error(e);
      alert("Failed to connect. Please check your API key.");
      setIsApiKeySet(false);
      disconnect();
    }
  };

  const disconnect = () => {
    setIsConnected(false);
    setIsConnecting(false);
    
    if (sessionRef.current) {
       // There's no explicit close on the session from the SDK, but we nullify it.
       sessionRef.current = null;
    }
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

  if (!isApiKeySet) {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col items-center justify-center p-6 selection:bg-rose-500/30 font-sans">
        <div className="w-full max-w-md mx-auto text-center space-y-8">
          <div className="space-y-4">
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="inline-flex items-center justify-center p-3 rounded-full bg-rose-500/10 text-rose-500 mb-2"
            >
              <Key className="w-8 h-8" />
            </motion.div>
            <h1 className="text-3xl font-bold tracking-tight text-white">
              Enter API Key
            </h1>
            <p className="text-neutral-400 text-sm leading-relaxed">
              This app connects directly to Gemini from your browser. Please enter your Gemini API key. It will be stored locally in your browser.
            </p>
          </div>
          
          <form onSubmit={handleSetApiKey} className="space-y-4">
            <input
              type="password"
              placeholder="AIzaSy..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-3 text-neutral-100 focus:outline-none focus:ring-2 focus:ring-rose-500/50"
              required
            />
            <button
              type="submit"
              className="w-full bg-rose-500 hover:bg-rose-600 text-white font-medium py-3 rounded-xl transition-colors"
            >
              Start Roasting
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col items-center justify-center p-6 selection:bg-rose-500/30 font-sans">
      <div className="w-full max-w-md mx-auto text-center space-y-12">
        
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
            
            <button 
              onClick={() => setIsApiKeySet(false)}
              className="mt-6 text-xs text-neutral-500 hover:text-neutral-300 underline underline-offset-2"
            >
              Change API Key
            </button>
          </motion.div>
        )}

      </div>
    </div>
  );
}


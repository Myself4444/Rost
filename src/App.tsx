import { useState, useRef, useEffect } from 'react';
import { Mic, Flame, Skull, Sparkles, Key } from 'lucide-react';
import { motion } from 'motion/react';
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";

export default function App() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('gemini_api_key') || '');
  const [isEditingKey, setIsEditingKey] = useState(!localStorage.getItem('gemini_api_key'));
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [tone, setTone] = useState('sarcastic');
  const [language, setLanguage] = useState('hindi');
  
  const sessionRef = useRef<any>(null);
  const resumptionHandleRef = useRef<string | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nextStartTimeRef = useRef<number>(0);

  const saveApiKey = (key: string) => {
    setApiKey(key);
    localStorage.setItem('gemini_api_key', key);
  };

  const connect = async () => {
    if (!apiKey) {
      alert("Please provide a Gemini API Key first.");
      return;
    }

    setIsConnecting(true);
    
    try {
      const ai = new GoogleGenAI({ apiKey, });
      const langName = language === "kannada" ? "Kannada" : language === "english" ? "English" : "Hindi";
      
      let systemInstruction = `You are a highly sarcastic, witty AI in a roasting battle. The user is trying to roast you, and you must roast them back. Your tone should be mocking, clever, and unapologetic. Always reply in ${langName}.`;
      let voiceName = "Puck";
      
      if (tone === "poetic") {
        systemInstruction = `You are a poetic and philosophical AI. Always reply in ${langName} using beautiful, poetic language and metaphors.`;
        voiceName = "Zephyr";
      }

      const config: any = {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName } },
        },
        systemInstruction,
      };

      if (resumptionHandleRef.current) {
        config.sessionResumption = { handle: resumptionHandleRef.current };
      }

      sessionRef.current = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config,
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            if (message.sessionResumptionUpdate && message.sessionResumptionUpdate.resumable !== false) {
              if (message.sessionResumptionUpdate.newHandle) {
                resumptionHandleRef.current = message.sessionResumptionUpdate.newHandle;
              }
            }
            const audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audio) {
              playAudioChunk(audio);
            }
            if (message.serverContent?.interrupted) {
              nextStartTimeRef.current = 0;
            }
          },
          onclose: () => {
            console.log("Gemini session closed");
            disconnect();
          },
        },
      });

      setIsConnected(true);
      setIsConnecting(false);

      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      inputAudioCtxRef.current = inputCtx;
      
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      outputAudioCtxRef.current = outputCtx;
      nextStartTimeRef.current = 0;

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
      } catch (e) {
        console.error("Microphone access denied or failed", e);
        disconnect();
      }

    } catch (e) {
      console.error("Failed to connect to Gemini Live:", e);
      alert("Failed to connect. Please check your API key or network.");
      disconnect();
    }
  };

  const disconnect = () => {
    setIsConnected(false);
    setIsConnecting(false);
    
    if (sessionRef.current) {
      // no native explicit close if we just drop references? 
      // some implementations might have sessionRef.current.disconnect() or similar.
      // we'll try to let it GC or close via websocket if possible, actually live client doesn't expose disconnect natively in all versions, we just drop it.
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

  return (
    <div className={`min-h-screen bg-neutral-950 text-neutral-100 flex flex-col items-center justify-center p-6 font-sans ${
      tone === 'poetic' ? 'selection:bg-purple-500/30' :
      'selection:bg-rose-500/30'
    }`}>
      <div className="w-full max-w-md mx-auto text-center space-y-12">
        
        {/* Header section */}
        <div className="space-y-4">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className={`inline-flex items-center justify-center p-3 rounded-full mb-2 ${
              tone === 'poetic' ? 'bg-purple-500/10 text-purple-500' :
              'bg-rose-500/10 text-rose-500'
            }`}
          >
            {tone === 'sarcastic' && <Flame className="w-8 h-8" />}
            {tone === 'poetic' && <Sparkles className="w-8 h-8" />}
          </motion.div>
          <h1 className="text-4xl font-bold tracking-tight text-white">
            {tone === 'sarcastic' ? 'RoastBot 9000' : 'KaviBot 9000'}
          </h1>
          <p className="text-neutral-400 text-lg leading-relaxed">
            {tone === 'sarcastic' ? `Think you can handle the heat? (${language.charAt(0).toUpperCase() + language.slice(1)} Mode)` :
              `Speak to me, and I shall answer in verses. (${language.charAt(0).toUpperCase() + language.slice(1)} Mode)`}
          </p>
        </div>

        {/* API Key Input */}
        {!isConnected && !isConnecting && isEditingKey && (
          <div className="bg-neutral-900/50 p-4 rounded-2xl border border-neutral-800 space-y-3">
            <div className="flex items-center gap-2 text-sm text-neutral-400 justify-center">
              <Key className="w-4 h-4" />
              <span>Bring Your Own API Key</span>
            </div>
            <input
              type="password"
              placeholder="Enter Gemini API Key..."
              value={apiKey}
              onChange={(e) => saveApiKey(e.target.value)}
              className="w-full bg-neutral-950 border border-neutral-700 text-white text-sm rounded-lg focus:ring-rose-500 focus:border-rose-500 block p-2.5 outline-none text-center"
            />
            <button 
              onClick={() => { if(apiKey) setIsEditingKey(false); }}
              disabled={!apiKey}
              className="w-full py-2 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm rounded-lg transition-colors text-white"
            >
              Save Key
            </button>
            <p className="text-xs text-neutral-500">
              Keys are saved locally in your browser.{' '}
              <a 
                href="https://aistudio.google.com/app/apikey" 
                target="_blank" 
                rel="noreferrer" 
                className="text-neutral-300 hover:text-white underline underline-offset-2 transition-colors"
              >
                Get a Gemini API key
              </a>
            </p>
          </div>
        )}

        {/* Tone Selector */}
        {!isConnected && !isConnecting && (
          <div className="flex flex-col items-center gap-3">
            <select
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              className="bg-neutral-900 border border-neutral-700 text-white text-sm rounded-lg focus:ring-rose-500 focus:border-rose-500 block p-2.5 outline-none"
            >
              <option value="sarcastic">Sarcastic (Roasting)</option>
              <option value="poetic">Poetic</option>
            </select>

            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="bg-neutral-900 border border-neutral-700 text-white text-sm rounded-lg focus:ring-rose-500 focus:border-rose-500 block p-2.5 outline-none"
            >
              <option value="hindi">Hindi</option>
              <option value="kannada">Kannada</option>
              <option value="english">English</option>
            </select>
          </div>
        )}

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
                  className={`absolute w-32 h-32 rounded-full border ${
                    tone === 'poetic' ? 'border-purple-500/50' :
                    'border-rose-500/50'
                  }`}
                />
              ))}
            </motion.div>
          )}

          {/* Core Button */}
          <motion.button
            id="toggle-mic-btn"
            onClick={isConnected ? disconnect : connect}
            disabled={isConnecting || (!apiKey && !isConnected)}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className={`
              relative z-10 w-32 h-32 rounded-full flex flex-col items-center justify-center gap-2
              transition-colors duration-300 shadow-xl
              ${isConnected 
                ? (tone === 'sarcastic' ? 'bg-rose-500 text-white shadow-rose-500/30 shadow-[0_0_40px_-10px_var(--tw-shadow-color)]' : 
                  'bg-purple-500 text-white shadow-purple-500/30 shadow-[0_0_40px_-10px_var(--tw-shadow-color)]')
                : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700 hover:text-white'
              }
              ${(isConnecting || (!apiKey && !isConnected)) ? 'opacity-50 cursor-not-allowed' : ''}
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
                {tone === 'sarcastic' && <Skull className="w-10 h-10" />}
                {tone === 'poetic' && <Sparkles className="w-10 h-10" />}
                <span className="text-sm font-semibold tracking-wide uppercase">End Session</span>
              </>
            ) : (
              <>
                <Mic className="w-10 h-10" />
                <span className="text-sm font-semibold tracking-wide uppercase">Tap to {tone === 'sarcastic' ? 'Roast' : 'Speak'}</span>
              </>
            )}
          </motion.button>
        </div>

        {/* Status Indicator */}
        <div className="flex items-center justify-center gap-3">
          <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-neutral-900 border border-neutral-800">
            <div className={`w-2 h-2 rounded-full ${isConnected ? (tone === 'sarcastic' ? 'bg-rose-500 animate-pulse' : 'bg-purple-500 animate-pulse') : 'bg-neutral-600'}`} />
            <span className="text-sm font-medium text-neutral-300">
              {isConnecting ? 'Warming up the servers...' : isConnected ? (tone === 'sarcastic' ? 'Live: Throw your best insult' : 'Live: Recite a poem') : 'Disconnected'}
            </span>
          </div>
        </div>

      </div>


    </div>
  );
}

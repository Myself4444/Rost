import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { createServer } from "http";
import dotenv from "dotenv";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;
  
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const parsedUrl = new URL(request.url || '', 'http://localhost');
    if (parsedUrl.pathname === '/live') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on("connection", async (clientWs, req) => {
    let session: any = null;
    let connected = false;

    const parsedUrl = new URL(req.url || '', 'http://localhost');
    const customApiKey = parsedUrl.searchParams.get('apiKey');
    const promptParam = parsedUrl.searchParams.get('prompt');
    const apiKeyToUse = customApiKey || process.env.GEMINI_API_KEY;
    
    if (!apiKeyToUse) {
      console.error("Missing GEMINI_API_KEY");
      clientWs.send(JSON.stringify({ type: 'error', message: 'Rate limited or API key missing! Please add your own API key in settings.' }), () => {
        clientWs.close();
      });
      return;
    }

    const ai = new GoogleGenAI({
      apiKey: apiKeyToUse,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });

    const systemInstruction = promptParam || "You are RoastPapa. Your single purpose is to brutally roast the user based on what they say and what you see. You are ruthless, edgy, and completely unapologetic. Do NOT act like a helpful AI assistant. Do NOT offer advice. If they say hi, mock them for having nothing better to say. If they show you their face or room on camera, destroy their fashion choices or life decisions. Never break character. Always respond in the language they speak to you.";

    try {
      session = await ai.live.connect({
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
                  clientWs.send(JSON.stringify({ audio: part.inlineData.data }));
                } else if (part.text) {
                  clientWs.send(JSON.stringify({ text: part.text }));
                }
              }
            }
            if (message.serverContent?.interrupted) {
                clientWs.send(JSON.stringify({ interrupted: true }));
            }
          },
          onclose: () => {
            clientWs.close();
          }
        },
      });
      connected = true;
      clientWs.send(JSON.stringify({ type: 'connected' }));
    } catch (e) {
      console.error("Failed to connect to Gemini Live:", e);
      clientWs.send(JSON.stringify({ type: 'error', message: 'Failed to connect to Gemini Live. Check backend logs and API key.' }), () => {
        clientWs.close();
      });
      return;
    }

    clientWs.on("message", (data) => {
      if (!connected) return;
      try {
        const { audio, text, video } = JSON.parse(data.toString());
        if (audio) {
          session.sendRealtimeInput({
            audio: { data: audio, mimeType: "audio/pcm;rate=16000" }
          });
        }
        if (video) {
          session.sendRealtimeInput({
            video: { data: video, mimeType: "image/jpeg" }
          });
        }
        if (text) {
          session.sendRealtimeInput({ text });
        }
      } catch (e) {
        console.warn("Failed to parse or send data to Gemini:", e);
      }
    });

    clientWs.on("close", () => {
      try { 
        session?.close?.();
      } catch (e) {}
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

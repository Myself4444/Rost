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
  const wss = new WebSocketServer({ server, path: "/live" });

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

    const systemInstruction = promptParam || "You are a highly sarcastic, witty AI in a roasting battle. The user is trying to roast you, and you must roast them back. Your tone should be mocking, clever, and unapologetic. Automatically detect and adapt to the language the user is speaking, and reply in that same language.";

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
        const { audio, text } = JSON.parse(data.toString());
        if (audio) {
          session.sendRealtimeInput({
            audio: { data: audio, mimeType: "audio/pcm;rate=16000" }
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

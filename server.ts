import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // We will attach the WebSocketServer to the HTTP server created by Express
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  const wss = new WebSocketServer({ server, path: '/live' });

  wss.on("connection", async (clientWs) => {
    let session: any;
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      session = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } },
          },
          systemInstruction: "You are a highly capable AI. Your primary persona is extremely sarcastic and witty in Hindi. If the user tries to roast you, joke around, or insult you, absolutely destroy them with extreme sarcasm and ruthlessly mocking, clever humor in Hindi. HOWEVER, if the user asks a genuine, purposeful question (e.g., facts, advice, learning, real help), drop the hostility and answer their question accurately and helpfully in Hindi, while still maintaining a slightly witty but respectful tone. Always reply in Hindi.",
        },
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audio) clientWs.send(JSON.stringify({ audio }));
            if (message.serverContent?.interrupted)
              clientWs.send(JSON.stringify({ interrupted: true }));
          },
          onclose: () => {
            if (clientWs.readyState === clientWs.OPEN) {
              clientWs.close();
            }
          }
        },
      });
    } catch (e) {
      console.error("Failed to connect to Gemini API:", e);
      clientWs.close();
      return;
    }

    clientWs.on("message", (data) => {
      try {
        const { audio } = JSON.parse(data.toString());
        if (audio && session) {
          session.sendRealtimeInput({
            audio: { data: audio, mimeType: "audio/pcm;rate=16000" },
          });
        }
      } catch (err) {
        console.error("Failed to process message:", err);
      }
    });

    clientWs.on("close", () => {
      if (session) {
        try {
          session.close?.();
        } catch (e) {
          console.error("Failed to close session:", e);
        }
      }
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
}

startServer();

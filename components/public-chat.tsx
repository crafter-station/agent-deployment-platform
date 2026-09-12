"use client";

import {
  ArrowRight,
  LoaderCircle,
  MessageCircle,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import MessageContent from "@/components/message-content";
import ScrollLatest from "@/components/scroll-latest";

type Message = { id: string; role: "user" | "assistant"; content: string };

export default function PublicChat({ agentId }: { agentId: string }) {
  const [agent, setAgent] = useState<{
    name: string;
    purpose: string;
    status: string;
  }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionId] = useState(() => crypto.randomUUID());
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    fetch(`/api/public/agents/${agentId}`)
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok)
          throw new Error(
            result.error?.message ||
              result.error ||
              "Este agente no está disponible.",
          );
        setAgent(result);
      })
      .catch((e) => setError(e.message));
  }, [agentId]);
  useEffect(() => {
    if (messages.length) endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);
  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!input.trim() || busy) return;
    const message = input.trim();
    setInput("");
    setError("");
    setBusy(true);
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", content: message },
    ]);
    try {
      const response = await fetch("/api/public/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          message,
          sessionId,
          operationId: crypto.randomUUID(),
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.error?.message ||
            result.error ||
            "No se pudo completar la respuesta.",
        );
      if (!result.text?.trim() || result.run?.status === "failed")
        throw new Error(
          result.run?.error ||
            "El agente no produjo una respuesta. Inténtalo de nuevo en un momento.",
        );
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", content: result.text },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo enviar.");
      setInput(message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="public-shell">
      <header className="public-header">
        <a href="/" className="brand">
          <span className="q-mark">Q</span>
          <span>
            Quequito<span className="brand-studio">Studio</span>
          </span>
        </a>
        <span className="public-ai-label">
          <span className="live-dot" />
          Un compañero de IA
        </span>
      </header>
      <section className="public-chat">
        <div className="public-agent-heading">
          <div className="agent-avatar">
            <span className="q-mark">{agent?.name.charAt(0) || "Q"}</span>
          </div>
          <h1>{agent?.name || "Tu compañero"}</h1>
          <p>
            {agent?.purpose ||
              (error
                ? "Este agente no está disponible por ahora."
                : "Abriendo conversación…")}
          </p>
        </div>
        <div className="public-messages">
          <ScrollLatest />
          {agent && messages.length === 0 && (
            <div className="public-welcome">
              <MessageCircle size={25} />
              <p>Hola. Empecemos con lo que necesitas.</p>
            </div>
          )}
          {messages.map((message) => (
            <div key={message.id} className={`preview-bubble ${message.role}`}>
              <span>{message.role === "user" ? "Tú" : agent?.name}</span>
              {message.role === "assistant" ? (
                <MessageContent content={message.content} />
              ) : (
                message.content
              )}
            </div>
          ))}
          {busy && (
            <div className="preview-pending">
              <LoaderCircle className="spin" size={16} />
              Pensando…
            </div>
          )}
          <div ref={endRef} />
        </div>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <form onSubmit={send} className="composer public-composer">
          <textarea
            aria-label="Mensaje para el agente"
            placeholder="¿En qué te ayudo?"
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button
            type="submit"
            aria-label="Enviar mensaje"
            className="send-button"
            disabled={
              busy || !input.trim() || !agent || agent.status !== "live"
            }
          >
            <ArrowRight size={20} />
          </button>
        </form>
        <p className="public-disclaimer">
          <ShieldCheck size={13} />
          Estás conversando con un agente de IA. Verifica la información
          importante.
        </p>
      </section>
      <footer className="public-footer">Hecho con Quequito Studio</footer>
    </main>
  );
}

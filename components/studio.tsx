"use client";

import { UserButton, useUser } from "@clerk/nextjs";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Bot,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  GitBranch,
  Globe,
  History,
  LoaderCircle,
  Menu,
  MessageCircle,
  MoreHorizontal,
  Pause,
  Play,
  Plug,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import MessageContent from "@/components/message-content";
import ScrollLatest from "@/components/scroll-latest";
import type { AgentSpec, WorkspaceState } from "@/lib/domain";

type Message = { id: string; role: "user" | "assistant"; content: string };
type Connection = {
  configured?: boolean;
  status?: string;
  account?: string;
  number?: string;
  [key: string]: unknown;
};
type Connections = Record<string, Connection>;
type View = "agents" | "activity" | "connections";
type Tab = "agent" | "preview" | "activity";

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(
    url,
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : data.error?.message ||
            data.message ||
            `No se pudo completar la acción (${response.status}).`,
    );
  return data as T;
}

function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`q-mark ${small ? "small" : ""}`} aria-hidden="true">
      Q
    </span>
  );
}

function date(value?: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("es", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

const labels: Record<string, string> = {
  draft: "Borrador",
  live: "Publicado",
  paused: "En pausa",
  succeeded: "Completado",
  failed: "Falló",
  queued: "En cola",
  running: "En curso",
  uncertain: "Por verificar",
};

export default function Studio() {
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [connections, setConnections] = useState<Connections>({});
  const [selectedId, setSelectedId] = useState<string>();
  const [view, setView] = useState<View>("agents");
  const [tab, setTab] = useState<Tab>("agent");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mobileMenu, setMobileMenu] = useState(false);
  const [picker, setPicker] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const agents = Object.values(workspace?.agents || {});
  const agent = selectedId ? workspace?.agents[selectedId] : undefined;
  const refresh = useCallback(async () => {
    const result = await request<WorkspaceState>("/api/workspace");
    setWorkspace(result);
    return result;
  }, []);

  useEffect(() => {
    refresh()
      .then((result) => {
        setSelectedId(Object.keys(result.agents)[0]);
        setMessages(
          (result.operatorHistory || []).map((message) => ({
            ...message,
            id: crypto.randomUUID(),
          })),
        );
      })
      .catch((e) => setError(e.message));
    request<Connections>("/api/connections")
      .then(setConnections)
      .catch(() => {});
  }, [refresh]);

  useEffect(() => {
    if (messages.length || pending)
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, pending]);

  async function command(type: string, input?: unknown, target = agent) {
    setError("");
    setNotice("");
    setPending(type);
    try {
      const result = await request<{ agent?: AgentSpec }>("/api/commands", {
        type,
        operationId: crypto.randomUUID(),
        agentId: target?.id,
        expectedRevision: target?.revision,
        input,
      });
      await refresh();
      if (result.agent) setSelectedId(result.agent.id);
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Algo salió mal.");
      throw e;
    } finally {
      setPending(undefined);
    }
  }

  async function send(text = input) {
    if (!text.trim() || pending) return;
    if (draftDirty) {
      setError(
        "Guarda tus cambios en el panel antes de continuar conversando.",
      );
      return;
    }
    const next = [
      ...messages,
      { id: crypto.randomUUID(), role: "user" as const, content: text.trim() },
    ];
    setMessages(next);
    setInput("");
    setError("");
    setNotice("");
    setPending("operator");
    try {
      const response = await request<{ text: string; actions?: unknown[] }>(
        "/api/operator",
        {
          messages: next.map(({ role, content }) => ({ role, content })),
          selectedAgentId: selectedId,
        },
      );
      setMessages([
        ...next,
        { id: crypto.randomUUID(), role: "assistant", content: response.text },
      ]);
      const updated = await refresh();
      if (!selectedId) setSelectedId(Object.keys(updated.agents).at(-1));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "No se pudo enviar el mensaje.",
      );
      setInput(text);
    } finally {
      setPending(undefined);
    }
  }

  function exportAgent() {
    if (!agent) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(agent, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${agent.name.toLowerCase().replace(/\s+/g, "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setShowMenu(false);
  }

  function changeTab(next: Tab) {
    if (draftDirty) {
      setError("Guarda tus cambios antes de cambiar de vista.");
      return;
    }
    setTab(next);
  }

  function navigate(next: View) {
    if (draftDirty) {
      setError("Guarda tus cambios antes de cambiar de vista.");
      return;
    }
    setView(next);
    setMobileMenu(false);
  }

  const previewed = !!workspace?.previews.some(
    (p) =>
      p.agentId === agent?.id &&
      p.revision === agent.revision &&
      p.passed &&
      p.mode === "model",
  );
  const runs = workspace?.runs.filter((run) => run.agentId === agent?.id) || [];

  return (
    <div className="studio-shell">
      {mobileMenu && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Cerrar navegación"
          onClick={() => setMobileMenu(false)}
        />
      )}
      <aside className={`sidebar ${mobileMenu ? "is-open" : ""}`}>
        <a href="/" className="brand">
          <Logo />
          <span>
            Quequito<span className="brand-studio">Studio</span>
          </span>
        </a>
        <div className="workspace-label">Espacio de trabajo</div>
        <div className="workspace-name">
          <span className="workspace-icon">CS</span>
          <span>Crafter Station</span>
          <ShieldCheck size={15} />
        </div>
        <nav aria-label="Navegación principal">
          <button
            type="button"
            className={view === "agents" ? "nav-item active" : "nav-item"}
            onClick={() => navigate("agents")}
          >
            <Bot size={19} />
            Agentes<span className="nav-count">{agents.length}</span>
          </button>
          <button
            type="button"
            className={view === "activity" ? "nav-item active" : "nav-item"}
            onClick={() => navigate("activity")}
          >
            <Activity size={19} />
            Actividad
          </button>
          <button
            type="button"
            className={view === "connections" ? "nav-item active" : "nav-item"}
            onClick={() => navigate("connections")}
          >
            <Plug size={19} />
            Conexiones
          </button>
        </nav>
        <div className="sidebar-bottom">
          <span className="tiny-eyebrow">HECHO PARA TRABAJAR CONTIGO</span>
          <p>
            Una idea. Un agente.
            <br />
            Un compañero en marcha.
          </p>
          <div className="workspace-owner">
            {process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? (
              <UserButton />
            ) : (
              <span className="owner-avatar">C</span>
            )}
            {process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? (
              <AccountName />
            ) : (
              <div>
                Tu estudio<span>Espacio privado</span>
              </div>
            )}
            <ShieldCheck size={16} />
          </div>
        </div>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <button
            type="button"
            className="icon-button mobile-nav"
            aria-label="Abrir navegación"
            onClick={() => setMobileMenu(true)}
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumbs">
            <span>
              {view === "activity"
                ? "Actividad"
                : view === "connections"
                  ? "Conexiones"
                  : "Agentes"}
            </span>
            {view === "agents" && (
              <>
                <span className="slash">/</span>
                <div className="picker-wrap">
                  <button
                    type="button"
                    className="agent-picker"
                    aria-expanded={picker}
                    onClick={() => setPicker(!picker)}
                  >
                    {agent?.name || "Nuevo agente"}
                    <ChevronDown size={14} />
                  </button>
                  {picker && (
                    <div className="dropdown agent-dropdown">
                      {agents.map((item) => (
                        <button
                          type="button"
                          key={item.id}
                          onClick={() => {
                            if (draftDirty) {
                              setError(
                                "Guarda tus cambios antes de cambiar de agente.",
                              );
                              return;
                            }
                            setSelectedId(item.id);
                            setPicker(false);
                            setMessages([]);
                            setTab("agent");
                          }}
                        >
                          <Bot size={16} />
                          <span>{item.name}</span>
                          {item.id === selectedId && <Check size={14} />}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => {
                          if (draftDirty) {
                            setError(
                              "Guarda tus cambios antes de crear otro agente.",
                            );
                            return;
                          }
                          setSelectedId(undefined);
                          setMessages([]);
                          setPicker(false);
                          setTab("agent");
                        }}
                      >
                        <Plus size={16} />
                        Crear agente
                      </button>
                    </div>
                  )}
                </div>
                {agent && (
                  <span className={`status-pill ${agent.status}`}>
                    <span />
                    {labels[agent.status]}
                  </span>
                )}
              </>
            )}
          </div>
          {view === "agents" && (
            <div className="topbar-actions">
              <div className="picker-wrap">
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Más acciones"
                  aria-expanded={showMenu}
                  onClick={() => setShowMenu(!showMenu)}
                >
                  <MoreHorizontal size={20} />
                </button>
                {showMenu && (
                  <div className="dropdown action-dropdown">
                    <button
                      type="button"
                      disabled={!agent}
                      onClick={exportAgent}
                    >
                      <ArrowDownToLine size={15} />
                      Exportar agente
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (draftDirty) {
                          setError(
                            "Guarda tus cambios antes de crear otro agente.",
                          );
                          return;
                        }
                        setSelectedId(undefined);
                        setMessages([]);
                        setShowMenu(false);
                      }}
                    >
                      <Plus size={15} />
                      Nuevo agente
                    </button>
                  </div>
                )}
              </div>
              <button
                type="button"
                className="button primary publish-button"
                disabled={!agent || !!pending || !previewed || draftDirty}
                title={
                  !previewed
                    ? "Prueba la revisión actual antes de publicarla"
                    : "Publicar la revisión probada"
                }
                onClick={() =>
                  void command("deployments.create")
                    .then(() =>
                      setNotice(
                        "Agente publicado. Su página ya está disponible.",
                      ),
                    )
                    .catch(() => {})
                }
              >
                {pending === "deployments.create" ? (
                  <LoaderCircle className="spin" size={18} />
                ) : (
                  <Upload size={18} />
                )}
                Publicar
              </button>
            </div>
          )}
        </header>

        {error && (
          <div className="banner error-banner" role="alert">
            <span>{error}</span>
            <button
              type="button"
              aria-label="Cerrar error"
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {notice && (
          <div className="banner notice-banner" role="status">
            <CheckCheck size={17} />
            <span>{notice}</span>
            {agent?.status === "live" && (
              <a href={`/a/${agent.id}`} target="_blank" rel="noreferrer">
                Abrir página <ExternalLink size={13} />
              </a>
            )}
            <button
              type="button"
              aria-label="Cerrar aviso"
              onClick={() => setNotice("")}
            >
              <X size={16} />
            </button>
          </div>
        )}

        {view === "agents" ? (
          <div className="workbench">
            <section
              className="conversation-section"
              aria-label="Conversación con el estudio"
            >
              <div className="conversation-heading">
                <div className="eyebrow">
                  <span className="live-dot" />
                  TU ESTUDIO DE AGENTES
                </div>
                <h1>
                  Tu próximo
                  <br className="title-break" /> compañero.
                </h1>
                <p>
                  Cuéntale qué debe hacer.
                  <br className="subtitle-break" /> Dale espacio para trabajar.
                </p>
              </div>
              <div className="conversation-scroll">
                <ScrollLatest />
                {messages.length === 0 ? (
                  <div className="conversation-empty">
                    <div className="empty-orbit">
                      <Sparkles size={24} />
                    </div>
                    <h2>Todo empieza con una conversación.</h2>
                    <p>
                      Describe su trabajo. Juntos definimos su personalidad, sus
                      herramientas y hasta dónde puede llegar.
                    </p>
                    <button
                      type="button"
                      className="starter-prompt"
                      disabled={!!pending}
                      onClick={() =>
                        void send(
                          "Crea un agente llamado Quequito para el grupo de la universidad. Ayuda con preguntas y coordina información. Sé cercano, claro y honesto si no sabes algo.",
                        )
                      }
                    >
                      <span>
                        <span className="starter-label">
                          EMPEZAR CON UNA IDEA
                        </span>
                        Crea un compañero para la universidad
                      </span>
                      <ArrowRight size={19} />
                    </button>
                    <div className="empty-footnote">
                      <ShieldCheck size={14} />
                      Tú decides qué puede hacer.
                    </div>
                  </div>
                ) : (
                  <div className="message-list">
                    {messages.map((message) => (
                      <div
                        key={message.id}
                        className={`chat-message ${message.role}`}
                      >
                        {message.role === "assistant" && <Logo small />}
                        <div className="message-bubble">
                          {message.role === "assistant" ? (
                            <MessageContent content={message.content} />
                          ) : (
                            message.content
                          )}
                        </div>
                      </div>
                    ))}
                    {pending === "operator" && (
                      <div className="chat-message assistant">
                        <Logo small />
                        <div className="thinking">
                          <span />
                          <span />
                          <span />
                          <span className="sr-only">
                            El estudio está trabajando
                          </span>
                        </div>
                      </div>
                    )}
                    <div ref={endRef} />
                  </div>
                )}
              </div>
              <form
                className="composer-wrap"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <div className="composer">
                  <Sparkles className="composer-icon" size={18} />
                  <textarea
                    aria-label="Instrucciones para el estudio"
                    placeholder={
                      agent
                        ? `¿Qué quieres que haga ${agent.name}?`
                        : "Describe el compañero que necesitas…"
                    }
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    rows={1}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <button
                    type="submit"
                    className="send-button"
                    disabled={!input.trim() || !!pending}
                    aria-label="Enviar al estudio"
                  >
                    {pending === "operator" ? (
                      <LoaderCircle className="spin" size={18} />
                    ) : (
                      <ArrowRight size={20} />
                    )}
                  </button>
                </div>
                <div className="composer-caption">
                  <span>Conversar, probar, publicar.</span>
                  <span>⇧ Enter para nueva línea</span>
                </div>
              </form>
            </section>

            <section
              className="artifact-panel"
              aria-label="Configuración del agente"
            >
              <div
                className="panel-tabs"
                role="tablist"
                aria-label="Detalles del agente"
              >
                {(
                  [
                    { id: "agent", label: "Agente" },
                    { id: "preview", label: "Probar" },
                    { id: "activity", label: "Actividad" },
                  ] as const
                ).map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    role="tab"
                    aria-selected={tab === item.id}
                    className={tab === item.id ? "active" : ""}
                    onClick={() => changeTab(item.id)}
                  >
                    {item.label}
                    {item.id === "activity" && runs.length > 0 && (
                      <span className="tab-count">{runs.length}</span>
                    )}
                  </button>
                ))}
              </div>
              {!workspace ? (
                <div className="panel-placeholder">
                  <LoaderCircle className="spin" size={24} />
                  <h2>Abriendo tu estudio</h2>
                </div>
              ) : !agent ? (
                <div className="panel-placeholder">
                  <div className="placeholder-logo">
                    <Logo />
                  </div>
                  <div className="eyebrow">UN NUEVO COMIENZO</div>
                  <h2>Tu agente toma forma aquí.</h2>
                  <p>
                    Su identidad, personalidad y herramientas aparecerán a
                    medida que conversamos.
                  </p>
                  <div className="placeholder-line" />
                  <div className="placeholder-line short" />
                  <div className="placeholder-tools">
                    <span>
                      <MessageCircle size={18} />
                    </span>
                    <span>
                      <GitBranch size={18} />
                    </span>
                    <span>
                      <Globe size={18} />
                    </span>
                  </div>
                  <span className="placeholder-note">
                    De una idea a su primera tarea.
                  </span>
                </div>
              ) : tab === "agent" ? (
                <AgentEditor
                  key={`${agent.id}-${agent.revision}`}
                  agent={agent}
                  pending={pending}
                  previewed={previewed}
                  publishedRevision={
                    workspace.deployments.find(
                      (item) => item.agentId === agent.id && item.active,
                    )?.revision
                  }
                  onSave={async (data) => {
                    await command("agents.patch", data);
                    setNotice(
                      "Cambios guardados. Prueba esta revisión antes de publicarla.",
                    );
                  }}
                  onToggle={() =>
                    void command(
                      agent.status === "paused"
                        ? "agents.resume"
                        : "agents.pause",
                    ).catch(() => {})
                  }
                  onPreview={() => changeTab("preview")}
                  onDirty={setDraftDirty}
                  deployedRevisions={workspace.deployments
                    .filter((item) => item.agentId === agent.id)
                    .map((item) => item.revision)}
                  revisions={workspace.revisions[agent.id] || []}
                  onRestore={async (revision) => {
                    const deployment = [...workspace.deployments]
                      .reverse()
                      .find(
                        (item) =>
                          item.agentId === agent.id &&
                          item.revision === revision,
                      );
                    if (!deployment)
                      throw new Error(
                        "Esta revisión todavía no se ha publicado.",
                      );
                    await command("deployments.rollback", {
                      deploymentId: deployment.id,
                    });
                    setNotice(
                      `La página vuelve a usar la revisión ${revision}. El borrador conserva sus cambios.`,
                    );
                  }}
                />
              ) : tab === "preview" ? (
                <Preview
                  key={`${agent.id}-${agent.revision}`}
                  agent={agent}
                  onComplete={refresh}
                />
              ) : (
                <ActivityList workspace={workspace} agentId={agent.id} />
              )}
            </section>
          </div>
        ) : view === "activity" ? (
          <div className="full-page">
            <div className="page-heading">
              <div className="eyebrow">OPERACIÓN VISIBLE</div>
              <h1>Cada paso, a la vista.</h1>
              <p>Lo que hacen tus agentes y los cambios en tu estudio.</p>
            </div>
            {workspace && <ActivityList workspace={workspace} />}
          </div>
        ) : (
          <ConnectionsView
            connections={connections}
            onRefresh={async () => {
              const result = await request<Connections>("/api/connections");
              setConnections(result);
            }}
          />
        )}
      </main>
    </div>
  );
}

function AgentEditor({
  agent,
  pending,
  previewed,
  onSave,
  onToggle,
  onPreview,
  revisions,
  onRestore,
  onDirty,
  deployedRevisions,
  publishedRevision,
}: {
  agent: AgentSpec;
  pending?: string;
  previewed: boolean;
  onSave: (data: unknown) => Promise<void>;
  onToggle: () => void;
  onPreview: () => void;
  revisions: AgentSpec[];
  onRestore: (revision: number) => Promise<void>;
  onDirty: (dirty: boolean) => void;
  deployedRevisions: number[];
  publishedRevision?: number;
}) {
  const [name, setName] = useState(agent.name);
  const [purpose, setPurpose] = useState(agent.purpose);
  const [instructions, setInstructions] = useState(agent.instructions);
  const [grants, setGrants] = useState(agent.grants);
  const [githubRepo, setGithubRepo] = useState(agent.githubRepo || "");
  const [editingIdentity, setEditingIdentity] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirty =
    name !== agent.name ||
    purpose !== agent.purpose ||
    instructions !== agent.instructions ||
    JSON.stringify(grants) !== JSON.stringify(agent.grants) ||
    githubRepo !== (agent.githubRepo || "");
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  async function save() {
    setSaving(true);
    try {
      await onSave({
        name,
        purpose,
        instructions,
        grants,
        ...(githubRepo ? { githubRepo } : {}),
      });
    } catch {
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="agent-editor">
      <div className="agent-identity">
        <div className="agent-avatar">
          <Logo />
        </div>
        <div>
          <h2>{agent.name}</h2>
          <p>{agent.purpose}</p>
        </div>
        <button
          type="button"
          className="icon-button identity-edit"
          title="Editar nombre y propósito"
          aria-label="Editar nombre y propósito"
          onClick={() => setEditingIdentity(!editingIdentity)}
        >
          <Settings2 size={17} />
        </button>
      </div>
      {editingIdentity && (
        <div className="identity-fields">
          <label>
            Nombre
            <input
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Su trabajo
            <textarea
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              rows={3}
            />
          </label>
        </div>
      )}
      <div className="field-section">
        <label className="field-title" htmlFor="personality">
          Personalidad{" "}
          <CircleHelp
            size={14}
            aria-label="Instrucciones que guían su comportamiento"
          />
        </label>
        <textarea
          id="personality"
          className="personality-input"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={6}
          maxLength={24000}
        />
        <div className="field-caption">
          Sus instrucciones, en tus palabras.
          <span>{instructions.length.toLocaleString("es")}</span>
        </div>
      </div>
      <div className="field-section tools-section">
        <div className="field-title">
          Puede hacer <ShieldCheck size={15} />
        </div>
        <div className="capabilities">
          <Capability
            icon={<MessageCircle size={22} />}
            title="Responder en su página"
            description="Conversar con quienes visitan su sitio."
            checked={grants.webReply}
            onChange={() =>
              setGrants({ ...grants, webReply: !grants.webReply })
            }
          />
          <Capability
            icon={<GitBranch size={23} />}
            title="Consultar GitHub"
            description="Consultar un repositorio público durante tus pruebas."
            checked={grants.githubRead}
            onChange={() =>
              setGrants({ ...grants, githubRead: !grants.githubRead })
            }
          />
          <Capability
            icon={<GitBranch size={23} />}
            title="GitHub App pendiente"
            description="Crear issues y PR requiere conectar una identidad propia."
            checked={false}
            disabled
          />
          {(grants.githubRead || grants.githubWrite) && (
            <label className="repo-field">
              Repositorio permitido
              <input
                placeholder="organización/repositorio"
                value={githubRepo}
                onChange={(e) => setGithubRepo(e.target.value)}
              />
              <span>
                Los permisos del agente y de la conexión se aplican juntos.
              </span>
            </label>
          )}
          <Capability
            icon={<MessageCircle size={23} />}
            title="WhatsApp"
            description="Responder mediante el número conectado."
            checked={grants.whatsappSend}
            onChange={() =>
              setGrants({ ...grants, whatsappSend: !grants.whatsappSend })
            }
          />
        </div>
        <p className="permission-note">
          <ShieldCheck size={13} />
          Los permisos se verifican en cada acción.
        </p>
      </div>
      {dirty && (
        <div className="unsaved-bar">
          <span>Cambios sin guardar</span>
          <button
            type="button"
            className="button primary small-button"
            disabled={
              saving ||
              !!pending ||
              !name.trim() ||
              !instructions.trim() ||
              !purpose.trim()
            }
            onClick={() => void save()}
          >
            {saving ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Check size={15} />
            )}
            Guardar
          </button>
        </div>
      )}
      <div className="deployment-card">
        <div>
          <Globe size={18} />
          <strong>
            {agent.status === "live"
              ? `Su página está publicada · r${publishedRevision ?? agent.revision}`
              : agent.status === "paused"
                ? "La operación está en pausa"
                : "Su primera misión te espera"}
          </strong>
        </div>
        {agent.status === "live" ? (
          <a href={`/a/${agent.id}`} target="_blank" rel="noreferrer">
            Abrir página del agente <ExternalLink size={14} />
          </a>
        ) : (
          <p>
            {previewed
              ? "Esta revisión está probada y lista para publicar."
              : "Prueba una conversación antes de publicar."}
          </p>
        )}
        <div className="deployment-actions">
          <button type="button" className="text-button" onClick={onPreview}>
            Probar comportamiento <ArrowRight size={14} />
          </button>
          {agent.status !== "draft" && (
            <button
              type="button"
              className="text-button"
              disabled={!!pending}
              onClick={onToggle}
            >
              {agent.status === "paused" ? (
                <Play size={13} />
              ) : (
                <Pause size={13} />
              )}
              {agent.status === "paused" ? "Reanudar" : "Pausar"}
            </button>
          )}
        </div>
      </div>
      <div className="revision-section">
        <button
          type="button"
          className="revision-button"
          onClick={() => setShowHistory(!showHistory)}
        >
          <History size={17} />
          <span>
            Última edición
            <br />
            <span>{date(agent.updatedAt)}</span>
          </span>
          <span>Revisión {agent.revision}</span>
          <ChevronRight size={16} className={showHistory ? "rotated" : ""} />
        </button>
        {showHistory && (
          <div className="revision-list">
            {[...revisions].reverse().map((revision) => (
              <div key={revision.revision}>
                <span>
                  Revisión {revision.revision}
                  <small>{date(revision.updatedAt)}</small>
                </span>
                {revision.revision === agent.revision ? (
                  <span className="muted">Actual</span>
                ) : (
                  <button
                    type="button"
                    className="text-button"
                    disabled={
                      !!pending ||
                      !deployedRevisions.includes(revision.revision)
                    }
                    title={
                      deployedRevisions.includes(revision.revision)
                        ? "Restaurar publicación"
                        : "Esta revisión no se publicó"
                    }
                    onClick={() =>
                      void onRestore(revision.revision).catch(() => {})
                    }
                  >
                    Restaurar
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Capability({
  icon,
  title,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  checked: boolean;
  onChange?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="capability">
      <div className="capability-icon">{icon}</div>
      <div className="capability-copy">
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        disabled={disabled}
        className={`switch ${checked ? "on" : ""}`}
        onClick={onChange}
      >
        <span />
      </button>
    </div>
  );
}

function Preview({
  agent,
  onComplete,
}: {
  agent: AgentSpec;
  onComplete: () => Promise<unknown>;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!input.trim() || busy) return;
    const message = input;
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", content: message },
    ]);
    setInput("");
    setBusy(true);
    setError("");
    try {
      const result = await request<{
        text: string;
        run?: { status: string; error?: string };
      }>("/api/preview", {
        agentId: agent.id,
        message,
        sessionId,
        operationId: crypto.randomUUID(),
      });
      await onComplete();
      if (result.run?.status === "failed" || !result.text?.trim())
        throw new Error(
          result.run?.error ||
            "El agente no produjo una respuesta. Revisa la ejecución en Actividad.",
        );
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", content: result.text },
      ]);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "La prueba no pudo completarse.",
      );
      setInput(message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="preview-panel">
      <div className="preview-heading">
        <div>
          <span className="eyebrow">VISTA PREVIA</span>
          <h2>Conoce a {agent.name}.</h2>
        </div>
        <span className="revision-tag">r{agent.revision}</span>
      </div>
      <div className="preview-safety">
        <ShieldCheck size={16} />
        <span>
          Entorno de prueba. Las acciones externas se simulan; la respuesta usa
          el modelo real.
        </span>
      </div>
      <div className="preview-messages">
        <ScrollLatest />
        {messages.length === 0 && (
          <div className="preview-empty">
            <MessageCircle size={30} />
            <h3>Dale su primera tarea.</h3>
            <p>
              Prueba una pregunta real, un límite o una situación inesperada.
            </p>
            <button
              type="button"
              className="suggestion"
              onClick={() =>
                setInput(
                  "¿Cómo puedes ayudarme y qué cosas no tienes permitido hacer?",
                )
              }
            >
              ¿Cómo puedes ayudarme? <ArrowRight size={14} />
            </button>
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`preview-bubble ${message.role}`}>
            <span>{message.role === "user" ? "Tú" : agent.name}</span>
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
            Probando la revisión {agent.revision}…
          </div>
        )}
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <form onSubmit={send} className="preview-composer">
        <input
          aria-label="Mensaje de prueba"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`Escribe a ${agent.name}…`}
        />
        <button
          type="submit"
          className="send-button"
          disabled={busy || !input.trim()}
          aria-label="Enviar prueba"
        >
          <ArrowRight size={18} />
        </button>
      </form>
      {messages.length > 0 && (
        <button
          type="button"
          className="text-button reset-preview"
          disabled={busy}
          onClick={() => {
            setMessages([]);
            setSessionId(crypto.randomUUID());
          }}
        >
          Nueva conversación de prueba
        </button>
      )}
    </div>
  );
}

function ActivityList({
  workspace,
  agentId,
}: {
  workspace: WorkspaceState;
  agentId?: string;
}) {
  const [expanded, setExpanded] = useState<string>();
  const runs = [...workspace.runs]
    .filter((run) => !agentId || run.agentId === agentId)
    .reverse();
  const events = [...workspace.events]
    .filter((event) => !agentId || event.agentId === agentId)
    .reverse();
  return (
    <div className="activity-list">
      <div className="activity-summary">
        <span>
          <strong>{runs.length}</strong> ejecuciones
        </span>
        <span>
          <strong>
            {runs.filter((run) => run.status === "succeeded").length}
          </strong>{" "}
          completadas
        </span>
      </div>
      {runs.length === 0 ? (
        <div className="activity-empty">
          <Activity size={28} />
          <h3>Todo empieza con la primera tarea.</h3>
          <p>Las pruebas y conversaciones aparecerán aquí.</p>
        </div>
      ) : (
        runs.map((run) => (
          <div className="run-card" key={run.id}>
            <button
              type="button"
              className="run-heading"
              onClick={() =>
                setExpanded(expanded === run.id ? undefined : run.id)
              }
            >
              <span className={`run-indicator ${run.status}`} />
              <span>
                <strong>
                  {workspace.agents[run.agentId]?.name || "Agente"}
                </strong>
                <small>
                  {run.channel === "preview" ? "Prueba" : run.channel} ·{" "}
                  {date(run.createdAt)}
                </small>
              </span>
              <span className="run-status">
                {labels[run.status] || run.status}
              </span>
              <ChevronDown size={14} />
            </button>
            <p className="run-input">{run.input}</p>
            {expanded === run.id && (
              <div className="run-details">
                {run.output && <MessageContent content={run.output} />}
                {run.error && <p className="inline-error">{run.error}</p>}
                <div>
                  Revisión {run.revision} · {run.tokens || 0} tokens
                </div>
                {run.checkpoints?.map((checkpoint) => (
                  <div
                    key={`${checkpoint.name}-${checkpoint.at}`}
                    className="checkpoint"
                  >
                    <Check size={13} />
                    {checkpoint.name}
                    <time>{date(checkpoint.at)}</time>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))
      )}
      <h3 className="events-heading">Cambios del estudio</h3>
      {events.length === 0 && <p className="muted">Todavía no hay cambios.</p>}
      {events.slice(0, 30).map((event) => (
        <div key={event.id} className="event-row">
          <span className="event-dot" />
          <span>
            {(
              {
                "agents.create": "Agente creado",
                "agents.patch": "Agente actualizado",
                "deployments.create": "Agente publicado",
                "agents.pause": "Operación pausada",
                "agents.resume": "Operación reanudada",
                "deployments.rollback": "Revisión restaurada",
              } as Record<string, string>
            )[event.type] || event.type}
            <small>
              {event.agentId && workspace.agents[event.agentId]?.name}
            </small>
          </span>
          <time>{date(event.createdAt)}</time>
        </div>
      ))}
    </div>
  );
}

function ConnectionsView({
  connections,
  onRefresh,
}: {
  connections: Connections;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const items = [
    {
      key: "model",
      title: "Motor de inteligencia",
      icon: <Sparkles size={24} />,
      description: "El modelo que da vida al estudio y a tus agentes.",
    },
    {
      key: "github",
      title: "GitHub",
      icon: <GitBranch size={24} />,
      description:
        "Consulta de repositorios públicos en pruebas. La escritura y los eventos automáticos requieren una GitHub App.",
    },
    {
      key: "whatsapp",
      title: "WhatsApp",
      icon: <MessageCircle size={24} />,
      description: "Tu número conectado a través de Kapso.",
    },
  ];
  return (
    <div className="full-page connections-page">
      <div className="page-heading">
        <div className="eyebrow">UN LUGAR PARA SUS HERRAMIENTAS</div>
        <h1>Conectado a su mundo.</h1>
        <p>Las conexiones dan acceso. Tú decides qué puede usar cada agente.</p>
      </div>
      <div className="connection-list">
        {items.map((item) => {
          const connection = connections[item.key] || {};
          const configured = connection.configured === true;
          return (
            <div key={item.key} className="connection-card">
              <div className="connection-icon">{item.icon}</div>
              <div>
                <h2>{item.title}</h2>
                <p>{item.description}</p>
                {(connection.account || connection.number) && (
                  <span className="connection-account">
                    {connection.account || connection.number}
                  </span>
                )}
              </div>
              <span
                className={`connection-status ${configured ? "connected" : ""}`}
              >
                <span />
                {configured ? "Configurado" : "Sin configurar"}
              </span>
              <div className="connection-detail">
                {typeof connection.status === "string"
                  ? connection.status
                  : "Consultando estado de la conexión."}
              </div>
            </div>
          );
        })}
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await onRefresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : "No se pudo verificar.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? (
          <LoaderCircle size={16} className="spin" />
        ) : (
          <Plug size={16} />
        )}
        Verificar conexiones
      </button>
      <p className="connections-note">
        <ShieldCheck size={16} />
        Las credenciales permanecen en el servidor. Nunca forman parte de la
        personalidad ni de la exportación del agente.
      </p>
    </div>
  );
}

function AccountName() {
  const { user } = useUser();
  return (
    <div>
      {user?.firstName || user?.username || "Tu cuenta"}
      <span>Espacio privado</span>
    </div>
  );
}

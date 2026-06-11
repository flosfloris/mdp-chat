// Chatbot.tsx
// Code component principale: bottone fluttuante + pannello chat.
// Trascinalo su qualsiasi pagina di Framer (o nei layout globali per averlo
// su tutto il sito) e configura nel pannello proprietà l'URL del backend.
//
// USO IN FRAMER:
// 1. Aggiungi il componente alla pagina (o al template globale)
// 2. Imposta "Backend URL" → es. https://mdp-chat.onrender.com
// 3. Personalizza colori, posizione, messaggio di benvenuto
// 4. Pubblica.

import * as React from "react"
import { addPropertyControls, ControlType } from "framer"

type Message = { role: "user" | "assistant"; content: string }

type Props = {
    backendUrl: string
    brandColor: string
    accentColor: string
    welcomeMessage: string
    placeholder: string
    title: string
    position: "bottom-right" | "bottom-left"
    showTeaser: boolean
    teaserMessage: string
    teaserDelay: number
}

const STORAGE_KEY = "mdp_chatbot_history_v1"
const MAX_HISTORY = 20

/**
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight any
 * @framerIntrinsicWidth 0
 * @framerIntrinsicHeight 0
 */
export default function Chatbot({
    backendUrl = "https://your-app.onrender.com",
    brandColor = "#FF4F8E",
    accentColor = "#FFFFFF",
    welcomeMessage = "Ciao! Dimmi l'età del bimbo e ti trovo l'evento giusto 🎈",
    placeholder = "Scrivi qui...",
    title = "Milano da Piccoli",
    position = "bottom-right",
    showTeaser = true,
    teaserMessage = "Ciao! Posso aiutarti? 👋",
    teaserDelay = 1.5,
}: Props) {
    const [open, setOpen] = React.useState(false)
    const [messages, setMessages] = React.useState<Message[]>([])
    const [input, setInput] = React.useState("")
    const [streaming, setStreaming] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)
    const [teaserVisible, setTeaserVisible] = React.useState(false)
    const scrollRef = React.useRef<HTMLDivElement>(null)
    const abortRef = React.useRef<AbortController | null>(null)

    // Teaser: compare dopo un ritardo e resta sempre visibile (niente
    // chiusura manuale); sparisce solo quando si apre la chat.
    React.useEffect(() => {
        if (!showTeaser || open) return
        const t = setTimeout(
            () => setTeaserVisible(true),
            Math.max(0, teaserDelay) * 1000
        )
        return () => clearTimeout(t)
    }, [showTeaser, open, teaserDelay])

    // Restore history
    React.useEffect(() => {
        try {
            const raw = localStorage.getItem(STORAGE_KEY)
            if (raw) setMessages(JSON.parse(raw))
        } catch {}
    }, [])

    // Persist
    React.useEffect(() => {
        try {
            localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify(messages.slice(-MAX_HISTORY))
            )
        } catch {}
    }, [messages])

    // Auto-scroll
    React.useEffect(() => {
        if (scrollRef.current)
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }, [messages, streaming])

    async function send() {
        const text = input.trim()
        if (!text || streaming) return

        const userMsg: Message = { role: "user", content: text }
        const next = [...messages, userMsg]
        setMessages(next)
        setInput("")
        setError(null)
        setStreaming(true)

        // Bubble assistant placeholder per lo streaming
        setMessages((m) => [...m, { role: "assistant", content: "" }])

        const ac = new AbortController()
        abortRef.current = ac

        try {
            const res = await fetch(
                `${backendUrl.replace(/\/$/, "")}/api/chat`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Accept: "text/event-stream",
                    },
                    body: JSON.stringify({
                        messages: next.slice(-MAX_HISTORY),
                    }),
                    signal: ac.signal,
                }
            )
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ""

            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })

                // Parse SSE events separati da \n\n
                const parts = buffer.split("\n\n")
                buffer = parts.pop() || ""

                for (const part of parts) {
                    const lines = part.split("\n")
                    const eventLine = lines.find((l) => l.startsWith("event:"))
                    const dataLine = lines.find((l) => l.startsWith("data:"))
                    if (!eventLine || !dataLine) continue
                    const event = eventLine.slice(6).trim()
                    let data: any = {}
                    try {
                        data = JSON.parse(dataLine.slice(5).trim())
                    } catch {}

                    if (event === "delta" && data.text) {
                        setMessages((m) => {
                            const copy = [...m]
                            const last = copy[copy.length - 1]
                            if (last && last.role === "assistant") {
                                copy[copy.length - 1] = {
                                    ...last,
                                    content: last.content + data.text,
                                }
                            }
                            return copy
                        })
                    } else if (event === "error") {
                        throw new Error(data.message || "Errore dal server")
                    }
                }
            }
        } catch (err: any) {
            if (err.name !== "AbortError") {
                setError(err.message || "Errore di rete")
                setMessages((m) => {
                    const copy = [...m]
                    const last = copy[copy.length - 1]
                    if (last && last.role === "assistant" && !last.content)
                        copy.pop()
                    return copy
                })
            }
        } finally {
            setStreaming(false)
            abortRef.current = null
        }
    }

    function reset() {
        abortRef.current?.abort()
        setMessages([])
        try {
            localStorage.removeItem(STORAGE_KEY)
        } catch {}
    }

    const cornerStyle: React.CSSProperties =
        position === "bottom-left" ? { left: 20 } : { right: 20 }

    return (
        <div
            style={{
                position: "fixed",
                bottom: 20,
                ...cornerStyle,
                zIndex: 9999,
                fontFamily:
                    "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
            }}
        >
            {/* Pannello chat */}
            {open && (
                <div
                    style={{
                        position: "absolute",
                        bottom: 76,
                        ...(position === "bottom-left"
                            ? { left: 0 }
                            : { right: 0 }),
                        width: "min(380px, calc(100vw - 40px))",
                        height: "min(560px, calc(100vh - 120px))",
                        background: "#fff",
                        borderRadius: 16,
                        boxShadow: "0 12px 48px rgba(0,0,0,0.18)",
                        display: "flex",
                        flexDirection: "column",
                        overflow: "hidden",
                        animation: "mdpFadeUp 0.18s ease-out",
                    }}
                >
                    {/* Header */}
                    <div
                        style={{
                            padding: "14px 16px",
                            background: brandColor,
                            color: accentColor,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                        }}
                    >
                        <div style={{ fontWeight: 600, fontSize: 15 }}>
                            {title}
                        </div>
                        <div style={{ display: "flex", gap: 12 }}>
                            <button
                                onClick={reset}
                                title="Nuova conversazione"
                                style={iconBtn(accentColor)}
                            >
                                ↻
                            </button>
                            <button
                                onClick={() => setOpen(false)}
                                title="Chiudi"
                                style={iconBtn(accentColor)}
                            >
                                ✕
                            </button>
                        </div>
                    </div>

                    {/* Messaggi */}
                    <div
                        ref={scrollRef}
                        style={{
                            flex: 1,
                            overflowY: "auto",
                            padding: 16,
                            display: "flex",
                            flexDirection: "column",
                            gap: 10,
                            background: "#fafafa",
                        }}
                    >
                        {messages.length === 0 && (
                            <Bubble
                                role="assistant"
                                content={welcomeMessage}
                                brandColor={brandColor}
                            />
                        )}
                        {messages.map((m, i) => (
                            <Bubble
                                key={i}
                                role={m.role}
                                content={m.content}
                                brandColor={brandColor}
                                pulsing={
                                    streaming &&
                                    i === messages.length - 1 &&
                                    m.role === "assistant" &&
                                    !m.content
                                }
                            />
                        ))}
                        {error && (
                            <div
                                style={{
                                    fontSize: 12,
                                    color: "#c00",
                                    padding: 8,
                                }}
                            >
                                ⚠ {error}
                            </div>
                        )}
                    </div>

                    {/* Input */}
                    <div
                        style={{
                            borderTop: "1px solid #eee",
                            padding: 10,
                            display: "flex",
                            gap: 8,
                            background: "#fff",
                        }}
                    >
                        <input
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault()
                                    send()
                                }
                            }}
                            placeholder={placeholder}
                            disabled={streaming}
                            style={{
                                flex: 1,
                                border: "1px solid #e0e0e0",
                                borderRadius: 10,
                                padding: "10px 12px",
                                fontSize: 14,
                                outline: "none",
                                fontFamily: "inherit",
                            }}
                        />
                        <button
                            onClick={send}
                            disabled={streaming || !input.trim()}
                            style={{
                                background: brandColor,
                                color: accentColor,
                                border: "none",
                                borderRadius: 10,
                                padding: "0 16px",
                                cursor: streaming ? "default" : "pointer",
                                opacity: !input.trim() || streaming ? 0.5 : 1,
                                fontWeight: 600,
                                fontSize: 14,
                            }}
                        >
                            ➤
                        </button>
                    </div>
                </div>
            )}

            {/* Teaser: bolla d'invito sopra il bottone */}
            {!open && teaserVisible && (
                <div
                    role="button"
                    onClick={() => {
                        setTeaserVisible(false)
                        setOpen(true)
                    }}
                    style={{
                        position: "absolute",
                        bottom: 72,
                        ...(position === "bottom-left"
                            ? { left: 4 }
                            : { right: 4 }),
                        maxWidth: 220,
                        background: "#fff",
                        color: "#222",
                        padding: "12px 14px",
                        borderRadius: 14,
                        boxShadow: "0 8px 28px rgba(0,0,0,0.16)",
                        fontSize: 14,
                        lineHeight: 1.4,
                        cursor: "pointer",
                        whiteSpace: "pre-wrap",
                        animation: "mdpFadeUp 0.2s ease-out",
                    }}
                >
                    {teaserMessage}
                    {/* Codina che punta al bottone */}
                    <div
                        style={{
                            position: "absolute",
                            bottom: -7,
                            ...(position === "bottom-left"
                                ? { left: 22 }
                                : { right: 22 }),
                            width: 14,
                            height: 14,
                            background: "#fff",
                            transform: "rotate(45deg)",
                            boxShadow: "3px 3px 6px rgba(0,0,0,0.06)",
                        }}
                    />
                </div>
            )}

            {/* Bottone flottante */}
            <button
                onClick={() => {
                    setTeaserVisible(false)
                    setOpen((o) => !o)
                }}
                aria-label={open ? "Chiudi chat" : "Apri chat"}
                style={{
                    width: 56,
                    height: 56,
                    borderRadius: 28,
                    border: "none",
                    background: brandColor,
                    color: accentColor,
                    cursor: "pointer",
                    boxShadow: "0 6px 20px rgba(0,0,0,0.2)",
                    fontSize: 24,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transition: "transform 0.15s ease",
                }}
                onMouseDown={(e) =>
                    (e.currentTarget.style.transform = "scale(0.94)")
                }
                onMouseUp={(e) =>
                    (e.currentTarget.style.transform = "scale(1)")
                }
                onMouseLeave={(e) =>
                    (e.currentTarget.style.transform = "scale(1)")
                }
            >
                {open ? "✕" : "💬"}
            </button>

            <style>{`
                @keyframes mdpFadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
                @keyframes mdpPulse { 0%,100% { opacity: 0.4 } 50% { opacity: 1 } }
            `}</style>
        </div>
    )
}

// Renderizza testo con link Markdown [testo](url) come <a> cliccabili.
function renderRichText(text: string): React.ReactNode[] {
    const linkRegex = /\[([^\]]+)\]\(([^)\s]+)\)/g
    const out: React.ReactNode[] = []
    let lastIndex = 0
    let match: RegExpExecArray | null
    let key = 0
    while ((match = linkRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            out.push(text.slice(lastIndex, match.index))
        }
        out.push(
            <a
                key={`l${key++}`}
                href={match[2]}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "inherit", textDecoration: "underline" }}
            >
                {match[1]}
            </a>
        )
        lastIndex = match.index + match[0].length
    }
    if (lastIndex < text.length) out.push(text.slice(lastIndex))
    return out
}

function Bubble({
    role,
    content,
    brandColor,
    pulsing,
}: {
    role: string
    content: string
    brandColor: string
    pulsing?: boolean
}) {
    const isUser = role === "user"
    return (
        <div
            style={{
                display: "flex",
                justifyContent: isUser ? "flex-end" : "flex-start",
            }}
        >
            <div
                style={{
                    maxWidth: "82%",
                    padding: "10px 14px",
                    borderRadius: 14,
                    background: isUser ? brandColor : "#fff",
                    color: isUser ? "#fff" : "#222",
                    fontSize: 14,
                    lineHeight: 1.45,
                    border: isUser ? "none" : "1px solid #eee",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                }}
            >
                {pulsing ? (
                    <span
                        style={{
                            animation: "mdpPulse 1.2s infinite",
                            color: "#888",
                        }}
                    >
                        ...
                    </span>
                ) : (
                    renderRichText(content)
                )}
            </div>
        </div>
    )
}

function iconBtn(color: string): React.CSSProperties {
    return {
        background: "transparent",
        border: "none",
        color,
        cursor: "pointer",
        fontSize: 16,
        padding: 0,
        lineHeight: 1,
        opacity: 0.85,
    }
}

addPropertyControls(Chatbot, {
    backendUrl: {
        type: ControlType.String,
        title: "Backend URL",
        defaultValue: "https://your-app.onrender.com",
    },
    title: {
        type: ControlType.String,
        title: "Title",
        defaultValue: "Milano da Piccoli",
    },
    welcomeMessage: {
        type: ControlType.String,
        title: "Welcome",
        defaultValue:
            "Ciao! Dimmi l'età del bimbo e ti trovo l'evento giusto 🎈",
        displayTextArea: true,
    },
    placeholder: {
        type: ControlType.String,
        title: "Placeholder",
        defaultValue: "Scrivi qui...",
    },
    showTeaser: {
        type: ControlType.Boolean,
        title: "Teaser",
        defaultValue: true,
        enabledTitle: "On",
        disabledTitle: "Off",
    },
    teaserMessage: {
        type: ControlType.String,
        title: "Teaser text",
        defaultValue: "Ciao! Posso aiutarti? 👋",
        displayTextArea: true,
        hidden: (props) => !props.showTeaser,
    },
    teaserDelay: {
        type: ControlType.Number,
        title: "Teaser delay",
        defaultValue: 1.5,
        min: 0,
        max: 20,
        step: 0.5,
        unit: "s",
        hidden: (props) => !props.showTeaser,
    },
    brandColor: {
        type: ControlType.Color,
        title: "Brand color",
        defaultValue: "#FF4F8E",
    },
    accentColor: {
        type: ControlType.Color,
        title: "Accent color",
        defaultValue: "#FFFFFF",
    },
    position: {
        type: ControlType.Enum,
        title: "Position",
        options: ["bottom-right", "bottom-left"],
        optionTitles: ["Bottom right", "Bottom left"],
        defaultValue: "bottom-right",
    },
})

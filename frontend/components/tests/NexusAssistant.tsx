"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { createPortal } from "react-dom"
import {
    X, Send, Loader2, CheckCircle2, RotateCcw,
    Zap, ChevronRight, Minimize2, Maximize2, Cpu
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"

// ─── Types ─────────────────────────────────────────────────────────────────

export type TestStep = {
    id: string
    action: string
    target: string
    value: string
    locator_type?: string
    [key: string]: unknown
}

type StepUpdate = {
    stepIndex: number
    updatedStep: TestStep
    deleted?: boolean   // true when NEXUS wants to remove this step
}

type ChatMessage = {
    role: "user" | "assistant"
    content: string
    stepUpdates?: StepUpdate[]
    applied?: boolean
    isWarning?: boolean
    suggestions?: string[]
}

interface NexusAssistantProps {
    testCaseId:   string
    testCaseName: string
    steps:        TestStep[]
    isDisabled:   boolean   // true when test hasn't been saved yet
    onStepsUpdated: (updates: StepUpdate[]) => void
}

// ─── Quick suggestion chips ─────────────────────────────────────────────────

const CHIPS = [
    { label: "Fix Save button",       prompt: "Fix the Save button step" },
    { label: "Add required field",    prompt: "Add a required field step" },
    { label: "Change value",          prompt: "Change the value in step " },
    { label: "Add wait",              prompt: "Add a 2 second wait after step " },
    { label: "Make negative test",    prompt: "Make step " },
    { label: "Explain step",          prompt: "Explain what step " },
]

// ─── Action badge ────────────────────────────────────────────────────────────

function ActionBadge({ action }: { action: string }) {
    const a = action.toUpperCase()
    const map: Record<string, string> = {
        NAVIGATE:     "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
        CLICK:        "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
        TYPE:         "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
        ASSERT_TEXT:  "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
        WAIT:         "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
        SELECT:       "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
        LOOKUP:       "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
    }
    return (
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold font-mono uppercase tracking-wide ${map[a] ?? "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"}`}>
            {a}
        </span>
    )
}

// ─── Step update preview card ────────────────────────────────────────────────

function StepUpdateCard({ update }: { update: StepUpdate }) {
    const s = update.updatedStep
    if (update.deleted) {
        return (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50/60 dark:bg-red-950/20 p-2 text-[11px] space-y-0.5">
                <p className="text-[9px] font-semibold uppercase tracking-widest text-red-500">Step {update.stepIndex + 1} → will be deleted</p>
                <p className="text-red-600 dark:text-red-400 text-[10px]">This step will be permanently removed</p>
            </div>
        )
    }
    return (
        <div className="rounded-lg border border-violet-200 dark:border-violet-800 bg-violet-50/60 dark:bg-violet-950/20 p-2 text-[11px] space-y-0.5">
            <p className="text-[9px] font-semibold uppercase tracking-widest text-violet-500">Step {update.stepIndex + 1} → proposed</p>
            <div className="flex items-center gap-1.5 flex-wrap">
                <ActionBadge action={s.action} />
                {s.target && <span className="text-gray-700 dark:text-gray-300 font-medium truncate max-w-[150px]" title={s.target}>{s.target}</span>}
                {s.value && <span className="text-gray-500 dark:text-gray-400 italic truncate max-w-[100px]" title={s.value}>= &quot;{s.value.length > 25 ? s.value.slice(0, 25) + "…" : s.value}&quot;</span>}
            </div>
        </div>
    )
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function NexusAssistant({
    testCaseId,
    testCaseName,
    steps,
    isDisabled,
    onStepsUpdated,
}: NexusAssistantProps) {

    const storageKey = `nexus-pos-${testCaseId}`

    // ── Position — initialised safely inside useEffect (SSR guard) ──────────
    const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })

    // ── Drag refs — use refs so event handlers are always current ───────────
    const isDragging    = useRef(false)
    const didDrag       = useRef(false)   // true when threshold exceeded → suppress click
    const pointerStart  = useRef({ x: 0, y: 0 })
    const posStart      = useRef({ x: 0, y: 0 })
    const iconWrapRef   = useRef<HTMLDivElement>(null)

    // ── Panel state ──────────────────────────────────────────────────────────
    const [open, setOpen]               = useState(false)
    const [closing, setClosing]         = useState(false)
    const [expanded, setExpanded]       = useState(false)
    const [messages, setMessages]       = useState<ChatMessage[]>([])
    const [input, setInput]             = useState("")
    const [isSending, setIsSending]     = useState(false)
    const [pendingUpdates, setPending]  = useState<StepUpdate[] | null>(null)
    const [isApplying, setIsApplying]   = useState(false)
    const [appliedCount, setApplied]    = useState(0)
    const [mounted, setMounted]         = useState(false)

    const inputRef  = useRef<HTMLInputElement>(null)
    const bottomRef = useRef<HTMLDivElement>(null)

    // Mount: read saved position (SSR-safe)
    useEffect(() => {
        const rightEdge = window.innerWidth - 88
        const defaultY  = window.innerHeight - 110
        const saved = localStorage.getItem(storageKey)
        if (saved) {
            try {
                const p = JSON.parse(saved) as { x: number; y: number }
                // Clamp: ensure the saved position is within viewport bounds
                const safePosX = Math.max(0, Math.min(window.innerWidth - 64, p.x))
                const safePosY = Math.max(0, Math.min(window.innerHeight - 64, p.y))
                setPos({ x: safePosX, y: safePosY })
                setMounted(true)
                return
            } catch { /* fallback to default */ }
        }
        // Default: right corner down of the page as default to display in UI
        setPos({ x: rightEdge, y: defaultY })
        setMounted(true)
    }, [storageKey])

    useEffect(() => { setMounted(true) }, [])

    useEffect(() => {
        if (open) setTimeout(() => inputRef.current?.focus(), 100)
    }, [open])

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" })
    }, [messages])

    // ── Pointer-based drag (works for mouse and touch) ───────────────────────
    const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        // Only drag on primary button (left-click / single touch)
        if (e.button !== 0 && e.pointerType === "mouse") return
        isDragging.current = true
        didDrag.current    = false
        pointerStart.current = { x: e.clientX, y: e.clientY }
        posStart.current     = { x: pos.x, y: pos.y }
        // Capture so we receive events even if pointer leaves the element
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        e.preventDefault()
    }, [pos])

    const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!isDragging.current) return
        const dx = e.clientX - pointerStart.current.x
        const dy = e.clientY - pointerStart.current.y
        // 4 px threshold — below this it's a click not a drag
        if (!didDrag.current && Math.abs(dx) < 4 && Math.abs(dy) < 4) return
        didDrag.current = true
        const nx = Math.max(0, Math.min(window.innerWidth  - 64, posStart.current.x + dx))
        const ny = Math.max(0, Math.min(window.innerHeight - 64, posStart.current.y + dy))
        setPos({ x: nx, y: ny })
    }, [])

    const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!isDragging.current) return
        isDragging.current = false
        ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
        if (didDrag.current) {
            // Save final position
            setPos(p => { localStorage.setItem(storageKey, JSON.stringify(p)); return p })
        }
    }, [storageKey])

    // Click fires ONLY if no drag occurred
    const handleIconClick = useCallback(() => {
        if (didDrag.current) return   // suppress after drag
        if (!isDisabled) setOpen(true)
    }, [isDisabled])

    // ── Open / close ─────────────────────────────────────────────────────────
    const closePanel = () => {
        setClosing(true)
        setTimeout(() => { setOpen(false); setClosing(false) }, 250)
    }


    // ── Send message ─────────────────────────────────────────────────────────
    const getChatHistory = useCallback(() =>
        messages.map(m => ({ role: m.role, content: m.content }))
    , [messages])

    const handleSend = async (text?: string) => {
        const msg = (text ?? input).trim()
        if (!msg || isSending) return
        setInput("")
        setIsSending(true)
        setPending(null)
        const userMsg: ChatMessage = { role: "user", content: msg }
        setMessages(prev => [...prev, userMsg])

        try {
            const res = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"}/api/v1/tests/${testCaseId}/nexus/chat`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ instruction: msg, chat_history: getChatHistory() }),
                }
            )
            if (!res.ok) {
                const err = await res.json().catch(() => ({ detail: "Request failed" }))
                throw new Error(err.detail || "Request failed")
            }
            const data = await res.json()
            const assistantMsg: ChatMessage = {
                role: "assistant",
                content: data.reply || "Done.",
                stepUpdates: data.stepUpdates?.length ? data.stepUpdates : undefined,
                applied: false,
                isWarning: data.isWarning === true,
                suggestions: Array.isArray(data.suggestions) ? data.suggestions : undefined,
            }
            setMessages(prev => [...prev, assistantMsg])
            // Do NOT set pending when it's a warning — no changes to apply
            if (data.stepUpdates?.length && !data.isWarning) setPending(data.stepUpdates)
        } catch (err: any) {
            setMessages(prev => [...prev, { role: "assistant", content: `Sorry, something went wrong: ${err.message}` }])
        } finally {
            setIsSending(false)
        }
    }

    // ── Apply pending updates ────────────────────────────────────────────────
    const handleApply = async () => {
        if (!pendingUpdates) return
        setIsApplying(true)
        try {
            const res = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"}/api/v1/tests/${testCaseId}/nexus/apply`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ stepUpdates: pendingUpdates }),
                }
            )
            if (!res.ok) {
                const err = await res.json().catch(() => ({ detail: "Failed to save" }))
                throw new Error(err.detail || "Failed to save")
            }
            onStepsUpdated(pendingUpdates)
            setApplied(c => c + 1)
            const labels = pendingUpdates.map(u => `Step ${u.stepIndex + 1}`).join(", ")
            setMessages(prev => [...prev, { role: "assistant", content: `✅ ${labels} updated successfully!`, applied: true }])
            setPending(null)
            toast.success(`Updated ${pendingUpdates.length} step(s) successfully`)
        } catch (err: any) {
            toast.error("Failed to apply changes: " + err.message)
        } finally {
            setIsApplying(false)
        }
    }

    const handleDiscard = () => {
        setPending(null)
        setMessages(prev => [...prev, { role: "assistant", content: "Change discarded. What else would you like to do?" }])
    }

    // ────────────────────────────────────────────────────────────────────────
    if (!mounted) return null

    const panelWidth = expanded ? 480 : 420

    const ui = (
        <>
            {/* ── Floating NEXUS Icon ─────────────────────────────────────── */}
            {(!open || closing) && (
                <div
                    ref={iconWrapRef}
                    style={{
                        position: "fixed",
                        left: pos.x,
                        top: pos.y,
                        zIndex: 9990,
                        userSelect: "none",
                        touchAction: "none",
                        cursor: "grab",
                    }}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                    onClick={handleIconClick}
                >
                    {/* Expanding ring */}
                    <div className="absolute inset-0 rounded-full nexus-ring"
                        style={{ background: "radial-gradient(circle, rgba(139,92,246,0.3) 0%, transparent 70%)" }} />

                    <button
                        title={isDisabled ? "Save test first to use NEXUS" : "Open NEXUS AI Assistant"}
                        style={{
                            background: "linear-gradient(135deg, #7c3aed 0%, #4f46e5 50%, #0ea5e9 100%)",
                            cursor: "inherit",
                            pointerEvents: "none",
                        }}
                        className={`relative w-14 h-14 rounded-full flex items-center justify-center nexus-pulse ${isDisabled ? "opacity-50" : ""}`}
                        tabIndex={-1}
                        aria-hidden="true"
                    >
                        {/* Inner glow */}
                        <div className="absolute inset-1 rounded-full opacity-30"
                            style={{ background: "radial-gradient(circle at 40% 35%, rgba(255,255,255,0.6), transparent 60%)" }} />

                        {/* Orbit dot */}
                        <div className="absolute w-2.5 h-2.5 rounded-full nexus-orbit"
                            style={{ background: "linear-gradient(135deg, #e879f9, #a78bfa)", boxShadow: "0 0 6px rgba(232,121,249,0.8)" }} />

                        <div className="relative flex flex-col items-center justify-center">
                            <Cpu className="h-5 w-5 text-white drop-shadow" />
                        </div>
                    </button>

                    {/* Label */}
                    <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap pointer-events-none">
                        <span className="text-[9px] font-bold tracking-widest text-violet-500 dark:text-violet-400 uppercase opacity-80">
                            NEXUS
                        </span>
                    </div>
                </div>
            )}


            {/* ── Chat Panel ─────────────────────────────────────────────── */}
            {open && (
                <>
                    {/* Subtle backdrop */}
                    <div
                        className="fixed inset-0 z-[9991] bg-black/10 dark:bg-black/30"
                        onClick={closePanel}
                    />

                    {/* Panel — right-center widget, vertically centred in viewport */}
                    <div
                        className={`fixed z-[9992] flex flex-col bg-white dark:bg-gray-950 rounded-2xl overflow-hidden shadow-2xl border border-gray-200 dark:border-gray-800 ${closing ? "nexus-slide-out" : "nexus-slide-in"}`}
                        style={{
                            width: panelWidth,
                            maxWidth: "calc(100vw - 24px)",
                            height: "52vh",
                            minHeight: 380,
                            maxHeight: 560,
                            top: "50%",
                            transform: "translateY(-50%)",
                            right: 24,
                        }}
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800 flex-shrink-0"
                            style={{ background: "linear-gradient(135deg, #4c1d95 0%, #1e1b4b 60%, #0c1a2e 100%)" }}>
                            <div className="flex items-center gap-3 min-w-0">
                                {/* Mini NEXUS icon */}
                                <div className="relative w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
                                    style={{ background: "linear-gradient(135deg, #7c3aed, #4f46e5)" }}>
                                    <div className="absolute inset-0.5 rounded-full nexus-ring opacity-50" />
                                    <Cpu className="h-4 w-4 text-white relative z-10" />
                                </div>
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-black tracking-[0.2em] text-white uppercase">NEXUS</span>
                                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-500/30 text-violet-200 font-semibold border border-violet-500/40">AI</span>
                                        {appliedCount > 0 && (
                                            <Badge className="text-[8px] px-1 h-3.5 bg-green-500/20 text-green-300 border border-green-500/30 hover:bg-green-500/20">
                                                {appliedCount} saved
                                            </Badge>
                                        )}
                                    </div>
                                    <p className="text-[10px] text-violet-300 truncate mt-0.5">{testCaseName}</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-0.5 flex-shrink-0">
                                <button
                                    onClick={() => setExpanded(e => !e)}
                                    className="p-1.5 rounded-md text-violet-300 hover:text-white hover:bg-white/10 transition-colors"
                                    title={expanded ? "Compact" : "Expand"}
                                >
                                    {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                                </button>
                                <button
                                    onClick={closePanel}
                                    className="p-1.5 rounded-md text-violet-300 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                                    id="nexus-close"
                                >
                                    <X className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        </div>

                        {/* Steps context pill */}
                        <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-800 bg-violet-50/50 dark:bg-violet-950/10 flex-shrink-0">
                            <p className="text-[10px] text-violet-600 dark:text-violet-400">
                                <span className="font-semibold">{steps.length} steps</span> in scope — ask me to modify any step by number
                            </p>
                        </div>

                        {/* Messages */}
                        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 min-h-0">
                            {/* Welcome */}
                            {messages.length === 0 && (
                                <div className="space-y-3">
                                    <div className="flex gap-2">
                                        <div className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center mt-0.5"
                                            style={{ background: "linear-gradient(135deg, #7c3aed, #4f46e5)" }}>
                                            <Cpu className="h-3 w-3 text-white" />
                                        </div>
                                        <div className="max-w-[88%] px-3 py-2.5 rounded-xl rounded-tl-none text-[11px] leading-relaxed border"
                                            style={{ background: "linear-gradient(135deg, #f5f3ff, #ede9fe)", borderColor: "#c4b5fd" }}>
                                            <p className="font-semibold text-violet-800 mb-1">👋 Hi! I&apos;m NEXUS.</p>
                                            <p className="text-violet-700">I can read, edit, and explain any step in <strong>{testCaseName}</strong>. Try something like:</p>
                                            <ul className="mt-1.5 space-y-0.5 text-violet-600 list-none">
                                                <li>→ &ldquo;Update step 3 to click the Save button&rdquo;</li>
                                                <li>→ &ldquo;Make step 4 a negative test&rdquo;</li>
                                                <li>→ &ldquo;Explain step 2&rdquo;</li>
                                            </ul>
                                        </div>
                                    </div>
                                    {/* Chips */}
                                    <div className="flex flex-wrap gap-1.5 pl-8">
                                        {CHIPS.map(c => (
                                            <button key={c.label}
                                                onClick={() => { setInput(c.prompt); inputRef.current?.focus() }}
                                                className="inline-flex items-center gap-0.5 px-2 py-1 rounded-full text-[10px] font-medium border border-violet-200 dark:border-violet-800 text-violet-600 dark:text-violet-300 bg-violet-50 dark:bg-violet-950/20 hover:bg-violet-100 dark:hover:bg-violet-900/30 transition-colors"
                                            >
                                                <ChevronRight className="h-2.5 w-2.5" />
                                                {c.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Message list */}
                            {messages.map((msg, idx) => (
                                <div key={idx}>
                                    {msg.role === "user" ? (
                                        <div className="flex justify-end">
                                            <div className="max-w-[85%] px-3 py-2 rounded-xl rounded-tr-none text-[11px] leading-relaxed text-white"
                                                style={{ background: "linear-gradient(135deg, #7c3aed, #4f46e5)" }}>
                                                {msg.content}
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="flex gap-2">
                                            <div className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center mt-0.5"
                                                style={{ background: msg.isWarning ? "linear-gradient(135deg, #b45309, #d97706)" : "linear-gradient(135deg, #7c3aed, #4f46e5)" }}>
                                                <Cpu className="h-3 w-3 text-white" />
                                            </div>
                                            <div className="flex-1 space-y-1.5 min-w-0">
                                                {msg.isWarning ? (
                                                    /* ── Warning / blocked request card ── */
                                                    <div className="max-w-[96%] rounded-xl rounded-tl-none border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 overflow-hidden">
                                                        {/* Warning header */}
                                                        <div className="px-3 py-2 border-b border-amber-200 dark:border-amber-800"
                                                            style={{ background: "linear-gradient(135deg, #78350f22, #92400e11)" }}>
                                                            <p className="text-[11px] font-semibold text-amber-800 dark:text-amber-300 leading-relaxed">
                                                                {msg.content}
                                                            </p>
                                                        </div>
                                                        {/* Suggestions */}
                                                        {msg.suggestions && msg.suggestions.length > 0 && (
                                                            <div className="px-3 py-2 space-y-1.5">
                                                                <p className="text-[9px] font-bold uppercase tracking-widest text-amber-700 dark:text-amber-400">Suggested Alternatives</p>
                                                                {msg.suggestions.map((s, si) => (
                                                                    <button
                                                                        key={si}
                                                                        onClick={() => { setInput(s); inputRef.current?.focus() }}
                                                                        className="w-full text-left flex items-start gap-1.5 group hover:bg-amber-100 dark:hover:bg-amber-900/30 rounded-lg px-2 py-1.5 transition-colors"
                                                                    >
                                                                        <span className="flex-shrink-0 w-4 h-4 rounded-full bg-amber-200 dark:bg-amber-800 text-amber-700 dark:text-amber-300 text-[9px] font-bold flex items-center justify-center mt-0.5">
                                                                            {si + 1}
                                                                        </span>
                                                                        <span className="text-[10px] text-amber-700 dark:text-amber-300 leading-snug group-hover:text-amber-900 dark:group-hover:text-amber-100">
                                                                            {s}
                                                                        </span>
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                ) : (
                                                    /* ── Normal assistant message ── */
                                                    <div className={`max-w-[92%] px-3 py-2 rounded-xl rounded-tl-none text-[11px] leading-relaxed ${
                                                        msg.applied
                                                            ? "bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 text-green-800 dark:text-green-200"
                                                            : "bg-gray-50 dark:bg-gray-900 border border-gray-100 dark:border-gray-800 text-gray-700 dark:text-gray-300"
                                                    }`}>
                                                        {msg.content}
                                                    </div>
                                                )}
                                                {msg.stepUpdates && !msg.applied && !msg.isWarning && (
                                                    <div className="space-y-1 max-w-[92%]">
                                                        {msg.stepUpdates.map((u, i) => (
                                                            <StepUpdateCard key={i} update={u} />
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ))}

                            {/* Typing indicator */}
                            {isSending && (
                                <div className="flex gap-2">
                                    <div className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center"
                                        style={{ background: "linear-gradient(135deg, #7c3aed, #4f46e5)" }}>
                                        <Cpu className="h-3 w-3 text-white" />
                                    </div>
                                    <div className="px-3 py-2.5 rounded-xl rounded-tl-none bg-gray-50 dark:bg-gray-900 border border-gray-100 dark:border-gray-800 flex items-center gap-1.5">
                                        <span className="w-1.5 h-1.5 rounded-full bg-violet-400 nexus-dot-1" />
                                        <span className="w-1.5 h-1.5 rounded-full bg-violet-400 nexus-dot-2" />
                                        <span className="w-1.5 h-1.5 rounded-full bg-violet-400 nexus-dot-3" />
                                    </div>
                                </div>
                            )}
                            <div ref={bottomRef} />
                        </div>

                        {/* Apply / discard bar */}
                        {pendingUpdates && (
                            <div className="flex-shrink-0 px-3 py-2.5 border-t border-violet-100 dark:border-violet-900/30 bg-violet-50 dark:bg-violet-950/20">
                                <div className="flex items-center gap-1.5 mb-2">
                                    <Zap className="h-3.5 w-3.5 text-violet-600" />
                                    <p className="text-[11px] font-semibold text-violet-700 dark:text-violet-300">
                                        Apply {pendingUpdates.length} change{pendingUpdates.length > 1 ? "s" : ""}?
                                    </p>
                                </div>
                                <div className="flex gap-1.5">
                                    <Button
                                        size="sm"
                                        className="flex-1 h-7 text-[11px] gap-1 font-semibold rounded-lg"
                                        style={{ background: "linear-gradient(135deg, #7c3aed, #4f46e5)" }}
                                        onClick={handleApply}
                                        disabled={isApplying}
                                        id="nexus-apply-btn"
                                    >
                                        {isApplying ? <><Loader2 className="h-3 w-3 animate-spin" /> Saving…</> : <><CheckCircle2 className="h-3 w-3" /> Apply</>}
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 text-[11px] gap-0.5 rounded-lg"
                                        onClick={handleDiscard}
                                        disabled={isApplying}
                                    >
                                        <RotateCcw className="h-2.5 w-2.5" /> Discard
                                    </Button>
                                </div>
                            </div>
                        )}

                        {/* Input */}
                        <div className="flex-shrink-0 px-3 py-2.5 border-t border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-black/10">
                            <div className="flex gap-1.5 items-center">
                                <input
                                    ref={inputRef}
                                    id="nexus-chat-input"
                                    value={input}
                                    onChange={e => setInput(e.target.value)}
                                    onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend() } }}
                                    disabled={isSending}
                                    placeholder='e.g. "Change step 3 value to Acme Corp"'
                                    className="flex-1 px-3 py-2 rounded-lg text-xs border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-violet-400 focus:border-transparent placeholder-gray-400 dark:placeholder-gray-600"
                                />
                                <Button
                                    size="icon"
                                    className="h-8 w-8 flex-shrink-0 rounded-lg"
                                    style={{ background: "linear-gradient(135deg, #7c3aed, #4f46e5)" }}
                                    onClick={() => handleSend()}
                                    disabled={!input.trim() || isSending}
                                    id="nexus-send-btn"
                                >
                                    {isSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                                </Button>
                            </div>
                            <p className="text-[9px] text-gray-400 dark:text-gray-600 text-center mt-1.5">NEXUS · AutoTest AI</p>
                        </div>
                    </div>
                </>
            )}
        </>
    )

    return createPortal(ui, document.body)
}

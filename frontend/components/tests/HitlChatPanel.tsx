/**
 * HitlChatPanel — AI-powered Human-in-the-Loop chatbot panel.
 *
 * Opens automatically when a test step pauses (executionStatus === 'paused').
 * Styled consistently with NexusAssistant but uses amber accents to clearly
 * signal the "test paused" state.
 *
 * Design (Option A confirmed):
 *   AI gives advice → human acts manually in browser → clicks Resume.
 *   No automatic step patching from within HITL.
 */
"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { createPortal } from "react-dom"
import {
    X, Send, Loader2, CheckCircle, SkipForward,
    Square, Cpu, AlertTriangle, Lightbulb, RotateCcw,
    ChevronRight, MessageSquare,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

// ─── Types ────────────────────────────────────────────────────────────────────

type SuggestionType = "advice" | "valid" | "clarify" | "invalid"

type HitlMessage = {
    role:             "user" | "assistant"
    content:          string
    suggestion_type?: SuggestionType
    suggested_action?: string
    quick_replies?:   string[]
}

interface HitlChatPanelProps {
    runId:        string
    testCaseId:   string
    pausedStep:   number | null   // 1-based
    errorMessage: string | null
    onResume:     () => Promise<void>
    onSkip:       () => Promise<void>
    onStop:       () => Promise<void>
    isActioning:  boolean
}

// ─── Quick action chips ────────────────────────────────────────────────────────

const DEFAULT_CHIPS = [
    "Element not visible on page",
    "Data already exists",
    "Page didn't load correctly",
    "Try different field value",
]

// ─── Suggestion type styles ────────────────────────────────────────────────────

function getSuggestionStyle(type?: SuggestionType) {
    switch (type) {
        case "valid":   return "border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30"
        case "invalid": return "border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/30"
        case "clarify": return "border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30"
        default:        return "border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20"
    }
}

function getSuggestionIcon(type?: SuggestionType) {
    switch (type) {
        case "valid":   return <CheckCircle className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />
        case "invalid": return <AlertTriangle className="h-3.5 w-3.5 text-red-500 flex-shrink-0" />
        case "clarify": return <MessageSquare className="h-3.5 w-3.5 text-blue-500 flex-shrink-0" />
        default:        return <Lightbulb className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" />
    }
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function HitlChatPanel({
    runId,
    testCaseId,
    pausedStep,
    errorMessage,
    onResume,
    onSkip,
    onStop,
    isActioning,
}: HitlChatPanelProps) {
    const [messages, setMessages]       = useState<HitlMessage[]>([])
    const [input, setInput]             = useState("")
    const [isSending, setIsSending]     = useState(false)
    const [isAnalyzing, setIsAnalyzing] = useState(false)
    const [closing, setClosing]         = useState(false)
    const [mounted, setMounted]         = useState(false)

    const inputRef  = useRef<HTMLInputElement>(null)
    const bottomRef = useRef<HTMLDivElement>(null)

    const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"

    // ── Mount guard (SSR-safe) ───────────────────────────────────────────────
    useEffect(() => { setMounted(true) }, [])

    // ── Auto-scroll ──────────────────────────────────────────────────────────
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" })
    }, [messages])

    // ── Auto-focus input ─────────────────────────────────────────────────────
    useEffect(() => {
        if (mounted) setTimeout(() => inputRef.current?.focus(), 200)
    }, [mounted])

    // ── Auto-trigger initial AI analysis when panel mounts ───────────────────
    useEffect(() => {
        if (!mounted || !runId || !testCaseId) return
        runInitialAnalysis()
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mounted, runId, testCaseId])

    const runInitialAnalysis = useCallback(async () => {
        setIsAnalyzing(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/test-runs/${runId}/hitl/analyze`, {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({
                    test_case_id:  testCaseId,
                    paused_step:   pausedStep,
                    error_message: errorMessage,
                }),
            })
            if (!res.ok) throw new Error("Analysis failed")
            const data = await res.json()
            setMessages([{
                role:             "assistant",
                content:          data.reply || "I'm analysing the failure...",
                suggestion_type:  data.suggestion_type,
                suggested_action: data.suggested_action,
                quick_replies:    data.quick_replies,
            }])
        } catch {
            setMessages([{
                role:    "assistant",
                content: "I couldn't fetch an automatic analysis right now. Please describe what you see and I'll help.",
                quick_replies: DEFAULT_CHIPS,
            }])
        } finally {
            setIsAnalyzing(false)
        }
    }, [API_BASE, runId, testCaseId, pausedStep, errorMessage])

    // ── Chat send ────────────────────────────────────────────────────────────
    const getChatHistory = useCallback(() =>
        messages.map(m => ({ role: m.role, content: m.content }))
    , [messages])

    const handleSend = async (text?: string) => {
        const msg = (text ?? input).trim()
        if (!msg || isSending) return
        setInput("")
        setIsSending(true)

        const userMsg: HitlMessage = { role: "user", content: msg }
        setMessages(prev => [...prev, userMsg])

        try {
            const res = await fetch(`${API_BASE}/api/v1/test-runs/${runId}/hitl/chat`, {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({
                    test_case_id:  testCaseId,
                    paused_step:   pausedStep,
                    error_message: errorMessage,
                    instruction:   msg,
                    chat_history:  getChatHistory(),
                }),
            })
            if (!res.ok) throw new Error("Chat request failed")
            const data = await res.json()
            setMessages(prev => [...prev, {
                role:             "assistant",
                content:          data.reply || "Let me know what you see.",
                suggestion_type:  data.suggestion_type,
                suggested_action: data.suggested_action,
                quick_replies:    data.quick_replies,
            }])
        } catch {
            setMessages(prev => [...prev, {
                role:    "assistant",
                content: "Sorry, I couldn't process that. Please try again or use the Resume/Skip buttons below.",
            }])
        } finally {
            setIsSending(false)
        }
    }

    // ── Action handlers (with closing animation) ─────────────────────────────
    const handleResume = async () => {
        setClosing(true)
        await onResume()
    }
    const handleSkip = async () => {
        setClosing(true)
        await onSkip()
    }
    const handleStop = async () => {
        setClosing(true)
        await onStop()
    }

    if (!mounted) return null

    // ─── Render ───────────────────────────────────────────────────────────────
    const panel = (
        <>
            {/* Subtle backdrop */}
            <div className="fixed inset-0 z-[9991] bg-black/15 dark:bg-black/40 pointer-events-none" />

            {/* Panel */}
            <div
                className={`fixed z-[9992] flex flex-col bg-white dark:bg-gray-950 rounded-2xl overflow-hidden shadow-2xl border border-amber-200 dark:border-amber-800/60 ${closing ? "nexus-slide-out" : "nexus-slide-in"}`}
                style={{
                    width:     440,
                    maxWidth:  "calc(100vw - 24px)",
                    height:    "60vh",
                    minHeight: 440,
                    maxHeight: 640,
                    top:       "50%",
                    transform: "translateY(-50%)",
                    right:     24,
                }}
            >
                {/* ── Header ───────────────────────────────────────────────── */}
                <div
                    className="flex items-center justify-between px-4 py-3 border-b border-amber-900/30 flex-shrink-0"
                    style={{ background: "linear-gradient(135deg, #78350f 0%, #451a03 55%, #0c1a2e 100%)" }}
                >
                    <div className="flex items-center gap-3 min-w-0">
                        {/* NEXUS icon — amber tint */}
                        <div
                            className="relative w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
                            style={{ background: "linear-gradient(135deg, #d97706, #b45309)" }}
                        >
                            <div className="absolute inset-0.5 rounded-full opacity-40"
                                style={{ background: "radial-gradient(circle at 40% 35%, rgba(255,255,255,0.5), transparent 60%)" }} />
                            <Cpu className="h-4 w-4 text-white relative z-10" />
                        </div>
                        <div className="min-w-0">
                            <div className="flex items-center gap-2">
                                <span className="text-xs font-black tracking-[0.2em] text-white uppercase">NEXUS</span>
                                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/30 text-amber-200 font-semibold border border-amber-500/40">
                                    HITL
                                </span>
                                {/* Pulsing amber dot */}
                                <span className="relative flex h-2 w-2">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                                    <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-400" />
                                </span>
                            </div>
                            <p className="text-[10px] text-amber-300 mt-0.5 font-medium truncate">
                                Test Paused — Step {pausedStep ?? "?"} needs action
                            </p>
                        </div>
                    </div>

                    {/* Retry analysis button */}
                    <button
                        onClick={runInitialAnalysis}
                        disabled={isAnalyzing || isSending}
                        className="p-1.5 rounded-md text-amber-300 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0"
                        title="Re-analyse error"
                    >
                        <RotateCcw className={`h-3.5 w-3.5 ${isAnalyzing ? "animate-spin" : ""}`} />
                    </button>
                </div>

                {/* ── Error context pill ────────────────────────────────────── */}
                {errorMessage && (
                    <div className="px-3 py-2 border-b border-amber-100 dark:border-amber-900/40 bg-amber-50/70 dark:bg-amber-950/20 flex-shrink-0">
                        <div className="flex items-start gap-1.5">
                            <AlertTriangle className="h-3 w-3 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                            <p className="text-[10px] text-amber-700 dark:text-amber-300 leading-relaxed break-words">
                                <span className="font-semibold">Error: </span>
                                {errorMessage.length > 140
                                    ? errorMessage.slice(0, 140) + "…"
                                    : errorMessage}
                            </p>
                        </div>
                    </div>
                )}

                {/* ── Messages ─────────────────────────────────────────────── */}
                <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 min-h-0">

                    {/* Analyzing spinner */}
                    {isAnalyzing && messages.length === 0 && (
                        <div className="flex gap-2">
                            <div className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center mt-0.5"
                                style={{ background: "linear-gradient(135deg, #d97706, #b45309)" }}>
                                <Cpu className="h-3 w-3 text-white" />
                            </div>
                            <div className="px-3 py-2.5 rounded-xl rounded-tl-none bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 flex items-center gap-2">
                                <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-600 dark:text-amber-400" />
                                <span className="text-[11px] text-amber-700 dark:text-amber-300">Analysing the error…</span>
                            </div>
                        </div>
                    )}

                    {/* Message list */}
                    {messages.map((msg, idx) => (
                        <div key={idx}>
                            {msg.role === "user" ? (
                                /* User bubble */
                                <div className="flex justify-end">
                                    <div
                                        className="max-w-[85%] px-3 py-2 rounded-xl rounded-tr-none text-[11px] leading-relaxed text-white"
                                        style={{ background: "linear-gradient(135deg, #d97706, #b45309)" }}
                                    >
                                        {msg.content}
                                    </div>
                                </div>
                            ) : (
                                /* Assistant bubble */
                                <div className="flex gap-2">
                                    <div
                                        className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center mt-0.5"
                                        style={{ background: "linear-gradient(135deg, #d97706, #b45309)" }}
                                    >
                                        <Cpu className="h-3 w-3 text-white" />
                                    </div>
                                    <div className="flex-1 space-y-1.5 min-w-0">
                                        {/* Main reply */}
                                        <div className={`max-w-[96%] rounded-xl rounded-tl-none border text-[11px] leading-relaxed overflow-hidden ${getSuggestionStyle(msg.suggestion_type)}`}>
                                            <div className="px-3 py-2.5">
                                                <p className="text-gray-700 dark:text-gray-200 whitespace-pre-wrap">
                                                    {msg.content}
                                                </p>
                                            </div>

                                            {/* Suggested action box */}
                                            {msg.suggested_action && (
                                                <div className="px-3 py-2 border-t border-current/10 bg-white/40 dark:bg-black/20">
                                                    <div className="flex items-start gap-1.5">
                                                        {getSuggestionIcon(msg.suggestion_type)}
                                                        <p className="text-[11px] font-semibold text-gray-800 dark:text-gray-100 leading-snug">
                                                            {msg.suggested_action}
                                                        </p>
                                                    </div>
                                                </div>
                                            )}
                                        </div>

                                        {/* Quick-reply chips */}
                                        {msg.quick_replies && msg.quick_replies.length > 0 && (
                                            <div className="flex flex-wrap gap-1.5 pl-0">
                                                {msg.quick_replies.map((chip, ci) => (
                                                    <button
                                                        key={ci}
                                                        onClick={() => handleSend(chip)}
                                                        disabled={isSending}
                                                        className="inline-flex items-center gap-0.5 px-2 py-1 rounded-full text-[10px] font-medium border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/20 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors disabled:opacity-50"
                                                    >
                                                        <ChevronRight className="h-2.5 w-2.5" />
                                                        {chip}
                                                    </button>
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
                                style={{ background: "linear-gradient(135deg, #d97706, #b45309)" }}>
                                <Cpu className="h-3 w-3 text-white" />
                            </div>
                            <div className="px-3 py-2.5 rounded-xl rounded-tl-none bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 flex items-center gap-1.5">
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 nexus-dot-1" />
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 nexus-dot-2" />
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 nexus-dot-3" />
                            </div>
                        </div>
                    )}

                    <div ref={bottomRef} />
                </div>

                {/* ── Input area ────────────────────────────────────────────── */}
                <div className="flex-shrink-0 px-3 py-2.5 border-t border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-black/10">
                    <div className="flex gap-1.5 items-center mb-2">
                        <input
                            ref={inputRef}
                            id="hitl-chat-input"
                            value={input}
                            onChange={e => setInput(e.target.value)}
                            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend() } }}
                            disabled={isSending || isAnalyzing}
                            placeholder='Describe your fix, e.g. "Try a different email address"'
                            className="flex-1 px-3 py-2 rounded-lg text-xs border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent placeholder-gray-400 dark:placeholder-gray-600"
                        />
                        <Button
                            size="icon"
                            className="h-8 w-8 flex-shrink-0 rounded-lg"
                            style={{ background: "linear-gradient(135deg, #d97706, #b45309)" }}
                            onClick={() => handleSend()}
                            disabled={!input.trim() || isSending || isAnalyzing}
                            id="hitl-send-btn"
                        >
                            {isSending
                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                : <Send className="h-3.5 w-3.5" />}
                        </Button>
                    </div>

                    {/* ── HITL Action buttons ─────────────────────────────────── */}
                    <div className="grid grid-cols-3 gap-1.5">
                        <Button
                            id="hitl-resume-btn"
                            size="sm"
                            className="h-8 text-[11px] font-semibold gap-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white"
                            onClick={handleResume}
                            disabled={isActioning}
                        >
                            {isActioning
                                ? <Loader2 className="h-3 w-3 animate-spin" />
                                : <CheckCircle className="h-3 w-3" />}
                            Resume
                        </Button>
                        <Button
                            id="hitl-skip-btn"
                            size="sm"
                            variant="outline"
                            className="h-8 text-[11px] gap-1 rounded-lg border-amber-400 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30"
                            onClick={handleSkip}
                            disabled={isActioning}
                        >
                            <SkipForward className="h-3 w-3" /> Skip Step
                        </Button>
                        <Button
                            id="hitl-stop-btn"
                            size="sm"
                            variant="outline"
                            className="h-8 text-[11px] gap-1 rounded-lg border-red-400 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                            onClick={handleStop}
                            disabled={isActioning}
                        >
                            <Square className="h-3 w-3 fill-current" /> Stop
                        </Button>
                    </div>

                    <p className="text-[9px] text-gray-400 dark:text-gray-600 text-center mt-1.5">
                        NEXUS HITL · Complete your action in the browser, then click Resume
                    </p>
                </div>
            </div>
        </>
    )

    return createPortal(panel, document.body)
}

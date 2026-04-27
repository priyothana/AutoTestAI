"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { createPortal } from "react-dom"
import {
    Bot, Send, Loader2, X, Sparkles, CheckCircle2,
    ChevronRight, Zap, RotateCcw, Minimize2, Maximize2
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"

// ─── Types ───────────────────────────────────────────────────────────────────

export type TestStep = {
    id: string
    action: string
    target: string
    value: string
    locator_type?: string
    sf_field_type?: string
    [key: string]: unknown
}

type ChatMessage = {
    role: "user" | "assistant"
    content: string
    updatedStep?: TestStep | null
    applied?: boolean
}

interface StepReviewChatbotProps {
    /** 0-based index of the step being reviewed */
    stepIndex:    number
    /** The step object being reviewed */
    step:         TestStep
    /** Test case ID in the database */
    testCaseId:   string
    /** Called when user applies an update — refreshes parent step list */
    onStepUpdated: (stepIndex: number, updatedStep: TestStep) => void
    /** Called to close the panel */
    onClose:      () => void
}

// ─── Quick suggestion chips ────────────────────────────────────────────────

const SUGGESTIONS = [
    { label: "Change value",    prompt: "Change the value to " },
    { label: "Update action",   prompt: "Change the action to " },
    { label: "Fix locator",     prompt: "Update the locator target to " },
    { label: "Make it CLICK",   prompt: "Make this step click the " },
]

// ─── Action color badges ──────────────────────────────────────────────────

function ActionBadge({ action }: { action: string }) {
    const a = action.toUpperCase()
    const colors: Record<string, string> = {
        NAVIGATE:     "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
        CLICK:        "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
        TYPE:         "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
        ASSERT_TEXT:  "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
        ASSERT_URL:   "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
        ASSERT_TOAST: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
        WAIT:         "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
        SELECT:       "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
        LOOKUP:       "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
    }
    const cls = colors[a] ?? "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
    return (
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold font-mono uppercase tracking-wide ${cls}`}>
            {a}
        </span>
    )
}

// ─── Compact Step Preview ─────────────────────────────────────────────────

function StepCard({ step, label, highlight = false }: { step: TestStep; label: string; highlight?: boolean }) {
    return (
        <div className={`rounded-lg border p-2 text-[11px] space-y-0.5 transition-all ${
            highlight
                ? "border-violet-300 bg-violet-50 dark:border-violet-700 dark:bg-violet-950/20 ring-1 ring-violet-200 dark:ring-violet-800"
                : "border-gray-200 dark:border-gray-700 bg-white/50 dark:bg-black/20"
        }`}>
            <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">
                {label}
            </p>
            <div className="flex items-center gap-1.5 flex-wrap">
                <ActionBadge action={step.action} />
                {step.target && (
                    <span className="text-gray-700 dark:text-gray-300 font-medium truncate max-w-[140px]" title={step.target}>
                        {step.target}
                    </span>
                )}
                {step.value && (
                    <span className="text-gray-500 dark:text-gray-400 italic truncate max-w-[100px]" title={step.value}>
                        = &quot;{step.value.length > 25 ? step.value.slice(0, 25) + "…" : step.value}&quot;
                    </span>
                )}
            </div>
        </div>
    )
}

// ─── Main Component ───────────────────────────────────────────────────────

export default function StepReviewChatbot({
    stepIndex,
    step,
    testCaseId,
    onStepUpdated,
    onClose,
}: StepReviewChatbotProps) {
    const [messages,    setMessages]    = useState<ChatMessage[]>([])
    const [input,       setInput]       = useState("")
    const [isSending,   setIsSending]   = useState(false)
    const [pendingStep, setPendingStep] = useState<TestStep | null>(null)
    const [isApplying,  setIsApplying]  = useState(false)
    const [appliedCount, setAppliedCount] = useState(0)
    const [isExpanded,  setIsExpanded]  = useState(false)
    const [mounted,     setMounted]     = useState(false)

    const inputRef   = useRef<HTMLInputElement>(null)
    const bottomRef  = useRef<HTMLDivElement>(null)

    // Mount animation
    useEffect(() => { setMounted(true) }, [])

    // Focus input on mount
    useEffect(() => { inputRef.current?.focus() }, [])

    // Auto-scroll to bottom on new messages
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" })
    }, [messages])

    // Build chat_history for API calls (only committed messages, not pending)
    const getChatHistory = useCallback(() => {
        return messages.map(m => ({ role: m.role, content: m.content }))
    }, [messages])

    // ── Send a message ──────────────────────────────────────────────────────

    const handleSend = async (messageText?: string) => {
        const text = (messageText ?? input).trim()
        if (!text || isSending) return

        setInput("")
        setIsSending(true)
        setPendingStep(null)

        const userMsg: ChatMessage = { role: "user", content: text }
        const newMessages = [...messages, userMsg]
        setMessages(newMessages)

        try {
            const res = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"}/api/v1/tests/${testCaseId}/steps/${stepIndex}/review`,
                {
                    method:  "POST",
                    headers: { "Content-Type": "application/json" },
                    body:    JSON.stringify({
                        instruction:  text,
                        chat_history: getChatHistory(),
                        apply:        false,   // preview first, let user confirm
                    }),
                }
            )

            if (!res.ok) {
                const err = await res.json().catch(() => ({ detail: "Request failed" }))
                throw new Error(err.detail || "Request failed")
            }

            const data = await res.json()

            const assistantMsg: ChatMessage = {
                role:        "assistant",
                content:     data.reply || "Done.",
                updatedStep: data.updatedStep ?? null,
                applied:     false,
            }

            setMessages(prev => [...prev, assistantMsg])

            if (data.updatedStep) {
                setPendingStep(data.updatedStep)
            }
        } catch (err: any) {
            setMessages(prev => [
                ...prev,
                { role: "assistant", content: `Sorry, something went wrong: ${err.message}` },
            ])
        } finally {
            setIsSending(false)
        }
    }

    // ── Apply the pending step update ───────────────────────────────────────

    const handleApply = async () => {
        if (!pendingStep) return
        setIsApplying(true)
        try {
            const res = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"}/api/v1/tests/${testCaseId}/steps/${stepIndex}/apply`,
                {
                    method:  "POST",
                    headers: { "Content-Type": "application/json" },
                    body:    JSON.stringify({ updatedStep: pendingStep }),
                }
            )
            if (!res.ok) {
                const err = await res.json().catch(() => ({ detail: "Failed to save" }))
                throw new Error(err.detail || "Failed to save")
            }

            // Update parent state immediately (optimistic)
            onStepUpdated(stepIndex, pendingStep)
            setAppliedCount(c => c + 1)

            // Add confirmation message
            setMessages(prev => [
                ...prev,
                {
                    role:    "assistant",
                    content: `✅ Step ${stepIndex + 1} updated successfully!`,
                    applied: true,
                },
            ])
            setPendingStep(null)
            toast.success(`Step ${stepIndex + 1} updated successfully`)
        } catch (err: any) {
            toast.error("Failed to apply change: " + err.message)
        } finally {
            setIsApplying(false)
        }
    }

    // ── Discard pending step ────────────────────────────────────────────────

    const handleDiscard = () => {
        setPendingStep(null)
        setMessages(prev => [
            ...prev,
            { role: "assistant", content: "Change discarded. What else?" },
        ])
    }

    // ─── Widget dimensions ────────────────────────────────────────────────
    const widgetWidth = isExpanded ? 440 : 380
    const widgetHeight = isExpanded ? 560 : 440

    // ─── Render via Portal ────────────────────────────────────────────────
    const widget = (
        <>
            {/* Subtle backdrop — click to close */}
            <div
                className="fixed inset-0 z-[9998] bg-black/10 dark:bg-black/25"
                style={{
                    opacity: mounted ? 1 : 0,
                    transition: "opacity 0.2s ease",
                }}
                onClick={onClose}
            />

            {/* Floating widget */}
            <div
                id={`step-review-panel-${stepIndex}`}
                className="fixed z-[9999] flex flex-col bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden"
                style={{
                    bottom: 24,
                    right: 24,
                    width: widgetWidth,
                    height: widgetHeight,
                    maxWidth: "calc(100vw - 32px)",
                    maxHeight: "calc(100vh - 48px)",
                    boxShadow: "0 20px 60px -12px rgba(0,0,0,0.25), 0 0 0 1px rgba(0,0,0,0.05)",
                    transform: mounted ? "translateY(0) scale(1)" : "translateY(20px) scale(0.95)",
                    opacity: mounted ? 1 : 0,
                    transition: "transform 0.3s cubic-bezier(0.16,1,0.3,1), opacity 0.2s ease, width 0.2s ease, height 0.2s ease",
                }}
            >
                {/* ── Header ──────────────────────────────────────────────── */}
                <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-gray-200 dark:border-gray-800 bg-gradient-to-r from-violet-50 to-indigo-50 dark:from-violet-950/30 dark:to-indigo-950/20 flex-shrink-0">
                    <div className="flex items-center gap-2 min-w-0">
                        <div className="p-1 rounded-lg bg-violet-100 dark:bg-violet-900/40 flex-shrink-0">
                            <Sparkles className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
                        </div>
                        <div className="min-w-0">
                            <p className="text-xs font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-1.5 truncate">
                                Step {stepIndex + 1}
                                <ActionBadge action={step.action} />
                                {appliedCount > 0 && (
                                    <Badge className="text-[8px] px-1 h-3.5 bg-green-100 text-green-700 hover:bg-green-100 dark:bg-green-900/40 dark:text-green-300">
                                        {appliedCount} saved
                                    </Badge>
                                )}
                            </p>
                            <p className="text-[10px] text-gray-500 dark:text-gray-400 truncate">
                                {step.target ? step.target.slice(0, 35) + (step.target.length > 35 ? "…" : "") : "Edit with AI"}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                        <button
                            onClick={() => setIsExpanded(e => !e)}
                            className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                            title={isExpanded ? "Compact" : "Expand"}
                        >
                            {isExpanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                        </button>
                        <button
                            onClick={onClose}
                            className="p-1.5 rounded-md text-gray-400 hover:text-red-500 dark:text-gray-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                            id={`close-review-panel-${stepIndex}`}
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </div>

                {/* ── Chat Messages (scrollable area) ─────────────────────── */}
                <div className="flex-1 overflow-y-auto px-3 py-2.5 space-y-2.5 min-h-0">

                    {/* Welcome + suggestions on empty state */}
                    {messages.length === 0 && (
                        <div className="space-y-2.5">
                            <div className="flex gap-2 justify-start">
                                <div className="flex-shrink-0 w-5 h-5 rounded-full bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center mt-0.5">
                                    <Bot className="h-3 w-3 text-violet-600 dark:text-violet-400" />
                                </div>
                                <div className="max-w-[85%] px-2.5 py-2 rounded-xl rounded-tl-none bg-gradient-to-br from-violet-50 to-indigo-50 dark:from-violet-950/30 dark:to-indigo-950/20 border border-violet-100 dark:border-violet-900/40 text-[11px] text-gray-700 dark:text-gray-300 leading-relaxed">
                                    <p className="font-medium text-violet-700 dark:text-violet-300">
                                        👋 What would you like to change?
                                    </p>
                                </div>
                            </div>
                            {/* Quick chips inline */}
                            {!isSending && (
                                <div className="flex flex-wrap gap-1 pl-7">
                                    {SUGGESTIONS.map((s) => (
                                        <button
                                            key={s.label}
                                            onClick={() => { setInput(s.prompt); inputRef.current?.focus() }}
                                            className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] font-medium border border-violet-200 dark:border-violet-800 text-violet-600 dark:text-violet-300 bg-violet-50 dark:bg-violet-950/20 hover:bg-violet-100 dark:hover:bg-violet-900/30 transition-colors"
                                        >
                                            <ChevronRight className="h-2 w-2" />
                                            {s.label}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Message list */}
                    {messages.map((msg, idx) => (
                        <div key={idx}>
                            {msg.role === "user" ? (
                                <div className="flex justify-end gap-1.5">
                                    <div className="max-w-[82%] px-2.5 py-1.5 rounded-xl rounded-tr-none bg-violet-600 text-white text-[11px] leading-relaxed">
                                        {msg.content}
                                    </div>
                                </div>
                            ) : (
                                <div className="flex gap-1.5 justify-start">
                                    <div className="flex-shrink-0 w-5 h-5 rounded-full bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center mt-0.5">
                                        <Bot className="h-3 w-3 text-violet-600 dark:text-violet-400" />
                                    </div>
                                    <div className="flex-1 space-y-1.5 min-w-0">
                                        <div className={`max-w-[90%] px-2.5 py-1.5 rounded-xl rounded-tl-none text-[11px] leading-relaxed ${
                                            msg.applied
                                                ? "bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 text-green-800 dark:text-green-200"
                                                : "bg-white/80 dark:bg-black/30 border border-gray-100 dark:border-gray-800 text-gray-700 dark:text-gray-300"
                                        }`}>
                                            {msg.content}
                                        </div>
                                        {msg.updatedStep && !msg.applied && (
                                            <StepCard step={msg.updatedStep} label="Proposed" highlight />
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}

                    {/* Typing indicator */}
                    {isSending && (
                        <div className="flex gap-1.5 justify-start">
                            <div className="flex-shrink-0 w-5 h-5 rounded-full bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center">
                                <Bot className="h-3 w-3 text-violet-600 dark:text-violet-400" />
                            </div>
                            <div className="px-2.5 py-2 rounded-xl rounded-tl-none bg-white/80 dark:bg-black/30 border border-gray-100 dark:border-gray-800 flex items-center gap-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: "0ms" }} />
                                <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: "150ms" }} />
                                <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: "300ms" }} />
                            </div>
                        </div>
                    )}

                    <div ref={bottomRef} />
                </div>

                {/* ── Pending Step Apply/Discard Bar ───────────────────────── */}
                {pendingStep && (
                    <div className="flex-shrink-0 px-3 pb-2 pt-1.5 border-t border-violet-100 dark:border-violet-900/30 bg-violet-50/80 dark:bg-violet-950/20">
                        <div className="flex items-center gap-1.5 mb-1.5">
                            <Zap className="h-3 w-3 text-violet-600 dark:text-violet-400 flex-shrink-0" />
                            <p className="text-[10px] font-semibold text-violet-700 dark:text-violet-300">
                                Save this change?
                            </p>
                        </div>
                        <StepCard step={pendingStep} label="New Step" highlight />
                        <div className="flex gap-1.5 mt-1.5">
                            <Button
                                size="sm"
                                className="flex-1 h-7 bg-violet-600 hover:bg-violet-700 text-white text-[11px] gap-1 font-semibold rounded-lg"
                                onClick={handleApply}
                                disabled={isApplying}
                                id={`apply-step-update-${stepIndex}`}
                            >
                                {isApplying ? (
                                    <><Loader2 className="h-3 w-3 animate-spin" /> Saving…</>
                                ) : (
                                    <><CheckCircle2 className="h-3 w-3" /> Apply</>
                                )}
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-[11px] gap-0.5 border-gray-300 text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-900 rounded-lg"
                                onClick={handleDiscard}
                                disabled={isApplying}
                            >
                                <RotateCcw className="h-2.5 w-2.5" /> Discard
                            </Button>
                        </div>
                    </div>
                )}

                {/* ── Input Area ───────────────────────────────────────────── */}
                <div className="flex-shrink-0 px-3 py-2 border-t border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-black/10">
                    <div className="flex gap-1.5 items-center">
                        <input
                            ref={inputRef}
                            id={`step-review-input-${stepIndex}`}
                            className="flex-1 px-2.5 py-1.5 rounded-lg text-xs border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-violet-400 focus:border-transparent placeholder-gray-400 dark:placeholder-gray-600 transition-all"
                            placeholder='e.g. "Change value to Acme Corp"'
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault()
                                    handleSend()
                                }
                            }}
                            disabled={isSending}
                        />
                        <Button
                            size="icon"
                            className="h-7 w-7 bg-violet-600 hover:bg-violet-700 text-white flex-shrink-0 rounded-lg"
                            onClick={() => handleSend()}
                            disabled={!input.trim() || isSending}
                            id={`send-review-message-${stepIndex}`}
                        >
                            {isSending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                        </Button>
                    </div>
                </div>
            </div>
        </>
    )

    // Use portal to render at document.body level — avoids CSS stacking context issues
    if (typeof window === "undefined") return null
    return createPortal(widget, document.body)
}

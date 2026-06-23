/**
 * HitlChatPanel — AI-powered Human-in-the-Loop chatbot panel.
 *
 * v5 — Seamless Auto-Resume + Structured Suggestions:
 *   • Receives structured `suggestions[]` from backend (no regex parsing needed)
 *   • Each suggestion renders as a numbered card with "Apply & Resume" button
 *   • When LLM returns suggestion_type="valid" after user chat, auto-resumes
 *     execution after showing a 1.2s feedback bubble
 *   • Supports opType: insert | update | delete for all proposals
 *   • Manual Add / Update / Delete forms still available as fallback
 */
"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { createPortal } from "react-dom"
import {
    Send, Loader2, CheckCircle, SkipForward,
    Square, Cpu, AlertTriangle, RotateCcw,
    ChevronRight, Play,
    PlusCircle, Edit3, Trash2, ChevronDown, ChevronUp,
    Zap, Check, ArrowRight, Navigation,
    X, Minus,
} from "lucide-react"
import { Button } from "@/components/ui/button"

// ─── Types ────────────────────────────────────────────────────────────────────

type SuggestionType = "advice" | "valid" | "clarify" | "invalid"

/** A structured suggestion from the backend with enough info to apply without parsing */
interface SuggestionOption {
    label:  string
    action: string
    target: string
    value:  string
    opType: "insert" | "update" | "delete"
}

type HitlMessage = {
    role:              "user" | "assistant" | "system"
    content:           string
    suggestion_type?:  SuggestionType
    suggested_action?: string
    quick_replies?:    string[]
    options?:          string[]
    /** Structured suggestions from backend — preferred over options[] */
    suggestions?:      SuggestionOption[]
    /** Extracted step proposal — populated automatically after parsing the reply */
    proposedStep?:     ProposedStep | null
    /** Whether this is a feedback/status message (auto-resume notification) */
    isFeedback?:       boolean
}

/** A step that the AI proposed and the user can accept with one click */
interface ProposedStep {
    action:      string   // NAVIGATE | CLICK | TYPE | LOOKUP | SELECT | …
    target:      string   // URL, field label, selector
    value?:      string   // typed value, selected option, etc.
    opType:      "insert" | "update" | "delete"  // add before, patch current, or remove
    label:       string   // human-readable description shown in the card
}

/** Step override structure passed back to the parent on Apply & Resume */
export interface HitlStepOverride {
    action?:       string
    target?:       string
    value?:        string
    locator_type?: string
}

/** A new step to insert before the paused step */
export interface HitlNewStep {
    action:  string
    target:  string
    value:   string
}

export interface HitlResumeOpts {
    step_override?:    HitlStepOverride
    /** New step to insert BEFORE the paused step and then re-run from there */
    insert_step?:      HitlNewStep
    /** Delete the paused step from the test case before resuming */
    delete_step?:      boolean
    user_instruction?: string
    ai_suggestion?:    string
    /** 1-based step index — required for backend to patch the DB step */
    paused_step?:      number
    /** test case ID — required for backend step patch */
    test_case_id?:     string
}

interface HitlChatPanelProps {
    runId:        string
    testCaseId:   string
    pausedStep:   number | null   // 1-based
    errorMessage: string | null
    onResume:     (opts?: HitlResumeOpts) => Promise<void>
    onSkip:       () => Promise<void>
    onStop:       () => Promise<void>
    isActioning:  boolean
    /** True while the test is in the paused state — panel watches this to auto-close when resumed */
    isPaused?:    boolean
    /** Called after the panel's slide-out animation finishes so the parent can unmount it */
    onDismiss?:   () => void
    /** Current test steps (raw) — used to pre-populate the Update form */
    currentSteps?: { action: string; target: string; value: string; id?: string }[]
}

// ─── Action types ─────────────────────────────────────────────────────────────

type StepActionMode = "none" | "add" | "update" | "delete"

const ACTION_OPTIONS = [
    "NAVIGATE", "CLICK", "TYPE", "SELECT", "LOOKUP",
    "WAIT", "ASSERT_TEXT", "HOVER", "SCROLL",
]

// ─── Step proposal parser ─────────────────────────────────────────────────────
// Detects patterns like:
//   "Adding a NAVIGATE step to '/bank_details'"
//   "add a step to fill in the Currency field"
//   "navigate to /bank-details before clicking"
//   "insert a LOOKUP step for Currency field"
//   "add a TYPE step to enter 'USD' in the Currency field"

function parseProposedStep(text: string): ProposedStep | null {
    // ── 0. Arrow format: "ACTION → target" (enforced in system prompt for options[]) ────────
    // "NAVIGATE → /accounts"  |  "CLICK → '+ Add Account'"
    const arrowRe = /^(NAVIGATE|CLICK|TYPE|SELECT|LOOKUP|WAIT|SCROLL|HOVER|ASSERT_TEXT|ASSERT_URL|ASSERT_VISIBLE|ASSERT_TOAST|CHECKBOX)\s*[\u2192>]\s*[\'"]?(.+?)[\'"]?\s*$/i
    const arrowM = text.match(arrowRe)
    if (arrowM) {
        const action = arrowM[1].toUpperCase()
        let target = arrowM[2].trim()
        if (action === "NAVIGATE") {
            target = target.replace(/\s+page\s*$/i, "").trim()
            if (!target.startsWith("/") && !target.startsWith("http")) target = `/${target}`
        }
        return { action, target, value: "", opType: "insert" as const, label: `${action} to ${target}` }
    }

    // ── 0b. Bare quoted CLICK: CLICK '+ Add Account' ──────────────────────────────────
    const bareClickRe = /^CLICK\s+[\'"+]([^\'"]*)[\'"]?\s*$/i
    const bareClickM = text.match(bareClickRe)
    if (bareClickM) {
        const target = bareClickM[1].trim()
        return { action: "CLICK", target, value: "", opType: "insert" as const, label: `Click "${target}"` }
    }

    // ── 1. NAVIGATE ─────────────────────────────────────────────────────────
    // "Adding a NAVIGATE step to '/bank_details'"  |  "navigate to /bank-details"
    const navRe = /navigat\w*\s+(?:step\s+)?to\s+['"]?(\/[\w\-./?#=&%]*|[\w\-_]+(?:\/[\w\-_.]+)+)['"]?/i
    const navM = text.match(navRe)
    if (navM) {
        const raw = navM[1]
        const url = raw.startsWith("/") ? raw : `/${raw}`
        return { action: "NAVIGATE", target: url, value: "", opType: "insert", label: `Navigate to ${url}` }
    }

    // ── 2. LOOKUP/SELECT … targeting the <Field> field ──────────────────────
    // "add a LOOKUP step targeting the Currency field"
    // "uses LOOKUP action targeting the Currency field"
    const lookupTargetingRe = /(?:LOOKUP|SELECT)\s+(?:action\s+)?(?:step\s+)?targeting\s+(?:the\s+)?['"]?([A-Za-z][A-Za-z ]{2,30}?)['"]?\s*field/i
    const lookTargM = text.match(lookupTargetingRe)
    if (lookTargM) {
        const field = lookTargM[1].trim()
        if (field.length > 1 && field.length < 40)
            return { action: "LOOKUP", target: field, value: "", opType: "insert", label: `Lookup / Select "${field}"` }
    }

    // ── 3. "add a step … that uses LOOKUP action targeting the <Field> field" ─
    // "add a step between step 5 and step 6 that uses LOOKUP action targeting the Currency field"
    const addLookupTargRe = /add\s+a?\s*step\s+(?:\S+\s+){0,6}uses?\s+(?:LOOKUP|SELECT)\s+action\s+targeting\s+(?:the\s+)?['"]?([A-Za-z][A-Za-z ]{2,30}?)['"]?\s*field/i
    const addLookM = text.match(addLookupTargRe)
    if (addLookM) {
        const field = addLookM[1].trim()
        if (field.length > 1 && field.length < 40)
            return { action: "LOOKUP", target: field, value: "", opType: "insert", label: `Lookup / Select "${field}"` }
    }

    // ── 4. "add a step to fill in / populate / enter the <Field> field" ─────
    // "add a step to fill in the Currency field before clicking Create Product"
    const fillFieldRe = /add\s+a\s+step\s+to\s+(?:fill\s+in|populate|set|enter|select)\s+(?:the\s+)?['"]?([A-Za-z][A-Za-z ]{1,30}?)['"]?\s*(?:field|dropdown|input)?(?:\s|$|[.,!?])/i
    const fillM = text.match(fillFieldRe)
    if (fillM) {
        const field = fillM[1].trim()
        if (field.length > 1 && field.length < 40)
            return { action: "LOOKUP", target: field, value: "", opType: "insert", label: `Lookup / Select "${field}"` }
    }

    // ── 5. TYPE with quoted value ─────────────────────────────────────────────
    // "type 'USD' into the Currency field"  |  "enter 'John' in Name"
    const typeRe = /(?:type|fill\s+in|enter)\s+['"]([^'"]{1,60})['"]\s+(?:in(?:to)?|for)\s+(?:the\s+)?['"]?([A-Za-z][A-Za-z ]{1,30}?)['"]?\s*(?:field|input|box)?(?:\s|$|[.,!?])/i
    const typeM = text.match(typeRe)
    if (typeM) {
        const val   = typeM[1]
        const field = typeM[2].trim()
        return { action: "TYPE", target: field, value: val, opType: "insert", label: `Type "${val}" in "${field}"` }
    }

    // ── 6. "add a <ACTION_KEYWORD> step" ─────────────────────────────────────
    // "add a CLICK step to click '+New Bank'"  |  "add a NAVIGATE step to /bank-details"
    const addStepRe = /add\s+a\s+(NAVIGATE|CLICK|TYPE|SELECT|LOOKUP|WAIT|SCROLL|HOVER|ASSERT)\s+step\s+(?:to\s+)?['"]?([A-Za-z/\-_.?#'][A-Za-z0-9 '"/\-_.?#]{1,60}?)['"]?(?:\s|$|[.,!?])/i
    const addM = text.match(addStepRe)
    if (addM) {
        const action = addM[1].toUpperCase()
        const target = addM[2].trim()
        return { action, target, value: "", opType: "insert", label: `${action} → "${target}"` }
    }

    // ── 7. "add a step to click <Target>" ────────────────────────────────────
    const addClickRe = /add\s+a\s+step\s+to\s+click\s+(?:the\s+)?['"+]?([A-Za-z+][A-Za-z0-9 +\-_]{1,40}?)['"]?\s*(?:button|link|element)?(?:\s|$|[.,!?])/i
    const addClickM = text.match(addClickRe)
    if (addClickM) {
        const target = addClickM[1].trim()
        return { action: "CLICK", target, value: "", opType: "insert", label: `Click "${target}"` }
    }

    return null
}

// ─── Suggestion type styles ───────────────────────────────────────────────────

function getSuggestionStyle(type?: SuggestionType) {
    switch (type) {
        case "valid":   return "border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30"
        case "invalid": return "border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/30"
        case "clarify": return "border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30"
        default:        return "border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20"
    }
}

function getActionIcon(action: string) {
    switch (action) {
        case "NAVIGATE": return <Navigation className="h-3.5 w-3.5" />
        case "CLICK":    return <ArrowRight className="h-3.5 w-3.5" />
        case "LOOKUP":
        case "SELECT":   return <ChevronRight className="h-3.5 w-3.5" />
        default:         return <Play className="h-3.5 w-3.5" />
    }
}

function getActionColor(action: string): { bg: string; border: string; text: string } {
    switch (action) {
        case "NAVIGATE": return { bg: "#1d4ed8", border: "rgba(29,78,216,0.3)", text: "#bfdbfe" }
        case "CLICK":    return { bg: "#7c3aed", border: "rgba(124,58,237,0.3)", text: "#ddd6fe" }
        case "LOOKUP":
        case "SELECT":   return { bg: "#0891b2", border: "rgba(8,145,178,0.3)", text: "#a5f3fc" }
        case "TYPE":     return { bg: "#059669", border: "rgba(5,150,105,0.3)", text: "#a7f3d0" }
        default:         return { bg: "#d97706", border: "rgba(217,119,6,0.3)", text: "#fde68a" }
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
    isPaused = true,
    onDismiss,
    currentSteps = [],
}: HitlChatPanelProps) {
    const [messages, setMessages]       = useState<HitlMessage[]>([])
    const [input, setInput]             = useState("")
    const [isSending, setIsSending]     = useState(false)
    const [isAnalyzing, setIsAnalyzing] = useState(false)
    const [closing, setClosing]         = useState(false)
    const [mounted, setMounted]         = useState(false)
    const [acceptingIdx, setAcceptingIdx] = useState<number | null>(null)
    const [isMinimized, setIsMinimized] = useState(false)
    const [isHidden, setIsHidden]       = useState(false)

    // ── Step Action state ─────────────────────────────────────────────────────
    const [stepActionMode, setStepActionMode] = useState<StepActionMode>("none")
    const [actionExpanded, setActionExpanded] = useState(false)

    // Fields for Add form
    const [newStepAction, setNewStepAction] = useState("LOOKUP")
    const [newStepTarget, setNewStepTarget] = useState("")
    const [newStepValue, setNewStepValue]   = useState("")

    // Fields for Update form
    const [updateAction, setUpdateAction] = useState("")
    const [updateTarget, setUpdateTarget] = useState("")
    const [updateValue, setUpdateValue]   = useState("")

    const [latestAiSuggestion, setLatestAiSuggestion] = useState<string | null>(null)
    // Guard to prevent double-resume triggers (e.g., auto-resume + manual click racing)
    const autoResumeInProgress = useRef(false)

    const inputRef  = useRef<HTMLInputElement>(null)
    const bottomRef = useRef<HTMLDivElement>(null)

    const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"

    const determineOpType = (action: string): "insert" | "update" => {
        if (pausedStep != null && currentSteps && currentSteps.length >= pausedStep) {
            const pausedStepObj = currentSteps[pausedStep - 1]
            if (pausedStepObj && pausedStepObj.action?.toUpperCase() === action.toUpperCase()) {
                return "update"
            }
        }
        return "insert"
    }

    // ── Mount guard + reset stale closing state ────────────────────────────
    useEffect(() => {
        setMounted(true)
        setClosing(false)   // always start visible — clears any stale Fast Refresh state
    }, [])

    // ── Reset closing when run changes (new pause session) ──────────────────
    useEffect(() => {
        setClosing(false)
        setMessages([])
        setInput("")
        setAcceptingIdx(null)
    }, [runId])

    // ── Auto-close with animation when parent reports test is no longer paused ───
    const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    useEffect(() => {
        if (!mounted) return
        if (!isPaused) {
            // Parent has resumed / skipped / stopped — start slide-out animation
            setClosing(true)
            // After animation (250ms + buffer) inform parent so it can unmount us cleanly
            dismissTimerRef.current = setTimeout(() => {
                onDismiss?.()
            }, 320)
        }
        return () => {
            if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isPaused, mounted])

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" })
    }, [messages])

    // ── Auto-focus (preventScroll stops browser skip-to-content from appearing) ──
    useEffect(() => {
        if (mounted) setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 200)
    }, [mounted])

    // ── Pre-populate Update fields from paused step ──────────────────────────
    useEffect(() => {
        if (pausedStep != null && currentSteps.length >= pausedStep) {
            const step = currentSteps[pausedStep - 1]
            if (step) {
                setUpdateAction(step.action?.toUpperCase() || "CLICK")
                setUpdateTarget(step.target || "")
                setUpdateValue(step.value || "")
            }
        }
    }, [pausedStep, currentSteps])

    // ── Initial AI analysis ──────────────────────────────────────────────────
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
            if (data.suggested_action) setLatestAiSuggestion(data.suggested_action)
            const reply = data.reply || "I'm analysing the failure..."
            // Prefer structured proposed_step from backend; fall back to text parsing
            const proposedStepFromApi = data.proposed_step
                ? { ...data.proposed_step, opType: data.proposed_step.opType ?? determineOpType(data.proposed_step.action) }
                : null
            let proposed = proposedStepFromApi ?? parseProposedStep(reply)
            if (proposed) {
                proposed = { ...proposed, opType: proposed.opType ?? determineOpType(proposed.action) }
            }
            setMessages([{
                role:             "assistant",
                content:          reply,
                suggestion_type:  data.suggestion_type,
                suggested_action: data.suggested_action,
                quick_replies:    data.quick_replies,
                options:          data.options,
                suggestions:      data.suggestions,
                proposedStep:     proposed,
            }])
        } catch {
            setMessages([{
                role:         "assistant",
                content:      "I couldn't fetch an automatic analysis right now. Please describe what you see and I'll help.",
                quick_replies: ["Element not visible on page", "Data already exists", "Page didn't load correctly", "Try different field value"],
                proposedStep: null,
            }])
        } finally {
            setIsAnalyzing(false)
        }
    }, [API_BASE, runId, testCaseId, pausedStep, errorMessage])

    // ── Chat history ─────────────────────────────────────────────────────────
    const getChatHistory = useCallback(() =>
        messages.map(m => ({ role: m.role, content: m.content }))
    , [messages])

    // ── Send message ─────────────────────────────────────────────────────────
    const handleSend = async (text?: string) => {
        const msg = (text ?? input).trim()
        if (!msg || isSending) return
        setInput("")
        setIsSending(true)
        setMessages(prev => [...prev, { role: "user", content: msg, proposedStep: null }])
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
            if (data.suggested_action) setLatestAiSuggestion(data.suggested_action)
            const reply = data.reply || "Let me know what you see."
            // Prefer structured proposed_step from backend; fall back to text parsing
            const proposedStepFromApi = data.proposed_step
                ? { ...data.proposed_step, opType: data.proposed_step.opType ?? determineOpType(data.proposed_step.action) }
                : null
            let proposed = proposedStepFromApi ?? parseProposedStep(reply)
            if (proposed) {
                proposed = { ...proposed, opType: proposed.opType ?? determineOpType(proposed.action) }
            }

            const assistantMsg: HitlMessage = {
                role:             "assistant",
                content:          reply,
                suggestion_type:  data.suggestion_type,
                suggested_action: data.suggested_action,
                quick_replies:    data.quick_replies,
                options:          data.options,
                suggestions:      data.suggestions,
                proposedStep:     proposed,
            }
            setMessages(prev => [...prev, assistantMsg])

            // ── Auto-resume when the LLM returns suggestion_type="valid" ──────────
            // If the AI has confidently resolved the issue, automatically apply and
            // resume execution after showing a brief feedback message. This avoids
            // requiring an extra manual "Accept & Resume" button click.
            if (
                data.suggestion_type === "valid" &&
                proposed &&
                !autoResumeInProgress.current &&
                !isActioning
            ) {
                autoResumeInProgress.current = true
                // Show a friendly feedback bubble in the chat
                const feedbackMsg: HitlMessage = {
                    role:      "system",
                    content:   `✅ Step ${pausedStep ?? "?"} ${proposed.opType === "delete" ? "removed" : proposed.opType === "update" ? "updated" : "updated with new step"}. Resuming test execution...`,
                    isFeedback: true,
                }
                setMessages(prev => [...prev, feedbackMsg])
                setClosing(true)
                // Brief delay so the user can see the feedback before panel animates out
                await new Promise(resolve => setTimeout(resolve, 1200))
                try {
                    if (proposed.opType === "delete") {
                        await onResume({
                            delete_step:      true,
                            user_instruction: msg,
                            ai_suggestion:    data.suggested_action ?? reply,
                            paused_step:      pausedStep ?? undefined,
                            test_case_id:     testCaseId,
                        })
                    } else if (proposed.opType === "update") {
                        await onResume({
                            step_override: {
                                action: proposed.action,
                                target: proposed.target,
                                value:  proposed.value ?? "",
                            },
                            user_instruction: msg,
                            ai_suggestion:    data.suggested_action ?? reply,
                            paused_step:      pausedStep ?? undefined,
                            test_case_id:     testCaseId,
                        })
                    } else {
                        await onResume({
                            insert_step: {
                                action: proposed.action,
                                target: proposed.target,
                                value:  proposed.value ?? "",
                            },
                            user_instruction: msg,
                            ai_suggestion:    data.suggested_action ?? reply,
                            paused_step:      pausedStep ?? undefined,
                            test_case_id:     testCaseId,
                        })
                    }
                } finally {
                    autoResumeInProgress.current = false
                }
            }
        } catch {
            setMessages(prev => [...prev, {
                role:         "assistant",
                content:      "Sorry, I couldn't process that. Please try again or use the buttons below.",
                proposedStep: null,
            }])
        } finally {
            setIsSending(false)
        }
    }

    // ── Accept AI-proposed step inline ────────────────────────────────────────
    const handleAcceptProposal = async (proposal: ProposedStep, msgIdx: number) => {
        if (autoResumeInProgress.current) return  // prevent race with auto-resume
        setAcceptingIdx(msgIdx)
        setClosing(true)
        let opts: HitlResumeOpts
        if (proposal.opType === "delete") {
            opts = {
                delete_step:      true,
                user_instruction: proposal.label,
                ai_suggestion:    proposal.label,
                paused_step:      pausedStep ?? undefined,
                test_case_id:     testCaseId,
            }
        } else if (proposal.opType === "update") {
            opts = {
                step_override: {
                    action: proposal.action,
                    target: proposal.target,
                    value:  proposal.value ?? "",
                },
                user_instruction: proposal.label,
                ai_suggestion:    proposal.label,
                paused_step:      pausedStep ?? undefined,
                test_case_id:     testCaseId,
            }
        } else {
            opts = {
                insert_step: {
                    action: proposal.action,
                    target: proposal.target,
                    value:  proposal.value ?? "",
                },
                user_instruction: proposal.label,
                ai_suggestion:    proposal.label,
                paused_step:      pausedStep ?? undefined,
                test_case_id:     testCaseId,
            }
        }
        try {
            await onResume(opts)
        } finally {
            setAcceptingIdx(null)
        }
    }

    // ── Manual form helpers ──────────────────────────────────────────────────
    const selectMode = (mode: StepActionMode) => {
        setStepActionMode(mode)
        setActionExpanded(true)
    }

    // Pre-fill Add form from a proposal and open the toolbar
    const preloadAddForm = (proposal: ProposedStep) => {
        setNewStepAction(proposal.action)
        setNewStepTarget(proposal.target)
        setNewStepValue(proposal.value ?? "")
        selectMode("add")
    }

    const handleAddStepAndResume = async () => {
        if (!newStepTarget.trim() && !newStepValue.trim()) return
        setClosing(true)
        await onResume({
            insert_step: { action: newStepAction, target: newStepTarget.trim(), value: newStepValue.trim() },
            user_instruction: `Add ${newStepAction} step for "${newStepTarget}"`,
            ai_suggestion:    latestAiSuggestion ?? undefined,
            paused_step:      pausedStep ?? undefined,
            test_case_id:     testCaseId,
        })
    }

    const handleUpdateStepAndResume = async () => {
        setClosing(true)
        await onResume({
            step_override: { action: updateAction, target: updateTarget.trim(), value: updateValue.trim() },
            user_instruction: `Update step ${pausedStep} to ${updateAction}`,
            ai_suggestion:    latestAiSuggestion ?? undefined,
            paused_step:      pausedStep ?? undefined,
            test_case_id:     testCaseId,
        })
    }

    const handleDeleteStepAndResume = async () => {
        setClosing(true)
        await onResume({
            delete_step:      true,
            user_instruction: `Delete step ${pausedStep}`,
            ai_suggestion:    latestAiSuggestion ?? undefined,
            paused_step:      pausedStep ?? undefined,
            test_case_id:     testCaseId,
        })
    }

    const handleResume = async () => { setClosing(true); await onResume() }
    const handleSkip   = async () => { setClosing(true); await onSkip() }
    const handleStop   = async () => { setClosing(true); await onStop() }

    /** Temporarily hide the panel — test keeps running */
    const handleClose    = () => setIsHidden(true)
    /** Toggle minimise — collapses to a floating tab */
    const handleMinimize = () => setIsMinimized(prev => !prev)
    /** Re-open from the minimized tab */
    const handleReopen   = () => { setIsMinimized(false); setIsHidden(false) }

    if (!mounted) return null

    // ─────────────────────────────────────────────────────────────────────────
    // ── Minimized tab (shown when panel is minimized or hidden) ───────────────
    const miniTab = (isMinimized || isHidden) ? (
        <div
            className="fixed z-[9993] flex items-center gap-2 px-3 py-2.5 rounded-xl cursor-pointer shadow-2xl border border-amber-500/40"
            style={{
                bottom:     24,
                right:      24,
                background: "linear-gradient(135deg, #78350f, #0c1a2e)",
            }}
            onClick={handleReopen}
            title="Re-open NEXUS HITL chat"
        >
            <div
                className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ background: "linear-gradient(135deg, #d97706, #b45309)" }}
            >
                <Cpu className="h-3 w-3 text-white" />
            </div>
            <span className="text-xs font-black tracking-[0.18em] text-white">NEXUS</span>
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/30 text-amber-200 font-semibold border border-amber-500/40">HITL</span>
            <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-400" />
            </span>
            <span className="text-[10px] text-amber-300 font-medium">⏸ Paused</span>
        </div>
    ) : null

    // ─────────────────────────────────────────────────────────────────────────
    const panel = (
        <>
            {/* Backdrop — hidden when minimized/closed so page is usable */}
            {!isMinimized && !isHidden && (
                <div className="fixed inset-0 z-[9991] bg-black/15 dark:bg-black/40 pointer-events-none" />
            )}

            {/* Minimized floating tab */}
            {miniTab}

            {/* Panel — hidden when minimized or closed */}
            {!isMinimized && !isHidden && (
            <div
                className={`fixed z-[9992] flex flex-col bg-white dark:bg-gray-950 rounded-2xl overflow-hidden shadow-2xl border border-amber-200 dark:border-amber-800/60 ${closing ? "nexus-slide-out" : "nexus-slide-in"}`}
                style={{
                    width:     470,
                    maxWidth:  "calc(100vw - 24px)",
                    height:    "82vh",
                    minHeight: 540,
                    maxHeight: 860,
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
                    {/* Left: logo + status */}
                    <div className="flex items-center gap-3 min-w-0">
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
                                <span className="relative flex h-2 w-2">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                                    <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-400" />
                                </span>
                            </div>
                            <p className="text-[10px] text-amber-300 mt-0.5 font-medium truncate">
                                Test Paused at Step {pausedStep ?? "?"} — AI Assistant
                            </p>
                        </div>
                    </div>

                    {/* Right: action buttons */}
                    <div className="flex items-center gap-1 flex-shrink-0">
                        {/* Re-analyse */}
                        <button
                            onClick={runInitialAnalysis}
                            disabled={isAnalyzing || isSending}
                            className="p-1.5 rounded-md text-amber-300 hover:text-white hover:bg-white/10 transition-colors"
                            title="Re-analyse error"
                        >
                            <RotateCcw className={`h-3.5 w-3.5 ${isAnalyzing ? "animate-spin" : ""}`} />
                        </button>

                        {/* Minimise — collapses to floating tab */}
                        <button
                            onClick={handleMinimize}
                            className="p-1.5 rounded-md text-amber-300 hover:text-white hover:bg-white/10 transition-colors"
                            title="Minimise panel (test keeps running)"
                        >
                            <Minus className="h-3.5 w-3.5" />
                        </button>

                        {/* Close — hides panel, test keeps running */}
                        <button
                            onClick={handleClose}
                            className="p-1.5 rounded-md text-amber-300 hover:text-red-300 hover:bg-red-500/15 transition-colors"
                            title="Hide panel (test keeps running — click floating tab to reopen)"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </div>

                {/* ── Error context ─────────────────────────────────────────── */}
                {errorMessage && (
                    <div className="px-3 py-2 border-b border-amber-100 dark:border-amber-900/40 bg-amber-50/70 dark:bg-amber-950/20 flex-shrink-0">
                        <div className="flex items-start gap-1.5">
                            <AlertTriangle className="h-3 w-3 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                            <p className="text-[10px] text-amber-700 dark:text-amber-300 leading-relaxed break-words">
                                <span className="font-semibold">Error: </span>
                                {errorMessage.length > 140 ? errorMessage.slice(0, 140) + "…" : errorMessage}
                            </p>
                        </div>
                    </div>
                )}

                {/* ── Messages ─────────────────────────────────────────────── */}
                <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 min-h-0">

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

                    {messages.map((msg, idx) => (
                        <div key={idx}>
                            {/* System feedback bubble (auto-resume notification) */}
                            {msg.role === "system" && msg.isFeedback && (
                                <div className="flex justify-center my-1">
                                    <div
                                        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-semibold"
                                        style={{
                                            background:  "linear-gradient(135deg, rgba(22,163,74,0.15), rgba(15,23,42,0.1))",
                                            border:      "1px solid rgba(34,197,94,0.4)",
                                            color:       "#4ade80",
                                        }}
                                    >
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                        {msg.content}
                                    </div>
                                </div>
                            )}
                            {msg.role === "user" ? (
                                <div className="flex justify-end">
                                    <div
                                        className="max-w-[85%] px-3 py-2 rounded-xl rounded-tr-none text-[11px] leading-relaxed text-white"
                                        style={{ background: "linear-gradient(135deg, #d97706, #b45309)" }}
                                    >
                                        {msg.content}
                                    </div>
                                </div>
                            ) : (
                                <div className="flex gap-2">
                                    <div
                                        className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center mt-0.5"
                                        style={{ background: "linear-gradient(135deg, #d97706, #b45309)" }}
                                    >
                                        <Cpu className="h-3 w-3 text-white" />
                                    </div>
                                    <div className="flex-1 space-y-2 min-w-0">
                                        {/* Bubble */}
                                        <div className={`max-w-[96%] rounded-xl rounded-tl-none border text-[11px] leading-relaxed ${getSuggestionStyle(msg.suggestion_type)}`}>
                                            <div className="px-3 py-2.5">
                                                <p className="text-gray-700 dark:text-gray-200 whitespace-pre-wrap">{msg.content}</p>
                                            </div>
                                        </div>

                                        {/* ───────────────────────────────────────────────────────
                                            AI PROPOSED STEP ACCEPTANCE CARD
                                            Appears when the AI text describes a concrete step action
                                        ─────────────────────────────────────────────────────── */}
                                        {msg.proposedStep && (
                                            <div
                                                className="max-w-[96%] rounded-xl overflow-hidden border-2"
                                                style={{
                                                    borderColor: "rgba(34,197,94,0.5)",
                                                    background:  "linear-gradient(135deg, rgba(22,163,74,0.06), rgba(15,23,42,0.04))",
                                                }}
                                            >
                                                {/* Card header */}
                                                <div
                                                    className="flex items-center gap-2 px-3 py-1.5"
                                                    style={{ background: "rgba(22,163,74,0.12)" }}
                                                >
                                                    <span className="text-emerald-500 text-xs">💡</span>
                                                    <span className="text-[9px] font-black uppercase tracking-[0.15em] text-emerald-700 dark:text-emerald-400">
                                                        AI Proposed Step
                                                    </span>
                                                </div>

                                                {/* Step preview */}
                                                <div className="px-3 py-2 flex items-center gap-2">
                                                    {/* Action badge */}
                                                    {(() => {
                                                        const col = getActionColor(msg.proposedStep.action)
                                                        return (
                                                            <span
                                                                className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold"
                                                                style={{
                                                                    background: `${col.bg}22`,
                                                                    border:     `1px solid ${col.border}`,
                                                                    color:      col.text,
                                                                }}
                                                            >
                                                                {getActionIcon(msg.proposedStep.action)}
                                                                {msg.proposedStep.action}
                                                            </span>
                                                        )
                                                    })()}
                                                    <span className="text-[11px] text-gray-700 dark:text-gray-300 font-medium truncate">
                                                        {msg.proposedStep.target}
                                                        {msg.proposedStep.value && (
                                                            <span className="text-gray-400 dark:text-gray-500 italic"> = "{msg.proposedStep.value}"</span>
                                                        )}
                                                    </span>
                                                </div>

                                                {/* Step insertion note */}
                                                <p className="px-3 pb-2 text-[9px] text-emerald-700 dark:text-emerald-500">
                                                    {msg.proposedStep.opType === "delete" ? (
                                                        <>Will <strong>remove</strong> Step {pausedStep} and skip it</>
                                                    ) : msg.proposedStep.opType === "update" ? (
                                                        <>Will <strong>update</strong> Step {pausedStep} in-place and re-run</>
                                                    ) : (
                                                        <>Will be inserted <strong>before</strong> Step {pausedStep} and executed first</>
                                                    )}
                                                </p>

                                                {/* CTA buttons */}
                                                <div className="grid grid-cols-2 gap-2 px-3 pb-3">
                                                    <Button
                                                        id={`hitl-accept-proposal-${idx}`}
                                                        size="sm"
                                                        className="h-9 text-[11px] font-bold gap-1.5 rounded-lg"
                                                        style={{ background: "linear-gradient(135deg, #16a34a, #15803d)" }}
                                                        onClick={() => handleAcceptProposal(msg.proposedStep!, idx)}
                                                        disabled={isActioning || acceptingIdx !== null}
                                                    >
                                                        {acceptingIdx === idx
                                                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                            : <Check className="h-3.5 w-3.5" />}
                                                        Accept &amp; Resume Testing
                                                    </Button>
                                                    <button
                                                        className="h-9 rounded-lg border border-gray-200 dark:border-gray-700 text-[10px] text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                                                        onClick={() => preloadAddForm(msg.proposedStep!)}
                                                        disabled={isActioning}
                                                    >
                                                        ✏️ Edit before adding
                                                    </button>
                                                </div>
                                            </div>
                                        )}

                                        {/* ── Structured Suggestion Cards ────────────────────────
                                            Preferred rendering when backend returns suggestions[].
                                            Each item has full structured data (action/target/value/opType)
                                            so we can apply the change directly without any regex parsing.
                                        ─────────────────────────────────────────────────────── */}
                                        {msg.suggestions && msg.suggestions.length > 0 && !msg.proposedStep && (
                                            <div className="flex flex-col gap-2 max-w-[96%]">
                                                {msg.suggestions.map((sug, si) => {
                                                    const proposal: ProposedStep = {
                                                        action: sug.action,
                                                        target: sug.target,
                                                        value:  sug.value,
                                                        opType: sug.opType,
                                                        label:  sug.label,
                                                    }
                                                    const col = getActionColor(sug.action)
                                                    const actionKey = idx * 1000 + si
                                                    const opLabel =
                                                        sug.opType === "delete" ? "Remove step" :
                                                        sug.opType === "update" ? "Update step" :
                                                        "Insert before step"
                                                    return (
                                                        <div
                                                            key={si}
                                                            className="rounded-xl overflow-hidden border"
                                                            style={{
                                                                borderColor: "rgba(34,197,94,0.35)",
                                                                background: "linear-gradient(135deg, rgba(22,163,74,0.04), rgba(15,23,42,0.02))",
                                                            }}
                                                        >
                                                            {/* Card header: number badge + action badge + op label */}
                                                            <div className="flex items-center gap-2 px-3 py-1.5" style={{ background: "rgba(22,163,74,0.07)" }}>
                                                                <span
                                                                    className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-black text-white"
                                                                    style={{ background: "linear-gradient(135deg, #d97706, #b45309)" }}
                                                                >
                                                                    {si + 1}
                                                                </span>
                                                                <span
                                                                    className="flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold"
                                                                    style={{
                                                                        background: `${col.bg}22`,
                                                                        border:     `1px solid ${col.border}`,
                                                                        color:      col.text,
                                                                    }}
                                                                >
                                                                    {getActionIcon(sug.action)}
                                                                    {sug.action}
                                                                </span>
                                                                <span className="text-[9px] text-gray-400 dark:text-gray-500 ml-auto">{opLabel}</span>
                                                            </div>

                                                            {/* Card body: label + target/value */}
                                                            <div className="px-3 py-2">
                                                                <p className="text-[11px] text-gray-700 dark:text-gray-200 font-medium leading-snug">
                                                                    {sug.label}
                                                                </p>
                                                                {(sug.target || sug.value) && (
                                                                    <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5 font-mono truncate">
                                                                        {sug.target}{sug.value ? ` = "${sug.value}"` : ""}
                                                                    </p>
                                                                )}
                                                            </div>

                                                            {/* Apply & Resume button */}
                                                            <Button
                                                                id={`hitl-suggestion-apply-${idx}-${si}`}
                                                                size="sm"
                                                                className="w-full rounded-none h-8 text-[11px] font-bold gap-1.5"
                                                                style={{ background: "linear-gradient(135deg, #16a34a, #15803d)" }}
                                                                onClick={() => handleAcceptProposal(proposal, actionKey)}
                                                                disabled={isActioning || acceptingIdx !== null || autoResumeInProgress.current}
                                                            >
                                                                {acceptingIdx === actionKey
                                                                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                                    : <Check className="h-3.5 w-3.5" />}
                                                                Apply &amp; Resume
                                                            </Button>
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        )}

                                        {/* ── Legacy AI Options (fallback when suggestions[] absent) ──
                                            Shown when AI returns options[] but no suggestions[].
                                            Each option is parsed via parseProposedStep() for an
                                            "Apply & Resume" button, or sent as chat if unparseable.
                                        ─────────────────────────────────────────────────────── */}
                                        {msg.options && msg.options.length > 0 && !msg.proposedStep && !msg.suggestions?.length && (
                                            <div className="flex flex-col gap-2 max-w-[96%]">
                                                {msg.options.map((opt, oi) => {
                                                    const parsed = parseProposedStep(opt)
                                                    if (parsed) {
                                                        parsed.opType = determineOpType(parsed.action)
                                                    }
                                                    return (
                                                        <div
                                                            key={oi}
                                                            className="rounded-xl overflow-hidden border"
                                                            style={{ borderColor: "rgba(34,197,94,0.35)", background: "rgba(22,163,74,0.04)" }}
                                                        >
                                                            <p className="px-3 py-2 text-[11px] text-gray-700 dark:text-gray-300 leading-relaxed">
                                                                {opt}
                                                            </p>
                                                            {parsed ? (
                                                                <Button
                                                                    id={`hitl-option-apply-${idx}-${oi}`}
                                                                    size="sm"
                                                                    className="w-full rounded-none h-8 text-[11px] font-bold gap-1.5"
                                                                    style={{ background: "linear-gradient(135deg, #16a34a, #15803d)" }}
                                                                    onClick={() => handleAcceptProposal(parsed, idx * 100 + oi)}
                                                                    disabled={isActioning || acceptingIdx !== null}
                                                                >
                                                                    {acceptingIdx === idx * 100 + oi
                                                                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                                        : <Check className="h-3.5 w-3.5" />}
                                                                    Apply &amp; Resume Testing
                                                                </Button>
                                                            ) : (
                                                                <Button
                                                                    id={`hitl-option-select-${idx}-${oi}`}
                                                                    size="sm"
                                                                    variant="outline"
                                                                    className="w-full rounded-none h-8 text-[11px] font-medium gap-1.5 border-t border-emerald-200 dark:border-emerald-800"
                                                                    onClick={() => handleSend(opt)}
                                                                    disabled={isActioning || isSending}
                                                                >
                                                                    <ChevronRight className="h-3.5 w-3.5" />
                                                                    Select this option
                                                                </Button>
                                                            )}
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        )}

                                        {/* Quick-reply chips */}
                                        {msg.quick_replies && msg.quick_replies.length > 0 && (
                                            <div className="flex flex-wrap gap-1.5">
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

                {/* ── Bottom action area ─────────────────────────────────────── */}
                <div className="flex-shrink-0 border-t border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-black/10">

                    {/* Chat input */}
                    <div className="flex gap-1.5 items-center px-3 pt-2.5 pb-2">
                        <input
                            ref={inputRef}
                            id="hitl-chat-input"
                            value={input}
                            onChange={e => setInput(e.target.value)}
                            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend() } }}
                            disabled={isSending || isAnalyzing}
                            placeholder="Describe your fix or ask NEXUS for help…"
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
                            {isSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                        </Button>
                    </div>

                    {/* ─────────────────────────────────────────────────────────
                        STEP ACTIONS TOOLBAR (manual override)
                    ───────────────────────────────────────────────────────── */}
                    <div className="px-3 pb-2 space-y-2">
                        <div
                            className="rounded-xl border-2 border-amber-400/60 dark:border-amber-600/50 overflow-hidden"
                            style={{ background: "linear-gradient(135deg, rgba(120,53,15,0.08) 0%, rgba(15,23,42,0.04) 100%)" }}
                        >
                            {/* Toolbar header toggle */}
                            <button
                                onClick={() => setActionExpanded(e => !e)}
                                className="w-full flex items-center justify-between px-3 py-2 hover:bg-amber-50/60 dark:hover:bg-amber-950/20 transition-colors"
                            >
                                <div className="flex items-center gap-2">
                                    <Zap className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                                    <span className="text-[11px] font-bold text-amber-800 dark:text-amber-300 uppercase tracking-wide">
                                        Step Actions
                                    </span>
                                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-400/40 font-semibold">
                                        Fix &amp; Resume
                                    </span>
                                </div>
                                {actionExpanded
                                    ? <ChevronUp className="h-3.5 w-3.5 text-amber-600" />
                                    : <ChevronDown className="h-3.5 w-3.5 text-amber-600" />}
                            </button>

                            {/* ADD / UPDATE / DELETE buttons */}
                            <div className="grid grid-cols-3 gap-1.5 px-3 pb-2">
                                <button
                                    id="hitl-add-step-btn"
                                    onClick={() => selectMode(stepActionMode === "add" ? "none" : "add")}
                                    className={`flex flex-col items-center gap-1 py-2 px-1 rounded-lg border transition-all duration-150 text-[10px] font-semibold ${
                                        stepActionMode === "add"
                                            ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 shadow-sm"
                                            : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:border-emerald-400 hover:text-emerald-600 hover:bg-emerald-50/50"
                                    }`}
                                >
                                    <PlusCircle className="h-4 w-4" />
                                    Add Step
                                </button>
                                <button
                                    id="hitl-update-step-btn"
                                    onClick={() => selectMode(stepActionMode === "update" ? "none" : "update")}
                                    className={`flex flex-col items-center gap-1 py-2 px-1 rounded-lg border transition-all duration-150 text-[10px] font-semibold ${
                                        stepActionMode === "update"
                                            ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 shadow-sm"
                                            : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50/50"
                                    }`}
                                >
                                    <Edit3 className="h-4 w-4" />
                                    Update Step
                                </button>
                                <button
                                    id="hitl-delete-step-btn"
                                    onClick={() => selectMode(stepActionMode === "delete" ? "none" : "delete")}
                                    className={`flex flex-col items-center gap-1 py-2 px-1 rounded-lg border transition-all duration-150 text-[10px] font-semibold ${
                                        stepActionMode === "delete"
                                            ? "border-red-500 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 shadow-sm"
                                            : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:border-red-400 hover:text-red-600 hover:bg-red-50/50"
                                    }`}
                                >
                                    <Trash2 className="h-4 w-4" />
                                    Delete Step
                                </button>
                            </div>

                            {/* Expanded form */}
                            {actionExpanded && stepActionMode !== "none" && (
                                <div className="px-3 pb-3 pt-1 border-t border-amber-200/50 dark:border-amber-800/30 space-y-2">

                                    {/* ADD STEP form */}
                                    {stepActionMode === "add" && (
                                        <>
                                            <p className="text-[10px] font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                                                <PlusCircle className="h-3 w-3" />
                                                New step — will run before Step {pausedStep}
                                            </p>
                                            <div className="grid grid-cols-3 gap-1.5">
                                                <div className="col-span-1">
                                                    <label className="text-[9px] text-gray-500 uppercase tracking-wider font-semibold block mb-0.5">Action</label>
                                                    <select
                                                        value={newStepAction}
                                                        onChange={e => setNewStepAction(e.target.value)}
                                                        className="w-full px-2 py-1.5 rounded-md text-[11px] border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                                                    >
                                                        {ACTION_OPTIONS.map(a => <option key={a} value={a}>{a}</option>)}
                                                    </select>
                                                </div>
                                                <div className="col-span-2">
                                                    <label className="text-[9px] text-gray-500 uppercase tracking-wider font-semibold block mb-0.5">Target / URL / Field</label>
                                                    <input
                                                        value={newStepTarget}
                                                        onChange={e => setNewStepTarget(e.target.value)}
                                                        placeholder="e.g. /bank-details or Currency"
                                                        className="w-full px-2 py-1.5 rounded-md text-[11px] border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-emerald-400 placeholder-gray-400"
                                                    />
                                                </div>
                                            </div>
                                            <div>
                                                <label className="text-[9px] text-gray-500 uppercase tracking-wider font-semibold block mb-0.5">Value (optional)</label>
                                                <input
                                                    value={newStepValue}
                                                    onChange={e => setNewStepValue(e.target.value)}
                                                    placeholder="e.g. USD"
                                                    className="w-full px-2 py-1.5 rounded-md text-[11px] border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-emerald-400 placeholder-gray-400"
                                                />
                                            </div>
                                            {(newStepTarget || newStepValue) && (
                                                <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800">
                                                    <Check className="h-3 w-3 text-emerald-600 flex-shrink-0" />
                                                    <p className="text-[10px] text-emerald-700 dark:text-emerald-300">
                                                        <span className="font-bold">{newStepAction}</span>
                                                        {newStepTarget && <> → <span className="font-medium">{newStepTarget}</span></>}
                                                        {newStepValue && <> = <span className="italic">"{newStepValue}"</span></>}
                                                    </p>
                                                </div>
                                            )}
                                            <Button
                                                id="hitl-add-resume-btn"
                                                size="sm"
                                                className="w-full h-10 text-[12px] font-bold gap-2 rounded-lg shadow-md shadow-emerald-900/20"
                                                style={{ background: "linear-gradient(135deg, #16a34a, #15803d)" }}
                                                onClick={handleAddStepAndResume}
                                                disabled={(!newStepTarget.trim() && !newStepValue.trim()) || isActioning}
                                            >
                                                {isActioning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                                                Add Step &amp; Resume Testing
                                            </Button>
                                        </>
                                    )}

                                    {/* UPDATE STEP form */}
                                    {stepActionMode === "update" && (
                                        <>
                                            <p className="text-[10px] font-bold text-blue-700 dark:text-blue-400 uppercase tracking-wider flex items-center gap-1.5">
                                                <Edit3 className="h-3 w-3" /> Update Step {pausedStep}
                                            </p>
                                            <div className="grid grid-cols-3 gap-1.5">
                                                <div className="col-span-1">
                                                    <label className="text-[9px] text-gray-500 uppercase tracking-wider font-semibold block mb-0.5">Action</label>
                                                    <select
                                                        value={updateAction}
                                                        onChange={e => setUpdateAction(e.target.value)}
                                                        className="w-full px-2 py-1.5 rounded-md text-[11px] border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-400"
                                                    >
                                                        {ACTION_OPTIONS.map(a => <option key={a} value={a}>{a}</option>)}
                                                    </select>
                                                </div>
                                                <div className="col-span-2">
                                                    <label className="text-[9px] text-gray-500 uppercase tracking-wider font-semibold block mb-0.5">Target</label>
                                                    <input
                                                        value={updateTarget}
                                                        onChange={e => setUpdateTarget(e.target.value)}
                                                        className="w-full px-2 py-1.5 rounded-md text-[11px] border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-400"
                                                    />
                                                </div>
                                            </div>
                                            <div>
                                                <label className="text-[9px] text-gray-500 uppercase tracking-wider font-semibold block mb-0.5">Value</label>
                                                <input
                                                    value={updateValue}
                                                    onChange={e => setUpdateValue(e.target.value)}
                                                    className="w-full px-2 py-1.5 rounded-md text-[11px] border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-400"
                                                />
                                            </div>
                                            <Button
                                                id="hitl-update-resume-btn"
                                                size="sm"
                                                className="w-full h-10 text-[12px] font-bold gap-2 rounded-lg shadow-md shadow-blue-900/20"
                                                style={{ background: "linear-gradient(135deg, #2563eb, #1d4ed8)" }}
                                                onClick={handleUpdateStepAndResume}
                                                disabled={isActioning}
                                            >
                                                {isActioning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                                                Update Step &amp; Resume Testing
                                            </Button>
                                        </>
                                    )}

                                    {/* DELETE STEP */}
                                    {stepActionMode === "delete" && (
                                        <>
                                            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50/60 dark:bg-red-950/20 px-3 py-2.5">
                                                <p className="text-[10px] font-bold text-red-700 dark:text-red-400 flex items-center gap-1.5 mb-1">
                                                    <Trash2 className="h-3 w-3" />
                                                    Delete Step {pausedStep} from test case
                                                </p>
                                                {pausedStep != null && currentSteps[pausedStep - 1] && (
                                                    <p className="text-[10px] text-red-600 dark:text-red-400">
                                                        <span className="font-medium">{currentSteps[pausedStep - 1].action}</span>
                                                        {currentSteps[pausedStep - 1].target && <> → "{currentSteps[pausedStep - 1].target}"</>}
                                                    </p>
                                                )}
                                                <p className="text-[9px] text-red-500 mt-1">
                                                    This step will be permanently removed and testing will continue from the next step.
                                                </p>
                                            </div>
                                            <Button
                                                id="hitl-delete-resume-btn"
                                                size="sm"
                                                className="w-full h-10 text-[12px] font-bold gap-2 rounded-lg shadow-md shadow-red-900/20 bg-red-600 hover:bg-red-700 text-white"
                                                onClick={handleDeleteStepAndResume}
                                                disabled={isActioning}
                                            >
                                                {isActioning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                                                Delete Step &amp; Resume Testing
                                            </Button>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Resume as-is / Skip / Stop */}
                        <div className="grid grid-cols-3 gap-1.5">
                            <Button
                                id="hitl-resume-btn"
                                size="sm"
                                variant="outline"
                                className="h-8 text-[10px] gap-0.5 rounded-lg border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
                                onClick={handleResume}
                                disabled={isActioning}
                                title="Resume without any change"
                            >
                                <CheckCircle className="h-3 w-3" /> Resume
                            </Button>
                            <Button
                                id="hitl-skip-btn"
                                size="sm"
                                variant="outline"
                                className="h-8 text-[10px] gap-0.5 rounded-lg border-amber-400 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30"
                                onClick={handleSkip}
                                disabled={isActioning}
                            >
                                <SkipForward className="h-3 w-3" /> Skip
                            </Button>
                            <Button
                                id="hitl-stop-btn"
                                size="sm"
                                variant="outline"
                                className="h-8 text-[10px] gap-0.5 rounded-lg border-red-400 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                                onClick={handleStop}
                                disabled={isActioning}
                            >
                                <Square className="h-3 w-3 fill-current" /> Stop
                            </Button>
                        </div>

                        <p className="text-[9px] text-gray-400 dark:text-gray-600 text-center pb-1">
                            NEXUS HITL · Accept AI suggestions inline or use Step Actions below
                        </p>
                    </div>
                </div>
            </div>
            )}
        </>
    )

    return createPortal(panel, document.body)
}

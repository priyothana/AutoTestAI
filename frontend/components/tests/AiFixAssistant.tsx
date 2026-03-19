"use client"

import { useState, useRef, useEffect } from "react"
import { Bot, ChevronDown, ChevronUp, CheckCircle, Send, Loader2, Wrench, Sparkles, ListChecks } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"

// ─── Types ─────────────────────────────────────────────────────────────────

type CorrectedStep = {
  step_order: number
  action: string
  target: string
  value: string
  locator_type?: string
}

type HealResult = {
  analysis?: string
  corrected_steps?: CorrectedStep[]
  // legacy fallback
  legacy_hints?: any[]
}

type TestStep = {
  id: string
  action: string
  target: string
  value: string
  locator_type?: string
}

type ChatMessage = {
  role: "user" | "assistant"
  content: string
}

interface AiFixAssistantProps {
  runId: string
  /** ai_suggestions field from the test run — now {analysis, corrected_steps} */
  suggestions: HealResult
  steps: TestStep[]
  onApplyFixes: (updatedSteps: TestStep[]) => void
  /** Receives the freshly-updated steps to avoid stale closure reads */
  onSave: (updatedSteps: TestStep[]) => Promise<void>
}

// ─── Helper: action badge color ─────────────────────────────────────────────
function actionColor(action: string) {
  const a = action.toUpperCase()
  if (a === "NAVIGATE") return "text-purple-600 dark:text-purple-400"
  if (a === "CLICK") return "text-blue-600 dark:text-blue-400"
  if (a === "FILL") return "text-emerald-600 dark:text-emerald-400"
  if (a === "ASSERT_TEXT") return "text-orange-600 dark:text-orange-400"
  if (a === "WAIT") return "text-gray-500"
  return "text-sky-600 dark:text-sky-400"
}

// ─── Component ─────────────────────────────────────────────────────────────

export default function AiFixAssistant({
  runId,
  suggestions,
  steps,
  onApplyFixes,
  onSave,
}: AiFixAssistantProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [applied, setApplied] = useState(false)
  const [isApplying, setIsApplying] = useState(false)
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState("")
  const [isChatting, setIsChatting] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [chatHistory])

  // ── Normalize legacy list format → {analysis, corrected_steps} ──────────
  let healResult: HealResult
  if (Array.isArray(suggestions)) {
    // Old format: array of {type, step_order, new_step, reason}
    healResult = {
      analysis: "Required fields were missing. Suggested fill steps before the Save action.",
      corrected_steps: (suggestions as any[]).map((hint: any, idx: number) => ({
        step_order: idx + 1,
        action: hint.new_step?.action || "fill",
        target: hint.new_step?.target || "",
        value: hint.new_step?.value || "",
        locator_type: hint.new_step?.locator_type || "label",
      })),
    }
  } else {
    healResult = suggestions as HealResult
  }

  const correctedSteps: CorrectedStep[] = healResult?.corrected_steps || []
  const analysis = healResult?.analysis || ""
  const hasSteps = correctedSteps.length > 0

  // ── Apply: replace all steps with corrected_steps ────────────────────────
  const handleAcceptFixes = async () => {
    if (!hasSteps) return
    setIsApplying(true)
    try {
      const updatedSteps: TestStep[] = correctedSteps.map((cs, idx) => ({
        id: `heal-${Date.now()}-${idx}`,
        action: (cs.action || "").toUpperCase(),
        target: cs.target || "",
        value: cs.value || "",
        locator_type: cs.locator_type || "",
      }))
      onApplyFixes(updatedSteps)
      // Pass updatedSteps directly so the parent doesn't read stale closure reads
      await onSave(updatedSteps)
      setApplied(true)
      toast.success("Test steps updated with AI-fixed flow! Review above, then click Run Test.")
    } catch (err) {
      console.error("Apply fix error:", err)
      toast.error("Failed to apply fixes. Please try again.")
    } finally {
      setIsApplying(false)
    }
  }

  // ── Chat ──────────────────────────────────────────────────────────────────
  const handleSendChat = async () => {
    if (!chatInput.trim() || isChatting) return
    const userMsg = chatInput.trim()
    setChatInput("")
    setIsChatting(true)
    const updatedHistory: ChatMessage[] = [...chatHistory, { role: "user", content: userMsg }]
    setChatHistory(updatedHistory)
    try {
      const res = await fetch(`http://localhost:8000/api/v1/test-runs/${runId}/heal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMsg,
          chat_history: updatedHistory.slice(-6).map((m) => ({ role: m.role, content: m.content })),
        }),
      })
      if (!res.ok) throw new Error("Chat request failed")
      const data = await res.json()
      setChatHistory((prev) => [...prev, { role: "assistant", content: data.reply || "No response." }])
    } catch {
      setChatHistory((prev) => [...prev, { role: "assistant", content: "Sorry, couldn't process that. Try again." }])
    } finally {
      setIsChatting(false)
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="mt-4 rounded-xl border-2 border-sky-200 dark:border-sky-800 bg-gradient-to-br from-sky-50/80 via-blue-50/50 to-cyan-50/30 dark:from-sky-950/30 dark:via-blue-950/20 dark:to-cyan-950/10 shadow-md overflow-hidden">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between px-5 py-3.5 cursor-pointer select-none"
        onClick={() => setCollapsed((c) => !c)}
      >
        <div className="flex items-center gap-3">
          <div className="p-1.5 rounded-lg bg-sky-100 dark:bg-sky-900/40">
            <Wrench className="h-4 w-4 text-sky-600 dark:text-sky-400" />
          </div>
          <div>
            <p className="font-semibold text-sm text-sky-800 dark:text-sky-200 flex items-center gap-2">
              AI Fix Assistant
              {hasSteps && (
                <Badge className="text-[10px] px-1.5 h-4 bg-sky-200 text-sky-800 hover:bg-sky-200 dark:bg-sky-800 dark:text-sky-100">
                  {correctedSteps.length} steps corrected
                </Badge>
              )}
            </p>
            <p className="text-xs text-sky-600/80 dark:text-sky-400/80 mt-0.5">
              {applied
                ? "✅ Steps updated — review above and click Run Test"
                : "Analysed the failure and generated a corrected test flow."}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {applied && <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />}
          {collapsed
            ? <ChevronDown className="h-4 w-4 text-sky-500" />
            : <ChevronUp className="h-4 w-4 text-sky-500" />}
        </div>
      </div>

      {!collapsed && (
        <div className="border-t border-sky-200/70 dark:border-sky-800/50">

          {/* ── Analysis banner ─────────────────────────────────────────── */}
          {analysis && (
            <div className="mx-5 mt-4 px-3 py-2 rounded-lg bg-sky-100/60 dark:bg-sky-900/20 border border-sky-200 dark:border-sky-800">
              <p className="text-[11px] text-sky-700 dark:text-sky-300 leading-relaxed">
                <span className="font-semibold">What changed: </span>{analysis}
              </p>
            </div>
          )}

          {/* ── Corrected steps list ─────────────────────────────────────── */}
          {hasSteps ? (
            <div className="px-5 py-4">
              <p className="text-xs font-medium text-sky-700 dark:text-sky-300 mb-2.5 flex items-center gap-1.5">
                <ListChecks className="h-3.5 w-3.5" />
                Complete corrected test flow ({correctedSteps.length} steps)
              </p>
              <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                {correctedSteps.map((cs, idx) => {
                  const isNew = !steps.some(
                    (s) => s.action.toUpperCase() === cs.action.toUpperCase() && s.target === cs.target
                  )
                  return (
                    <div
                      key={idx}
                      className={`flex items-start gap-2.5 px-3 py-2 rounded-lg border text-[11px] ${
                        isNew
                          ? "bg-emerald-50/70 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800"
                          : "bg-white/50 dark:bg-black/15 border-sky-100 dark:border-sky-900/30"
                      }`}
                    >
                      <span className="shrink-0 w-5 h-5 rounded-full bg-sky-100 dark:bg-sky-900/60 flex items-center justify-center text-[10px] font-bold text-sky-700 dark:text-sky-300">
                        {idx + 1}
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className={`font-mono font-semibold uppercase mr-1.5 ${actionColor(cs.action)}`}>
                          {cs.action}
                        </span>
                        {cs.target && (
                          <span className="text-gray-700 dark:text-gray-300 font-medium">
                            {cs.target.length > 50 ? cs.target.slice(0, 50) + "…" : cs.target}
                          </span>
                        )}
                        {cs.value && (
                          <span className="text-gray-500 dark:text-gray-400 ml-1">= "{cs.value}"</span>
                        )}
                      </div>
                      {isNew && (
                        <Badge className="text-[9px] px-1 h-4 bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/50 dark:text-emerald-300 shrink-0">
                          NEW
                        </Badge>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="px-5 py-4 text-sm text-muted-foreground">No corrected steps generated.</div>
          )}

          {/* ── Accept button ────────────────────────────────────────────── */}
          {!applied ? (
            <div className="px-5 pb-4">
              <Button
                className="w-full bg-sky-600 hover:bg-sky-700 text-white shadow-md font-semibold gap-2 h-10"
                onClick={handleAcceptFixes}
                disabled={isApplying || !hasSteps}
              >
                {isApplying ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Updating steps...</>
                ) : (
                  <><Sparkles className="h-4 w-4" /> Accept &amp; Update Test Steps</>
                )}
              </Button>
              <p className="text-[11px] text-center text-muted-foreground mt-2">
                Replaces your current test steps with the AI-corrected flow. Review in the editor, then click Run Test.
              </p>
            </div>
          ) : (
            <div className="px-5 pb-4">
              <div className="flex items-center gap-2 p-3 rounded-lg bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800">
                <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
                <p className="text-xs text-green-700 dark:text-green-300 font-medium">
                  Test steps updated! Review the changes above, then click <strong>Run Test</strong> to verify the fix.
                </p>
              </div>
            </div>
          )}

          {/* ── Chat section ─────────────────────────────────────────────── */}
          <div className="border-t border-sky-200/70 dark:border-sky-800/50 px-5 py-4">
            <p className="text-xs font-medium text-sky-700 dark:text-sky-300 mb-3 flex items-center gap-1.5">
              <Bot className="h-3.5 w-3.5" />
              Ask a follow-up question about the fix
            </p>
            {chatHistory.length > 0 && (
              <div className="space-y-2 mb-3 max-h-40 overflow-y-auto pr-1">
                {chatHistory.map((msg, idx) => (
                  <div key={idx} className={`flex gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[85%] px-3 py-2 rounded-xl text-[11px] leading-relaxed whitespace-pre-wrap ${
                        msg.role === "user"
                          ? "bg-sky-600 text-white rounded-br-none"
                          : "bg-white/70 dark:bg-black/30 border border-sky-100 dark:border-sky-900/40 text-gray-700 dark:text-gray-300 rounded-bl-none"
                      }`}
                    >
                      {msg.content}
                    </div>
                  </div>
                ))}
                {isChatting && (
                  <div className="flex gap-2 justify-start">
                    <div className="px-3 py-2 rounded-xl rounded-bl-none bg-white/70 dark:bg-black/30 border border-sky-100 dark:border-sky-900/40">
                      <Loader2 className="h-3 w-3 animate-spin text-sky-500" />
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>
            )}
            <div className="flex gap-2">
              <input
                className="flex-1 h-9 px-3 rounded-lg text-xs border border-sky-200 dark:border-sky-700 bg-white/60 dark:bg-black/20 focus:outline-none focus:ring-2 focus:ring-sky-400 placeholder-sky-300/60 dark:placeholder-sky-600/60 text-gray-700 dark:text-gray-300"
                placeholder="e.g. What value should I use for Pay To?"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendChat() } }}
                disabled={isChatting}
              />
              <Button
                size="icon"
                className="h-9 w-9 bg-sky-600 hover:bg-sky-700 text-white shrink-0"
                onClick={handleSendChat}
                disabled={!chatInput.trim() || isChatting}
              >
                <Send className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

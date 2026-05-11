"use client"
import { useState, useRef, useEffect, useCallback } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  Sparkles, ArrowLeft, Check, Loader2, ChevronRight, ChevronDown, ChevronUp,
  GitBranch, Cpu, Send, Play, RotateCcw, CheckSquare, Square, GripVertical,
  AlertCircle, CheckCircle2, XCircle, Clock, Zap, Filter, X, ArrowRight,
  RefreshCw, FileText, BarChart3, TrendingUp
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"

const API = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000") + "/api/v1"
type Phase = "discover" | "generating" | "review" | "running" | "results"
interface Msg { role: "user" | "assistant"; content: string }
interface FlowItem { name: string; description: string }  // richer flow object from backend
interface TC { id: string; name: string; description?: string | null; priority: string; steps?: unknown[]; tags?: string[] }
interface FlowGroup { flow: string; order: number; rationale: string; testCases: TC[] }
interface RunResult { testCaseId: string; name: string; status: "passed" | "failed" | "error"; duration?: number; error?: string }

const priColor: Record<string, string> = {
  high: "bg-red-50 text-red-700 border border-red-200 dark:bg-red-950/30 dark:text-red-400 dark:border-red-800",
  medium: "bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800",
  low: "bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800",
}
function PriBadge({ p }: { p: string }) {
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold capitalize ${priColor[p?.toLowerCase()] ?? "bg-slate-100 text-slate-600"}`}>{p}</span>
}
function AiBubble({ content, loading }: { content?: string; loading?: boolean }) {
  return (
    <div className="flex gap-2.5 items-start">
      <div className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center" style={{ background: "linear-gradient(135deg,#7c3aed,#4f46e5)" }}>
        <Cpu className="h-3.5 w-3.5 text-white" />
      </div>
      <div className="max-w-[88%] px-3 py-2 rounded-xl rounded-tl-none text-[12px] leading-relaxed bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300">
        {loading
          ? <span className="flex gap-1 items-center py-0.5">
              {[0, 150, 300].map(d => <span key={d} className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: `${d}ms` }} />)}
            </span>
          : content}
      </div>
    </div>
  )
}
function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] px-3 py-2 rounded-xl rounded-tr-none text-[12px] leading-relaxed text-white" style={{ background: "linear-gradient(135deg,#7c3aed,#4f46e5)" }}>
        {content}
      </div>
    </div>
  )
}

// ── Step progress bar ────────────────────────────────────────────────────────
const STEPS = [
  { id: "discover", label: "Select Flows" },
  { id: "generating", label: "Generating" },
  { id: "review", label: "Review & Filter" },
  { id: "running", label: "Run Tests" },
  { id: "results", label: "Results" },
]
function StepBar({ phase }: { phase: Phase }) {
  const idx = STEPS.findIndex(s => s.id === phase)
  return (
    <div className="flex items-center gap-0 px-8 py-4 border-b border-slate-100 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur sticky top-0 z-10">
      {STEPS.map((s, i) => (
        <div key={s.id} className="flex items-center gap-0 flex-1">
          <div className={`flex items-center gap-2 ${i <= idx ? "text-violet-600 dark:text-violet-400" : "text-slate-400"}`}>
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0 transition-all
              ${i < idx ? "bg-violet-600 text-white" : i === idx ? "bg-violet-600 text-white ring-4 ring-violet-100 dark:ring-violet-900" : "bg-slate-100 dark:bg-slate-800 text-slate-400"}`}>
              {i < idx ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </div>
            <span className={`text-xs font-semibold hidden sm:block ${i <= idx ? "" : "text-slate-400"}`}>{s.label}</span>
          </div>
          {i < STEPS.length - 1 && <div className={`flex-1 h-0.5 mx-3 transition-colors ${i < idx ? "bg-violet-400" : "bg-slate-200 dark:bg-slate-700"}`} />}
        </div>
      ))}
    </div>
  )
}

// ── Collapsible FlowGroup card ────────────────────────────────────────────────
function FlowGroupCard({
  group, groupIdx, selectedIds, onToggleTc, onToggleAll,
  showDragHint,
}: {
  group: FlowGroup; groupIdx: number
  selectedIds: Set<string>
  onToggleTc: (id: string) => void
  onToggleAll: (ids: string[], val: boolean) => void
  showDragHint?: boolean
}) {
  const [open, setOpen] = useState(true)
  const ids = group.testCases.map(t => t.id).filter(Boolean) as string[]
  const selCount = ids.filter(id => selectedIds.has(id)).length
  const allSel = ids.length > 0 && selCount === ids.length
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
      {/* Group header — div to avoid nested <button> inside <button> violation */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(v => !v)}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(v => !v) } }}
        className="w-full flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-violet-50 to-indigo-50/60 dark:from-violet-950/30 dark:to-indigo-950/20 hover:from-violet-100 hover:to-indigo-50 dark:hover:from-violet-950/50 transition-colors text-left cursor-pointer select-none">
        {showDragHint && <GripVertical className="h-4 w-4 text-slate-400 flex-shrink-0" />}
        <div className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-black text-white flex-shrink-0"
          style={{ background: "linear-gradient(135deg,#7c3aed,#4f46e5)" }}>
          {group.order}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm text-slate-800 dark:text-slate-100 truncate">{group.flow}</span>
            <Badge variant="outline" className="text-[10px] border-violet-300 text-violet-600 dark:border-violet-700 dark:text-violet-400 hidden sm:inline-flex">
              {selCount}/{ids.length} selected
            </Badge>
          </div>
          {group.rationale && <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{group.rationale}</p>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={e => { e.stopPropagation(); onToggleAll(ids, !allSel) }}
            className={`text-[11px] font-semibold px-2.5 py-1 rounded-lg transition-colors ${allSel ? "bg-violet-600 text-white" : "border border-violet-300 text-violet-600 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-400"}`}>
            {allSel ? "Deselect all" : "Select all"}
          </button>
          {open ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
        </div>
      </div>

      {/* TC rows */}
      {open && (
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {group.testCases.map((tc, i) => {
            const sel = tc.id ? selectedIds.has(tc.id) : false
            return (
              <div key={tc.id ?? i} onClick={() => tc.id && onToggleTc(tc.id)}
                className={`flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors ${sel ? "bg-violet-50/50 dark:bg-violet-950/20" : "hover:bg-slate-50 dark:hover:bg-slate-900/50"}`}>
                <div className={`mt-0.5 w-4 h-4 rounded flex items-center justify-center flex-shrink-0 border-2 transition-colors ${sel ? "bg-violet-600 border-violet-600" : "border-slate-300 dark:border-slate-600"}`}>
                  {sel && <Check className="h-2.5 w-2.5 text-white" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-[12px] font-medium leading-snug ${sel ? "text-violet-800 dark:text-violet-200" : "text-slate-700 dark:text-slate-300"}`}>{tc.name}</p>
                  {tc.description && <p className="text-[11px] text-slate-400 mt-0.5 line-clamp-1">{tc.description}</p>}
                  {tc.steps && <p className="text-[10px] text-slate-400 mt-0.5">{(tc.steps as any[]).length} steps</p>}
                </div>
                <PriBadge p={tc.priority} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function GenerateWizardPage() {
  const router = useRouter()

  // ── Core state ──────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>("discover")
  const [projectId, setProjectId] = useState("")
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
  const [projLoading, setProjLoading] = useState(false)

  // Phase 1 — discover flows
  const [flows, setFlows] = useState<FlowItem[]>([])
  const [flowsLoading, setFlowsLoading] = useState(false)
  const [selectedFlows, setSelectedFlows] = useState<Set<string>>(new Set())
  const [customFlowInput, setCustomFlowInput] = useState("")

  // Phase 2 — generating
  const [genProgress, setGenProgress] = useState(0)
  const [genMessage, setGenMessage] = useState("Initialising…")

  // Phase 3 — review
  const [groups, setGroups] = useState<FlowGroup[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [filterHistory, setFilterHistory] = useState<Msg[]>([])
  const [filterInput, setFilterInput] = useState("")
  const [filterSending, setFilterSending] = useState(false)
  const [approving, setApproving] = useState(false)
  const filterEndRef = useRef<HTMLDivElement>(null)
  const filterInputRef = useRef<HTMLInputElement>(null)

  // Phase 4 — running
  const [runResults, setRunResults] = useState<RunResult[]>([])
  const [runIdx, setRunIdx] = useState(0)
  const [runTotal, setRunTotal] = useState(0)
  const [running, setRunning] = useState(false)
  const [runCurrentTcName, setRunCurrentTcName] = useState<string>("")

  // Phase 5 — results
  const [finalGroups, setFinalGroups] = useState<FlowGroup[]>([])

  // ── Load projects ────────────────────────────────────────────────────────────
  useEffect(() => {
    setProjLoading(true)
    fetch(`${API}/projects`).then(r => r.ok ? r.json() : Promise.reject())
      .then(d => {
        const list = Array.isArray(d) ? d : d.items ?? []
        setProjects(list.map((p: any) => ({ id: p.id, name: p.name })))
        if (list.length === 1) setProjectId(list[0].id)
      }).catch(() => { }).finally(() => setProjLoading(false))
  }, [])

  // ── Load flows ───────────────────────────────────────────────────────────────
  const loadFlows = async () => {
    if (!projectId) { toast.error("Select a project first"); return }
    setFlowsLoading(true); setFlows([]); setSelectedFlows(new Set())
    try {
      const res = await fetch(`${API}/projects/${projectId}/generate-workflows`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({})
      })
      if (!res.ok) throw new Error()
      const d = await res.json()
      // Support both legacy string[] and new {name, description}[] shapes
      const raw: unknown[] = Array.isArray(d.flows) ? d.flows : []
      const items: FlowItem[] = raw.map((f: any) =>
        typeof f === "string" ? { name: f, description: "" } : { name: f.name ?? f, description: f.description ?? "" }
      )
      setFlows(items)
    } catch { toast.error("Could not discover flows") }
    finally { setFlowsLoading(false) }
  }

  const toggleFlow = (name: string) => setSelectedFlows(prev => {
    const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n
  })

  const addCustomFlow = () => {
    const name = customFlowInput.trim()
    if (!name) return
    if (flows.some(f => f.name.toLowerCase() === name.toLowerCase())) {
      // Already exists — just select it
      setSelectedFlows(prev => { const n = new Set(prev); n.add(name); return n })
      setCustomFlowInput("")
      return
    }
    setFlows(prev => [...prev, { name, description: "Custom workflow defined by you." }])
    setSelectedFlows(prev => { const n = new Set(prev); n.add(name); return n })
    setCustomFlowInput("")
    toast.success(`Custom flow "${name}" added`)
  }

  // ── Generate suite ────────────────────────────────────────────────────────────
  const handleGenerate = async () => {
    if (selectedFlows.size === 0) { toast.error("Select at least one flow"); return }
    setPhase("generating"); setGenProgress(0); setGenMessage("Ordering flows for optimal execution…")
    try {
      // Simulate progress steps
      const progressSteps = [
        [800, 20, "Ordering flows for optimal execution…"],
        [1600, 40, "Generating test cases per flow…"],
        [2400, 65, "Grounding test steps in project metadata…"],
        [1200, 80, "Persisting test cases…"],
      ]
      let delay = 0
      for (const [ms, pct, msg] of progressSteps) {
        delay += ms as number
        setTimeout(() => { setGenProgress(pct as number); setGenMessage(msg as string) }, delay)
      }

      const res = await fetch(`${API}/projects/${projectId}/generate-test-suite`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flows: Array.from(selectedFlows) })
      })
      if (!res.ok) throw new Error("Generation failed")
      const d: { groups: FlowGroup[]; totalTestCases: number } = await res.json()

      setGroups(d.groups)
      const allIds = new Set(d.groups.flatMap(g => g.testCases.map(tc => tc.id).filter(Boolean) as string[]))
      setSelectedIds(allIds)
      setGenProgress(100); setGenMessage("Done!")
      setTimeout(() => setPhase("review"), 600)
      toast.success(`Generated ${d.totalTestCases} test cases across ${d.groups.length} flows!`)
    } catch (e: any) {
      toast.error(e?.message ?? "Generation failed"); setPhase("discover")
    }
  }

  // ── Filter chat ───────────────────────────────────────────────────────────────
  useEffect(() => { filterEndRef.current?.scrollIntoView({ behavior: "smooth" }) }, [filterHistory, filterSending])
  useEffect(() => { if (phase === "review") setTimeout(() => filterInputRef.current?.focus(), 100) }, [phase])

  const allTcs = groups.flatMap(g => g.testCases)

  const sendFilter = async (msg: string) => {
    const text = msg.trim(); if (!text || filterSending) return
    setFilterInput(""); setFilterSending(true)
    setFilterHistory(prev => [...prev, { role: "user", content: text }])
    try {
      const res = await fetch(`${API}/projects/${projectId}/filter-test-cases-chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction: text, history: filterHistory.slice(-8),
          testCases: allTcs.map(tc => ({ id: tc.id, name: tc.name, priority: tc.priority, description: tc.description })),
          currentSelectedIds: Array.from(selectedIds),
        })
      })
      if (!res.ok) throw new Error()
      const d = await res.json()
      setFilterHistory(prev => [...prev, { role: "assistant", content: d.reply }])
      if (Array.isArray(d.selectedIds)) setSelectedIds(new Set(d.selectedIds))
    } catch { setFilterHistory(prev => [...prev, { role: "assistant", content: "Sorry, I couldn't process that." }]) }
    finally { setFilterSending(false) }
  }

  const toggleTc = (id: string) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggleGroupAll = (ids: string[], val: boolean) => setSelectedIds(prev => {
    const n = new Set(prev); ids.forEach(id => val ? n.add(id) : n.delete(id)); return n
  })

  // ── Approve & generate steps ──────────────────────────────────────────────────
  const handleApprove = async () => {
    if (selectedIds.size === 0) { toast.error("Select at least one test case"); return }
    setApproving(true)
    try {
      // Delete unselected
      const allIds = groups.flatMap(g => g.testCases.map(t => t.id).filter(Boolean)) as string[]
      const toDel = allIds.filter(id => !selectedIds.has(id))
      if (toDel.length > 0) {
        await fetch(`${API}/tests/bulk-delete`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: toDel })
        })
      }
      // Generate steps for selected
      toast.info(`Generating Playwright steps for ${selectedIds.size} test cases…`)
      const sr = await fetch(`${API}/projects/${projectId}/generate-steps-for-selected`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testCaseIds: Array.from(selectedIds) })
      })
      const sData = sr.ok ? await sr.json() : null
      if (sData?.generated) toast.success(`✅ ${sData.generated} test cases ready with Playwright steps`)

      // Filter groups to only selected TCs for run view
      const filtered = groups.map(g => ({
        ...g,
        testCases: g.testCases.filter(tc => tc.id && selectedIds.has(tc.id))
      })).filter(g => g.testCases.length > 0)
      setFinalGroups(filtered)
      setRunTotal(filtered.reduce((s, g) => s + g.testCases.length, 0))
      setPhase("running")
    } catch (e: any) { toast.error(e?.message ?? "Failed to approve") }
    finally { setApproving(false) }
  }

  // ── Run test suite as flow ────────────────────────────────────────────────────
  // Terminal statuses that BullMQ / execution worker actually write to DB:
  // 'completed' = all steps passed, 'failed' = step failed, 'error' = worker crash
  const TERMINAL_STATUSES = new Set(["completed", "failed", "error", "stopped"])

  const handleRunFlow = async () => {
    setRunning(true)
    setRunResults([])
    setRunIdx(0)
    setRunCurrentTcName("")
    const orderedTcs = finalGroups.flatMap(g => g.testCases)
    const results: RunResult[] = []

    for (let i = 0; i < orderedTcs.length; i++) {
      const tc = orderedTcs[i]
      setRunIdx(i + 1)
      setRunCurrentTcName(tc.name)

      // ── Step 1: Create the test run ──────────────────────────────────────────
      let runId: string | null = null
      try {
        const createRes = await fetch(`${API}/test-runs/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ test_case_id: tc.id, interactive: false }),
        })
        if (!createRes.ok) {
          const errBody = await createRes.json().catch(() => ({ detail: `HTTP ${createRes.status}` }))
          const msg = errBody?.detail ?? errBody?.message ?? `HTTP ${createRes.status}`
          results.push({ testCaseId: tc.id!, name: tc.name, status: "error", error: msg })
          setRunResults([...results])
          continue   // skip polling, move to next TC
        }
        const runData = await createRes.json()
        runId = runData.id
      } catch (fetchErr: any) {
        results.push({ testCaseId: tc.id!, name: tc.name, status: "error", error: fetchErr?.message ?? "Network error" })
        setRunResults([...results])
        continue
      }

      // ── Step 2: Poll until terminal status ──────────────────────────────────
      let finalStatus = "pending"
      let attempts = 0
      const MAX_POLLS = 90          // 90 × 3s = 4.5 min max per TC
      const POLL_INTERVAL_MS = 3000

      while (attempts < MAX_POLLS) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
        attempts++
        try {
          const pollRes = await fetch(`${API}/test-runs/${runId}`)
          if (pollRes.ok) {
            const pollData = await pollRes.json()
            finalStatus = pollData.status ?? "running"
            if (TERMINAL_STATUSES.has(finalStatus)) break
          }
        } catch {
          // transient network error — keep polling
        }
      }

      // 'completed' is the success state from the worker
      const uiStatus: RunResult["status"] =
        finalStatus === "completed" ? "passed" :
        finalStatus === "failed"    ? "failed"  : "error"

      results.push({
        testCaseId: tc.id!,
        name: tc.name,
        status: uiStatus,
        duration: attempts * (POLL_INTERVAL_MS / 1000),
        error: uiStatus !== "passed" ? `Run status: ${finalStatus}` : undefined,
      })
      setRunResults([...results])

      // Small gap between sequential runs so Playwright can fully close
      if (i < orderedTcs.length - 1) {
        await new Promise(r => setTimeout(r, 1500))
      }
    }

    setRunning(false)
    setRunCurrentTcName("")
    setTimeout(() => setPhase("results"), 800)
  }

  // ── RENDER ──────────────────────────────────────────────────────────────────
  const passCount = runResults.filter(r => r.status === "passed").length
  const failCount = runResults.filter(r => r.status !== "passed").length
  const passRate = runResults.length > 0 ? Math.round((passCount / runResults.length) * 100) : 0

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950" style={{ background: "radial-gradient(ellipse at 10% 10%, rgba(124,58,237,0.05) 0%, transparent 50%)" }}>
      {/* Top nav */}
      <div className="border-b border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-950/90 backdrop-blur">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          <Link href="/dashboard/tests/create" className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors group">
            <ArrowLeft className="h-4 w-4 group-hover:-translate-x-0.5 transition-transform" /> Back
          </Link>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: "linear-gradient(135deg,#7c3aed,#4f46e5)" }}>
              <Sparkles className="h-3.5 w-3.5 text-white" />
            </div>
            <span className="text-sm font-bold text-slate-800 dark:text-slate-100">AI Test Suite Generator</span>
          </div>
          <div className="w-20" />
        </div>
      </div>

      <StepBar phase={phase} />

      <div className="max-w-6xl mx-auto px-6 py-8 space-y-8">

        {/* ── PHASE 1: DISCOVER ── */}
        {phase === "discover" && (
          <div className="max-w-3xl mx-auto space-y-8">
            <div className="text-center space-y-2">
              <h1 className="text-2xl font-black text-slate-800 dark:text-slate-100">Discover Business Flows</h1>
              <p className="text-sm text-slate-500 dark:text-slate-400">Select your project, discover all end-to-end journeys, then pick the ones you want to test.</p>
            </div>

            {/* Project selector */}
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Project</label>
              {projLoading
                ? <div className="flex items-center gap-2 text-sm text-slate-400 py-3"><Loader2 className="h-4 w-4 animate-spin" />Loading projects…</div>
                : <select value={projectId} onChange={e => { setProjectId(e.target.value); setFlows([]); setSelectedFlows(new Set()) }}
                    className="w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 focus:border-transparent transition-all">
                    <option value="">— Choose a project —</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>}
            </div>

            {/* Discover button */}
            {projectId && (
              <Button onClick={loadFlows} disabled={flowsLoading} variant="outline"
                className="w-full h-12 border-2 border-violet-300 text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950/30 gap-2 text-sm font-semibold">
                {flowsLoading ? <><Loader2 className="h-4 w-4 animate-spin" />Analysing project metadata & BRD…</> : <><Zap className="h-4 w-4" />Discover Business Flows</>}
              </Button>
            )}

            {/* Flow cards (multi-select) */}
            {flows.length > 0 && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    {flows.length} flows discovered — select the ones to test
                  </p>
                  <button
                    onClick={() => setSelectedFlows(selectedFlows.size === flows.length ? new Set() : new Set(flows.map(f => f.name)))}
                    className="text-[11px] font-semibold text-violet-600 dark:text-violet-400 hover:underline">
                    {selectedFlows.size === flows.length ? "Deselect all" : "Select all"}
                  </button>
                </div>

                {/* Flow cards grid */}
                <div className="grid gap-3 sm:grid-cols-2">
                  {flows.map((f, i) => {
                    const sel = selectedFlows.has(f.name)
                    return (
                      <button key={i} onClick={() => toggleFlow(f.name)} type="button"
                        className={`text-left p-4 rounded-xl border-2 transition-all duration-150 flex flex-col gap-2 ${sel
                          ? "border-violet-500 bg-violet-50 dark:bg-violet-950/40 shadow-sm shadow-violet-100 dark:shadow-violet-900/20"
                          : "border-slate-200 dark:border-slate-700 hover:border-violet-300 dark:hover:border-violet-600 hover:bg-violet-50/30 dark:hover:bg-violet-950/10"}`}>
                        {/* Row 1: checkbox + name + icon */}
                        <div className="flex items-start gap-3">
                          <div className={`mt-0.5 w-5 h-5 rounded flex-shrink-0 flex items-center justify-center border-2 transition-colors ${sel ? "bg-violet-600 border-violet-600" : "border-slate-300 dark:border-slate-600"}`}>
                            {sel && <Check className="h-3 w-3 text-white" />}
                          </div>
                          <p className={`flex-1 text-sm font-semibold leading-snug ${sel ? "text-violet-800 dark:text-violet-200" : "text-slate-700 dark:text-slate-300"}`}>
                            {f.name}
                          </p>
                          <GitBranch className={`h-4 w-4 flex-shrink-0 mt-0.5 ${sel ? "text-violet-500" : "text-slate-300 dark:text-slate-600"}`} />
                        </div>
                        {/* Row 2: description */}
                        {f.description && (
                          <p className={`text-[11px] leading-relaxed pl-8 ${sel ? "text-violet-700/80 dark:text-violet-300/80" : "text-slate-400 dark:text-slate-500"}`}>
                            {f.description}
                          </p>
                        )}
                      </button>
                    )
                  })}
                </div>

                {/* ── Custom workflow input ── */}
                <div className="mt-2 rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-700 p-4 space-y-3">
                  <p className="text-xs font-bold text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                    <Zap className="h-3.5 w-3.5 text-violet-500" />
                    Add a custom business flow
                  </p>
                  <p className="text-[11px] text-slate-400 -mt-1">
                    Don't see a flow you need? Type any workflow name below and it will be added to the list.
                  </p>
                  <div className="flex gap-2">
                    <input
                      value={customFlowInput}
                      onChange={e => setCustomFlowInput(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addCustomFlow() } }}
                      placeholder='e.g. "Generate Invoice for Account and Send to Customer"'
                      className="flex-1 px-3 py-2.5 rounded-lg text-[12px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-violet-400 text-slate-800 dark:text-slate-200 placeholder-slate-400"
                    />
                    <Button
                      type="button"
                      onClick={addCustomFlow}
                      disabled={!customFlowInput.trim()}
                      variant="outline"
                      className="flex-shrink-0 gap-1.5 border-violet-300 text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950/30 font-semibold text-[12px]"
                    >
                      <Check className="h-3.5 w-3.5" />Add
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* CTA */}
            {selectedFlows.size > 0 && (
              <div className="sticky bottom-4">
                <Button onClick={handleGenerate} className="w-full h-12 gap-2 text-white text-sm font-bold shadow-xl shadow-violet-200 dark:shadow-violet-900/40"
                  style={{ background: "linear-gradient(135deg,#7c3aed,#4f46e5)" }}>
                  <Sparkles className="h-4 w-4" />
                  Generate Test Suite for {selectedFlows.size} flow{selectedFlows.size !== 1 ? "s" : ""}
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        )}

        {/* ── PHASE 2: GENERATING ── */}
        {phase === "generating" && (
          <div className="max-w-xl mx-auto flex flex-col items-center gap-8 py-20">
            <div className="relative">
              <div className="absolute inset-0 rounded-full animate-ping opacity-15" style={{ background: "linear-gradient(135deg,#7c3aed,#4f46e5)" }} />
              <div className="relative w-20 h-20 rounded-full flex items-center justify-center" style={{ background: "linear-gradient(135deg,#7c3aed,#4f46e5)" }}>
                <Loader2 className="h-9 w-9 text-white animate-spin" />
              </div>
            </div>
            <div className="text-center space-y-2">
              <p className="text-xl font-black text-slate-800 dark:text-slate-100">Generating your test suite…</p>
              <p className="text-sm text-slate-500 dark:text-slate-400 max-w-sm">{genMessage}</p>
            </div>
            {/* Progress bar */}
            <div className="w-full space-y-2">
              <div className="flex justify-between text-[11px] text-slate-500">
                <span>Progress</span><span>{genProgress}%</span>
              </div>
              <div className="h-2.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                <div className="h-full rounded-full transition-all duration-700" style={{ width: `${genProgress}%`, background: "linear-gradient(135deg,#7c3aed,#4f46e5)" }} />
              </div>
              <div className="flex flex-wrap gap-1.5 justify-center mt-2">
                {Array.from(selectedFlows).map(name => (
                  <span key={name} className="text-[10px] px-2 py-0.5 rounded-full bg-violet-100 dark:bg-violet-950/40 text-violet-600 dark:text-violet-300 border border-violet-200 dark:border-violet-700">{name}</span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── PHASE 3: REVIEW ── */}
        {phase === "review" && (
          <div className="space-y-6">
            {/* Summary bar */}
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h1 className="text-xl font-black text-slate-800 dark:text-slate-100">Review & Filter Test Cases</h1>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                  {groups.reduce((s, g) => s + g.testCases.length, 0)} test cases generated across {groups.length} flows.
                  AI has ordered them for optimal execution.
                </p>
              </div>
              <Badge variant="outline" className="border-violet-300 text-violet-600 bg-violet-50 dark:bg-violet-950/30 dark:border-violet-700 dark:text-violet-300 text-sm px-3 py-1">
                {selectedIds.size} selected
              </Badge>
            </div>

            {/* Two-column: groups + chat */}
            <div className="grid gap-6 lg:grid-cols-[1fr_360px]">

              {/* Flow groups */}
              <div className="space-y-4">
                {groups.map((group, gi) => (
                  <FlowGroupCard key={gi} group={group} groupIdx={gi}
                    selectedIds={selectedIds} onToggleTc={toggleTc} onToggleAll={toggleGroupAll} showDragHint />
                ))}
              </div>

              {/* AI Filter Chat sidebar */}
              <div className="lg:sticky lg:top-24 h-fit">
                <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden flex flex-col" style={{ maxHeight: "60vh" }}>
                  <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 bg-gradient-to-r from-violet-50 to-indigo-50/60 dark:from-violet-950/30 dark:to-indigo-950/20">
                    <div className="flex items-center gap-2">
                      <Cpu className="h-4 w-4 text-violet-500" />
                      <span className="text-xs font-bold text-slate-700 dark:text-slate-200">AI Filter Assistant</span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Tell me what to keep, remove, or prioritise.</p>
                  </div>
                  {/* Chat messages */}
                  <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0" style={{ maxHeight: "300px" }}>
                    {filterHistory.length === 0 && (
                      <div className="text-center py-6 space-y-2">
                        <Cpu className="h-8 w-8 text-slate-300 dark:text-slate-600 mx-auto" />
                        <p className="text-[11px] text-slate-400">Type a filter command below, e.g.{" "}
                          <span className="italic">"Keep only High priority"</span> or{" "}
                          <span className="italic">"Remove login tests"</span>
                        </p>
                      </div>
                    )}
                    {filterHistory.map((m, i) => (
                      <div key={i}>{m.role === "assistant" ? <AiBubble content={m.content} /> : <UserBubble content={m.content} />}</div>
                    ))}
                    {filterSending && <AiBubble loading />}
                    <div ref={filterEndRef} />
                  </div>
                  {/* Input */}
                  <div className="flex-shrink-0 px-3 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-black/10 flex gap-2">
                    <input ref={filterInputRef} value={filterInput} onChange={e => setFilterInput(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendFilter(filterInput) } }}
                      disabled={filterSending} placeholder='e.g. "Remove Low priority tests"'
                      className="flex-1 px-3 py-2 rounded-lg text-[12px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-violet-400 text-slate-800 dark:text-slate-200 placeholder-slate-400" />
                    <Button size="icon" className="h-9 w-9 flex-shrink-0 rounded-lg text-white"
                      style={{ background: "linear-gradient(135deg,#7c3aed,#4f46e5)" }}
                      onClick={() => sendFilter(filterInput)} disabled={!filterInput.trim() || filterSending}>
                      {filterSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            {/* Approve footer */}
            <div className="sticky bottom-0 bg-white/90 dark:bg-slate-950/90 backdrop-blur border-t border-slate-200 dark:border-slate-800 px-6 py-4 -mx-6 flex items-center justify-between gap-4 flex-wrap">
              <p className="text-sm text-slate-500 dark:text-slate-400">
                <span className="font-semibold text-slate-800 dark:text-slate-100">{selectedIds.size}</span> test cases selected. Playwright steps will be generated automatically.
              </p>
              <Button onClick={handleApprove} disabled={selectedIds.size === 0 || approving}
                className="gap-2 text-white h-11 px-8 text-sm font-bold shadow-lg shadow-violet-200 dark:shadow-violet-900/30"
                style={{ background: "linear-gradient(135deg,#7c3aed,#4f46e5)" }}>
                {approving ? <><Loader2 className="h-4 w-4 animate-spin" />Generating steps…</> : <><Sparkles className="h-4 w-4" />Approve & Prepare Run</>}
              </Button>
            </div>
          </div>
        )}

        {/* ── PHASE 4: RUNNING ── */}
        {phase === "running" && (
          <div className="max-w-3xl mx-auto space-y-6">
            <div className="text-center space-y-2">
              <h1 className="text-xl font-black text-slate-800 dark:text-slate-100">
                {running ? "Running test suite as flow…" : "All tests complete!"}
              </h1>
              {running && runCurrentTcName && (
                <div className="flex items-center justify-center gap-2 text-sm text-violet-600 dark:text-violet-400 font-medium">
                  <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
                  <span className="truncate max-w-xs">{runCurrentTcName}</span>
                </div>
              )}
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {running
                  ? `Test ${runIdx} of ${runTotal} — polling every 3s for result`
                  : `Finished ${runResults.length} tests`}
              </p>
            </div>

            {/* Overall progress */}
            <div className="space-y-1">
              <div className="h-3 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                <div className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${runTotal ? (runResults.length / runTotal) * 100 : 0}%`, background: "linear-gradient(135deg,#7c3aed,#4f46e5)" }} />
              </div>
              <div className="flex justify-between text-[10px] text-slate-400">
                <span>{runResults.length} completed / {runTotal} total</span>
                <span>{runTotal ? Math.round((runResults.length / runTotal) * 100) : 0}%</span>
              </div>
            </div>

            {/* Per-flow live results */}
            <div className="space-y-4">
              {finalGroups.map((group, gi) => (
                <div key={gi} className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                  <div className="px-4 py-2.5 bg-gradient-to-r from-violet-50 to-indigo-50/60 dark:from-violet-950/30 dark:to-indigo-950/20 flex items-center gap-2">
                    <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black text-white flex-shrink-0"
                      style={{ background: "linear-gradient(135deg,#7c3aed,#4f46e5)" }}>{group.order}</div>
                    <span className="text-xs font-bold text-slate-700 dark:text-slate-200">{group.flow}</span>
                  </div>
                  <div className="divide-y divide-slate-100 dark:divide-slate-800">
                    {group.testCases.map((tc, i) => {
                      const result = runResults.find(r => r.testCaseId === tc.id)
                      // Use name-match: this TC is actively running if it's the current one and has no result yet
                      const isCurrentlyRunning = running && !result && runCurrentTcName === tc.name
                      const isPending = !result && !isCurrentlyRunning
                      return (
                        <div key={tc.id ?? i} className={`flex items-start gap-3 px-4 py-3 transition-colors ${isCurrentlyRunning ? "bg-violet-50/50 dark:bg-violet-950/20" : ""}`}>
                          <div className="w-5 h-5 flex-shrink-0 flex items-center justify-center mt-0.5">
                            {isPending       && <div className="w-3 h-3 rounded-full bg-slate-200 dark:bg-slate-700" />}
                            {isCurrentlyRunning && <Loader2 className="h-4 w-4 animate-spin text-violet-500" />}
                            {result?.status === "passed" && <CheckCircle2 className="h-5 w-5 text-emerald-500" />}
                            {result?.status === "failed" && <XCircle className="h-5 w-5 text-red-500" />}
                            {result?.status === "error"  && <AlertCircle className="h-5 w-5 text-amber-500" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <span className={`text-[12px] font-medium ${
                              isCurrentlyRunning      ? "text-violet-700 dark:text-violet-300" :
                              result?.status === "passed" ? "text-emerald-700 dark:text-emerald-400" :
                              result?.status === "failed" ? "text-red-600 dark:text-red-400" :
                              result?.status === "error"  ? "text-amber-600 dark:text-amber-400" :
                              "text-slate-500 dark:text-slate-500"
                            }`}>{tc.name}</span>
                            {/* Show real error message under failed/error rows */}
                            {result?.error && result.status !== "passed" && (
                              <p className="text-[10px] text-red-500 dark:text-red-400 mt-0.5 truncate">{result.error}</p>
                            )}
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            {result?.duration && (
                              <span className="text-[10px] text-slate-400 flex items-center gap-1">
                                <Clock className="h-3 w-3" />{result.duration}s
                              </span>
                            )}
                            <PriBadge p={tc.priority} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>

            {/* Run / view results buttons */}
            {!running && runResults.length === 0 && (
              <div className="flex flex-col items-center gap-3 py-6">
                <Button onClick={handleRunFlow} className="gap-2 text-white h-12 px-10 text-sm font-bold shadow-xl shadow-violet-200 dark:shadow-violet-900/30"
                  style={{ background: "linear-gradient(135deg,#7c3aed,#4f46e5)" }}>
                  <Play className="h-4 w-4" />Run All Tests as Flow
                </Button>
                <button onClick={() => {
                  const ids = Array.from(selectedIds)
                  router.push(`/dashboard/tests?new_ids=${ids.join(",")}`)
                }} className="text-[12px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 underline">
                  Skip and go to Tests list
                </button>
              </div>
            )}
            {!running && runResults.length === runTotal && runTotal > 0 && (
              <div className="flex justify-center">
                <Button onClick={() => setPhase("results")} className="gap-2 text-white h-11 px-8 text-sm font-bold"
                  style={{ background: "linear-gradient(135deg,#7c3aed,#4f46e5)" }}>
                  <BarChart3 className="h-4 w-4" />View Results
                </Button>
              </div>
            )}
          </div>
        )}

        {/* ── PHASE 5: RESULTS ── */}
        {phase === "results" && (
          <div className="max-w-4xl mx-auto space-y-8">
            {/* Hero result banner */}
            <div className={`rounded-2xl p-6 flex items-center gap-5 ${passRate >= 80 ? "bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/20 border border-emerald-200 dark:border-emerald-800" : "bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/20 border border-amber-200 dark:border-amber-800"}`}>
              <div className={`w-16 h-16 rounded-2xl flex items-center justify-center flex-shrink-0 ${passRate >= 80 ? "bg-emerald-500" : "bg-amber-500"}`}>
                {passRate >= 80 ? <CheckCircle2 className="h-8 w-8 text-white" /> : <AlertCircle className="h-8 w-8 text-white" />}
              </div>
              <div className="flex-1 min-w-0">
                <h1 className="text-2xl font-black text-slate-800 dark:text-slate-100">
                  {passRate >= 80 ? "🎉 Test Suite Passed!" : passRate >= 50 ? "⚠️ Partial Pass" : "❌ Tests Need Attention"}
                </h1>
                <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                  {passCount} passed · {failCount} failed · {passRate}% pass rate
                </p>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-4xl font-black" style={{ color: passRate >= 80 ? "#10b981" : passRate >= 50 ? "#f59e0b" : "#ef4444" }}>
                  {passRate}%
                </div>
                <p className="text-[11px] text-slate-500 mt-0.5">pass rate</p>
              </div>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-3 gap-4">
              {[
                { label: "Total Tests", value: runResults.length, icon: FileText, color: "text-violet-600" },
                { label: "Passed", value: passCount, icon: CheckCircle2, color: "text-emerald-600" },
                { label: "Failed", value: failCount, icon: XCircle, color: "text-red-500" },
              ].map((s, i) => {
                const Icon = s.icon
                return (
                  <div key={i} className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 text-center bg-white dark:bg-slate-900/50">
                    <Icon className={`h-6 w-6 mx-auto mb-2 ${s.color}`} />
                    <div className="text-2xl font-black text-slate-800 dark:text-slate-100">{s.value}</div>
                    <div className="text-[11px] text-slate-500 uppercase tracking-wider">{s.label}</div>
                  </div>
                )
              })}
            </div>

            {/* Per-flow result breakdown */}
            <div className="space-y-4">
              <h2 className="text-base font-bold text-slate-700 dark:text-slate-200">Results by Business Flow</h2>
              {finalGroups.map((group, gi) => {
                const groupResults = runResults.filter(r => group.testCases.some(tc => tc.id === r.testCaseId))
                const gPass = groupResults.filter(r => r.status === "passed").length
                const gTotal = groupResults.length
                const gPct = gTotal ? Math.round((gPass / gTotal) * 100) : 0
                return (
                  <div key={gi} className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                    <div className="px-4 py-3 flex items-center gap-3 bg-gradient-to-r from-slate-50 to-slate-50/60 dark:from-slate-900 dark:to-slate-900/60">
                      <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black text-white flex-shrink-0"
                        style={{ background: "linear-gradient(135deg,#7c3aed,#4f46e5)" }}>{group.order}</div>
                      <span className="font-semibold text-sm text-slate-700 dark:text-slate-200 flex-1">{group.flow}</span>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-24 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${gPct}%`, background: gPct >= 80 ? "#10b981" : gPct >= 50 ? "#f59e0b" : "#ef4444" }} />
                        </div>
                        <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">{gPass}/{gTotal}</span>
                      </div>
                    </div>
                    <div className="divide-y divide-slate-100 dark:divide-slate-800">
                      {group.testCases.map((tc, i) => {
                        const r = runResults.find(x => x.testCaseId === tc.id)
                        return (
                          <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                            {r?.status === "passed" && <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" />}
                            {r?.status === "failed" && <XCircle className="h-4 w-4 text-red-500 flex-shrink-0" />}
                            {r?.status === "error" && <AlertCircle className="h-4 w-4 text-amber-500 flex-shrink-0" />}
                            {!r && <div className="w-4 h-4 rounded-full bg-slate-200 dark:bg-slate-700 flex-shrink-0" />}
                            <span className={`flex-1 text-[12px] font-medium ${r?.status === "passed" ? "text-emerald-700 dark:text-emerald-400" : r?.status === "failed" ? "text-red-600 dark:text-red-400" : "text-slate-600 dark:text-slate-400"}`}>
                              {tc.name}
                            </span>
                            {r?.error && <span className="text-[10px] text-red-500 truncate max-w-[200px]">{r.error}</span>}
                            <PriBadge p={tc.priority} />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-3 flex-wrap justify-center pb-8">
              <Button asChild className="gap-2 text-white h-11 px-8 text-sm font-bold shadow-lg shadow-violet-200 dark:shadow-violet-900/30"
                style={{ background: "linear-gradient(135deg,#7c3aed,#4f46e5)" }}>
                <Link href={`/dashboard/tests?new_ids=${Array.from(selectedIds).join(",")}`}>
                  <FileText className="h-4 w-4" />Go to Tests List
                </Link>
              </Button>
              <Button variant="outline" onClick={() => setPhase("running")} className="gap-2 h-11 border-2 border-violet-300 text-violet-700 dark:border-violet-700 dark:text-violet-300">
                <RotateCcw className="h-4 w-4" />Re-run Tests
              </Button>
              <Button variant="outline" asChild className="gap-2 h-11">
                <Link href="/dashboard/tests/create/generate">
                  <Sparkles className="h-4 w-4" />Generate Another Suite
                </Link>
              </Button>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}

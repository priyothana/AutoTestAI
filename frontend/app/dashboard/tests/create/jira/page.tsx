"use client"
import { useState, useEffect } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  ArrowLeft, Check, Loader2, RefreshCw, Search, Play,
  Sparkles, AlertCircle, ChevronRight, GitBranch, Zap,
  CheckSquare, Square, ArrowRight, X, ExternalLink
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"

const API = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000") + "/api/v1"

interface Project { id: string; name: string; description: string }
interface Story { key: string; summary: string; description: string }
interface GeneratedTC { id: string; name: string; storyKey: string; status: "pending" | "generating" | "done" | "error"; error?: string; stepCount?: number; runStatus?: "running" | "passed" | "failed" | "error" | null }

type Phase = "env" | "stories" | "generate"

export default function JiraImportWizard() {
  const router = useRouter()

  // Phase 1 — environment
  const [phase, setPhase] = useState<Phase>("env")
  const [projects, setProjects] = useState<Project[]>([])
  const [projLoading, setProjLoading] = useState(true)
  const [jiraStatus, setJiraStatus] = useState<Record<string, boolean>>({})
  const [selectedProject, setSelectedProject] = useState<Project | null>(null)

  // Phase 2 — stories
  const [stories, setStories] = useState<Story[]>([])
  const [storiesLoading, setStoriesLoading] = useState(false)
  const [storiesError, setStoriesError] = useState("")
  const [boardName, setBoardName] = useState("")
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [storySearch, setStorySearch] = useState("")

  // Phase 3 — generate
  const [provider, setProvider] = useState("claude")
  const [testCount, setTestCount] = useState(1)
  const [generated, setGenerated] = useState<GeneratedTC[]>([])
  const [generating, setGenerating] = useState(false)

  // Load projects + jira status
  useEffect(() => {
    setProjLoading(true)
    fetch(`${API}/projects`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(async (data: Project[]) => {
        const list = Array.isArray(data) ? data : []
        setProjects(list)
        const statuses: Record<string, boolean> = {}
        await Promise.all(list.map(async (p) => {
          try {
            const r = await fetch(`${API}/jira/projects/${p.id}/config`)
            if (r.ok) {
              const d = await r.json()
              statuses[p.id] = d.configured === true
            } else statuses[p.id] = false
          } catch { statuses[p.id] = false }
        }))
        setJiraStatus(statuses)
      })
      .catch(() => toast.error("Failed to load environments"))
      .finally(() => setProjLoading(false))
  }, [])

  const loadStories = async (project: Project) => {
    setSelectedProject(project)
    setPhase("stories")
    setStoriesLoading(true)
    setStoriesError("")
    setStories([])
    setSelectedKeys(new Set())
    setStorySearch("")
    try {
      const r = await fetch(`${API}/jira/projects/${project.id}/stories`)
      if (!r.ok) {
        const e = await r.json().catch(() => ({}))
        throw new Error(e.detail || e.message || "Failed to fetch stories")
      }
      const data = await r.json()
      const issueList = Array.isArray(data) ? data : (data.issues ?? data.values ?? [])
      const name = Array.isArray(data) ? "" : (data.board_name ?? "")
      setBoardName(name)
      setStories(issueList.map((i: any) => ({
        key: i.key ?? i.id ?? "",
        summary: i.fields?.summary ?? i.summary ?? "(no summary)",
        description: i.fields?.description ?? i.description ?? "",
      })))
    } catch (e: any) {
      setStoriesError(e.message || "Failed to fetch stories")
    } finally {
      setStoriesLoading(false)
    }
  }

  const filteredStories = stories.filter(s =>
    !storySearch || s.key.toLowerCase().includes(storySearch.toLowerCase()) ||
    s.summary.toLowerCase().includes(storySearch.toLowerCase())
  )

  const toggleStory = (key: string) => setSelectedKeys(prev => {
    const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n
  })
  const allSelected = filteredStories.length > 0 && filteredStories.every(s => selectedKeys.has(s.key))
  const toggleAll = () => {
    if (allSelected) {
      setSelectedKeys(prev => { const n = new Set(prev); filteredStories.forEach(s => n.delete(s.key)); return n })
    } else {
      setSelectedKeys(prev => { const n = new Set(prev); filteredStories.forEach(s => n.add(s.key)); return n })
    }
  }

  const handleProceedGenerate = () => {
    if (selectedKeys.size === 0) { toast.error("Select at least one story"); return }
    const sel = stories.filter(s => selectedKeys.has(s.key))
    // Create N placeholder slots per story
    const placeholders: GeneratedTC[] = []
    sel.forEach(s => {
      for (let n = 0; n < testCount; n++) {
        placeholders.push({ id: "", name: n === 0 ? s.summary : `${s.summary} — Variation ${n + 1}`, storyKey: s.key, status: "pending", runStatus: null })
      }
    })
    setGenerated(placeholders)
    setPhase("generate")
  }

  const handleGenerate = async () => {
    if (!selectedProject) return
    setGenerating(true)
    const sel = stories.filter(s => selectedKeys.has(s.key))
    // Build the full flat list: N entries per story
    const results: GeneratedTC[] = []
    sel.forEach(s => {
      for (let n = 0; n < testCount; n++) {
        results.push({ id: "", name: n === 0 ? s.summary : `${s.summary} — Variation ${n + 1}`, storyKey: s.key, status: "pending", runStatus: null })
      }
    })
    setGenerated([...results])

    for (let i = 0; i < results.length; i++) {
      const slot = results[i]
      const story = stories.find(s => s.key === slot.storyKey)!
      const varIdx = results.slice(0, i).filter(r => r.storyKey === slot.storyKey).length
      results[i] = { ...slot, status: "generating" }
      setGenerated([...results])
      try {
        const variationHint = varIdx > 0 ? `\n\nGenerate a DIFFERENT variation (variation ${varIdx + 1}) with alternative test scenarios or edge cases for the same story.` : ""
        const genRes = await fetch(`${API}/tests/generate-test-steps`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: `${story.key}: ${story.summary}\n\n${story.description || ""}${variationHint}`,
            provider,
            project_id: selectedProject.id,
          })
        })
        if (!genRes.ok) throw new Error("Generation failed")
        const genData = await genRes.json()
        const tcName = varIdx === 0 ? (genData.name || story.summary) : `${genData.name || story.summary} — Variation ${varIdx + 1}`
        // Preserve the full Jira story context in description so the test detail page
        // can pre-fill the prompt for step regeneration with a different model
        const storyContext = `${story.key}: ${story.summary}${story.description ? '\n\n' + story.description : ''}`
        const saveRes = await fetch(`${API}/tests`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: tcName,
            description: genData.description || storyContext,
            project_id: selectedProject.id,
            steps: genData.steps || [],
            priority: genData.priority || "medium",
          })
        })
        if (!saveRes.ok) throw new Error("Save failed")
        const saved = await saveRes.json()
        results[i] = { ...results[i], id: saved.id, name: tcName, status: "done", stepCount: (genData.steps || []).length }
      } catch (e: any) {
        results[i] = { ...results[i], status: "error", error: e.message }
      }
      setGenerated([...results])
    }
    setGenerating(false)
    const done = results.filter(r => r.status === "done").length
    toast.success(`✅ ${done} test case${done !== 1 ? "s" : ""} created from Jira stories!`)
  }

  const updateTC = (id: string, patch: Partial<GeneratedTC>) =>
    setGenerated(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t))

  const handleRun = async (tc: GeneratedTC) => {
    if (!tc.id) return
    updateTC(tc.id, { runStatus: "running" })
    try {
      const r = await fetch(`${API}/test-runs`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test_case_id: tc.id, interactive: false })
      })
      if (!r.ok) throw new Error("Failed to start run")
      const run = await r.json()
      toast.success(`▶ Running "${tc.name}"…`)
      // Poll for completion (max 5 min)
      const deadline = Date.now() + 5 * 60 * 1000
      const poll = setInterval(async () => {
        if (Date.now() > deadline) { clearInterval(poll); updateTC(tc.id, { runStatus: "error" }); return }
        try {
          const pr = await fetch(`${API}/test-runs/${run.id}`)
          if (!pr.ok) return
          const pd = await pr.json()
          const st = pd.status?.toLowerCase()
          if (st === "passed") { clearInterval(poll); updateTC(tc.id, { runStatus: "passed" }); toast.success(`✅ "${tc.name}" passed!`) }
          else if (st === "failed" || st === "error") { clearInterval(poll); updateTC(tc.id, { runStatus: "failed" }); toast.error(`❌ "${tc.name}" failed`) }
        } catch {}
      }, 3000)
    } catch (e: any) {
      toast.error(e.message)
      updateTC(tc.id, { runStatus: null })
    }
  }

  const doneCount = generated.filter(g => g.status === "done").length
  const allDone = generated.length > 0 && generated.every(g => g.status === "done" || g.status === "error")

  // ── Step Indicator ─────────────────────────────────────────────────
  const steps = ["Select Environment", "Choose Stories", "Generate & Run"]
  const stepIdx = phase === "env" ? 0 : phase === "stories" ? 1 : 2

  return (
    <div className="min-h-screen" style={{ background: "radial-gradient(ellipse at 15% 15%, rgba(139,92,246,0.07) 0%, transparent 55%), radial-gradient(ellipse at 85% 85%, rgba(59,130,246,0.06) 0%, transparent 55%)" }}>
      {/* Top bar */}
      <div className="border-b border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-950/90 backdrop-blur sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-6 py-3 flex items-center justify-between">
          <Link href="/dashboard/tests/create" className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors group">
            <ArrowLeft className="h-4 w-4 group-hover:-translate-x-0.5 transition-transform" /> Back
          </Link>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: "linear-gradient(135deg,#8b5cf6,#3b82f6)" }}>
              <GitBranch className="h-3.5 w-3.5 text-white" />
            </div>
            <span className="text-sm font-bold text-slate-800 dark:text-slate-100">Import from Jira</span>
          </div>
          <div className="w-20" />
        </div>
      </div>

      {/* Step bar */}
      <div className="border-b border-slate-100 dark:border-slate-800 bg-white/60 dark:bg-slate-950/60 backdrop-blur">
        <div className="max-w-4xl mx-auto px-6 py-3 flex items-center gap-0">
          {steps.map((s, i) => (
            <div key={s} className="flex items-center gap-0 flex-1">
              <div className={`flex items-center gap-2 ${i <= stepIdx ? "text-violet-600 dark:text-violet-400" : "text-slate-400"}`}>
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0 transition-all
                  ${i < stepIdx ? "bg-violet-600 text-white" : i === stepIdx ? "bg-violet-600 text-white ring-4 ring-violet-100 dark:ring-violet-900" : "bg-slate-100 dark:bg-slate-800 text-slate-400"}`}>
                  {i < stepIdx ? <Check className="h-3.5 w-3.5" /> : i + 1}
                </div>
                <span className={`text-xs font-semibold hidden sm:block ${i <= stepIdx ? "" : "text-slate-400"}`}>{s}</span>
              </div>
              {i < steps.length - 1 && <div className={`flex-1 h-0.5 mx-3 transition-colors ${i < stepIdx ? "bg-violet-400" : "bg-slate-200 dark:bg-slate-700"}`} />}
            </div>
          ))}
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">

        {/* ── PHASE 1: ENV SELECTION ── */}
        {phase === "env" && (
          <div className="space-y-6">
            <div className="text-center space-y-2">
              <h1 className="text-2xl font-black text-slate-800 dark:text-slate-100">Select an Environment</h1>
              <p className="text-sm text-slate-500 dark:text-slate-400">Choose the environment whose Jira board you want to import stories from.</p>
            </div>

            {projLoading ? (
              <div className="flex items-center justify-center py-16 gap-3 text-slate-400">
                <Loader2 className="h-5 w-5 animate-spin" /> Loading environments…
              </div>
            ) : projects.length === 0 ? (
              <div className="text-center py-16 space-y-3">
                <p className="text-slate-500">No environments found.</p>
                <Button asChild variant="outline"><Link href="/dashboard/projects/create">Create Environment</Link></Button>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {projects.map(p => {
                  const hasJira = jiraStatus[p.id] === true
                  return (
                    <button key={p.id} onClick={() => hasJira ? loadStories(p) : null}
                      disabled={!hasJira}
                      className={`text-left p-5 rounded-2xl border-2 transition-all duration-200 group
                        ${hasJira
                          ? "border-slate-200 dark:border-slate-700 hover:border-violet-400 dark:hover:border-violet-600 hover:shadow-lg hover:-translate-y-0.5 cursor-pointer bg-white dark:bg-slate-900"
                          : "border-slate-100 dark:border-slate-800 opacity-60 cursor-not-allowed bg-slate-50 dark:bg-slate-900/40"
                        }`}>
                      <div className="flex items-start justify-between mb-3">
                        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: hasJira ? "linear-gradient(135deg,#8b5cf6,#3b82f6)" : "#e2e8f0" }}>
                          <GitBranch className={`h-5 w-5 ${hasJira ? "text-white" : "text-slate-400"}`} />
                        </div>
                        {hasJira ? (
                          <Badge className="text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200">
                            <Check className="h-2.5 w-2.5 mr-1" /> Jira Connected
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] text-slate-400 border-slate-200">Not Connected</Badge>
                        )}
                      </div>
                      <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-1">{p.name}</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2">{p.description || "No description"}</p>
                      {hasJira && (
                        <div className={`mt-3 flex items-center gap-1.5 text-[12px] font-semibold text-violet-600 dark:text-violet-400 group-hover:gap-2.5 transition-all`}>
                          Browse Stories <ChevronRight className="h-3.5 w-3.5" />
                        </div>
                      )}
                      {!hasJira && (
                        <Link href={`/dashboard/projects/${p.id}`} onClick={e => e.stopPropagation()}
                          className="mt-3 flex items-center gap-1.5 text-[11px] text-blue-500 hover:underline">
                          <ExternalLink className="h-3 w-3" /> Configure Jira in Environment Settings
                        </Link>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ── PHASE 2: STORY SELECTION ── */}
        {phase === "stories" && selectedProject && (
          <div className="space-y-5">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h1 className="text-xl font-black text-slate-800 dark:text-slate-100">
                  Choose User Stories
                </h1>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                  {selectedProject.name}{boardName && ` · ${boardName}`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {selectedKeys.size > 0 && (
                  <Badge className="bg-violet-600 text-white text-xs px-3 py-1">
                    {selectedKeys.size} selected
                  </Badge>
                )}
                <Button size="sm" variant="outline" onClick={() => loadStories(selectedProject)} disabled={storiesLoading}
                  className="gap-1.5 text-xs">
                  <RefreshCw className={`h-3.5 w-3.5 ${storiesLoading ? "animate-spin" : ""}`} /> Refresh
                </Button>
              </div>
            </div>

            {storiesLoading ? (
              <div className="flex items-center justify-center py-20 gap-3 text-slate-400">
                <Loader2 className="h-6 w-6 animate-spin text-violet-500" />
                <span className="text-sm">Fetching stories from Jira…</span>
              </div>
            ) : storiesError ? (
              <div className="rounded-xl border border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-900 p-6 text-center space-y-3">
                <AlertCircle className="h-8 w-8 text-red-500 mx-auto" />
                <p className="text-sm text-red-700 dark:text-red-400">{storiesError}</p>
                <Button size="sm" variant="outline" onClick={() => loadStories(selectedProject)}>Retry</Button>
              </div>
            ) : (
              <>
                {/* Search + select-all */}
                <div className="flex items-center gap-3">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                    <input value={storySearch} onChange={e => setStorySearch(e.target.value)}
                      placeholder="Search stories by key or title…"
                      className="w-full pl-9 pr-4 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-violet-400 text-slate-800 dark:text-slate-200 placeholder-slate-400" />
                  </div>
                  <button onClick={toggleAll}
                    className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-600 dark:text-violet-400 hover:underline whitespace-nowrap">
                    {allSelected ? <><Square className="h-3.5 w-3.5" /> Deselect all</> : <><CheckSquare className="h-3.5 w-3.5" /> Select all</>}
                  </button>
                </div>

                {filteredStories.length === 0 ? (
                  <p className="text-center text-sm text-slate-400 py-10">No stories match your search.</p>
                ) : (
                  <div className="space-y-2 max-h-[460px] overflow-y-auto pr-1">
                    {filteredStories.map(s => {
                      const sel = selectedKeys.has(s.key)
                      return (
                        <div key={s.key} onClick={() => toggleStory(s.key)}
                          className={`flex items-start gap-3 p-4 rounded-xl border-2 cursor-pointer transition-all duration-150
                            ${sel ? "border-violet-500 bg-violet-50/80 dark:bg-violet-950/30 shadow-sm" : "border-slate-200 dark:border-slate-700 hover:border-violet-300 dark:hover:border-violet-700 hover:bg-violet-50/30 dark:hover:bg-violet-950/10 bg-white dark:bg-slate-900"}`}>
                          <div className={`mt-0.5 w-5 h-5 rounded-md flex-shrink-0 flex items-center justify-center border-2 transition-colors
                            ${sel ? "bg-violet-600 border-violet-600" : "border-slate-300 dark:border-slate-600"}`}>
                            {sel && <Check className="h-3 w-3 text-white" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className="text-[11px] font-mono font-bold text-violet-500 dark:text-violet-400 shrink-0">{s.key}</span>
                              <span className={`text-sm font-medium leading-snug ${sel ? "text-violet-800 dark:text-violet-200" : "text-slate-700 dark:text-slate-300"}`}>{s.summary}</span>
                            </div>
                            {s.description && (
                              <p className="text-[11px] text-slate-400 dark:text-slate-500 line-clamp-1 mt-0.5">{s.description}</p>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Footer CTA */}
                <div className="sticky bottom-0 pt-4 bg-gradient-to-t from-white dark:from-slate-950 via-white/90 dark:via-slate-950/90">
                  <Button onClick={handleProceedGenerate} disabled={selectedKeys.size === 0}
                    className="w-full h-12 gap-2 text-white text-sm font-bold shadow-xl shadow-violet-200 dark:shadow-violet-900/30"
                    style={{ background: "linear-gradient(135deg,#8b5cf6,#3b82f6)" }}>
                    <Sparkles className="h-4 w-4" />
                    Proceed with {selectedKeys.size} stor{selectedKeys.size !== 1 ? "ies" : "y"}
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── PHASE 3: GENERATE & RUN ── */}
        {phase === "generate" && (
          <div className="space-y-6">
            <div className="text-center space-y-2">
              <h1 className="text-xl font-black text-slate-800 dark:text-slate-100">Generate Test Cases</h1>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {selectedKeys.size} stor{selectedKeys.size !== 1 ? "ies" : "y"} · <span className="font-medium">{selectedProject?.name}</span>
              </p>
            </div>

            {/* Config row: model + count */}
            <div className="flex flex-wrap items-center justify-center gap-4 p-4 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">AI Model</span>
                {[
                  { id: "claude", label: "🟣 Claude Sonnet" },
                  { id: "openai", label: "🟢 GPT-4o Mini" },
                ].map(m => (
                  <button key={m.id} onClick={() => setProvider(m.id)}
                    disabled={generating}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border-2 transition-all
                      ${provider === m.id ? "border-violet-500 bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300" : "border-slate-200 dark:border-slate-700 text-slate-500 hover:border-violet-300"}`}>
                    {m.label}
                  </button>
                ))}
              </div>
              <div className="w-px h-6 bg-slate-200 dark:bg-slate-700 hidden sm:block" />
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Test Cases per Story</span>
                {[1,2,3,4,5].map(n => (
                  <button key={n} onClick={() => { if (!generating) { setTestCount(n); setGenerated(prev => { const s = stories.filter(st => selectedKeys.has(st.key)); const r: GeneratedTC[] = []; s.forEach(st => { for(let i=0;i<n;i++) r.push({ id:"", name: i===0?st.summary:`${st.summary} — Variation ${i+1}`, storyKey:st.key, status:"pending", runStatus:null }) }); return r }) } }}
                    disabled={generating}
                    className={`w-8 h-8 rounded-lg text-sm font-bold border-2 transition-all
                      ${testCount === n ? "border-violet-500 bg-violet-600 text-white" : "border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-violet-300"}`}>
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* Generate button */}
            {!generating && generated.every(g => g.status === "pending") && (
              <Button onClick={handleGenerate}
                className="w-full h-12 gap-2 text-white text-sm font-bold shadow-xl shadow-violet-200 dark:shadow-violet-900/30"
                style={{ background: "linear-gradient(135deg,#8b5cf6,#3b82f6)" }}>
                <Zap className="h-4 w-4" />
                Generate {generated.length} Test Case{generated.length !== 1 ? "s" : ""}
              </Button>
            )}

            {/* Progress list — grouped by story */}
            {generated.length > 0 && (
              <div className="space-y-2">
                {generated.map((tc, i) => {
                  const isSeparator = i === 0 || tc.storyKey !== generated[i-1].storyKey
                  return (
                    <div key={i}>
                      {isSeparator && (
                        <div className="flex items-center gap-2 mt-3 mb-1">
                          <span className="text-[10px] font-mono font-bold text-violet-500 bg-violet-50 dark:bg-violet-950/40 border border-violet-200 dark:border-violet-800 px-2 py-0.5 rounded">{tc.storyKey}</span>
                          <div className="flex-1 h-px bg-slate-100 dark:bg-slate-800" />
                        </div>
                      )}
                      <div className={`flex items-center gap-3 p-3.5 rounded-xl border transition-all
                        ${tc.status === "done" ? "border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20"
                          : tc.status === "error" ? "border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20"
                          : tc.status === "generating" ? "border-violet-300 dark:border-violet-700 bg-violet-50/50 dark:bg-violet-950/20"
                          : "border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"}`}>
                        <div className="w-5 h-5 flex-shrink-0 flex items-center justify-center">
                          {tc.status === "pending" && <div className="w-2 h-2 rounded-full bg-slate-300 dark:bg-slate-600" />}
                          {tc.status === "generating" && <Loader2 className="h-4 w-4 animate-spin text-violet-500" />}
                          {tc.status === "done" && <Check className="h-4 w-4 text-emerald-600" />}
                          {tc.status === "error" && <X className="h-4 w-4 text-red-500" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`text-sm font-medium truncate ${tc.status === "done" ? "text-slate-800 dark:text-slate-100" : tc.status === "error" ? "text-red-700 dark:text-red-400" : tc.status === "generating" ? "text-violet-700 dark:text-violet-300" : "text-slate-400"}`}>
                            {tc.name}
                          </p>
                          {tc.stepCount !== undefined && tc.status === "done" && (
                            <p className="text-[10px] text-slate-400 mt-0.5">{tc.stepCount} steps generated</p>
                          )}
                          {tc.error && <p className="text-[11px] text-red-500 mt-0.5">{tc.error}</p>}
                        </div>
                        {tc.status === "done" && tc.id && (
                          <div className="flex items-center gap-2 flex-shrink-0">
                            {/* Run result badge */}
                            {tc.runStatus === "passed" && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-300">✅ Passed</span>}
                            {tc.runStatus === "failed" && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-300">❌ Failed</span>}
                            {tc.runStatus === "error" && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 border border-orange-300">⚠ Error</span>}
                            <Link href={`/dashboard/tests/${tc.id}`} target="_blank"
                              className="flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-violet-200 dark:border-violet-800 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/30 transition-colors">
                              <ExternalLink className="h-3 w-3" /> View
                            </Link>
                            <Button size="sm" variant="outline"
                              className={`h-7 text-[11px] gap-1 transition-colors ${
                                tc.runStatus === "running" ? "border-violet-300 text-violet-600" :
                                tc.runStatus === "passed" ? "border-emerald-300 text-emerald-700 hover:bg-emerald-50" :
                                "border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-400"
                              }`}
                              disabled={tc.runStatus === "running"}
                              onClick={() => handleRun(tc)}>
                              {tc.runStatus === "running" ? <><Loader2 className="h-3 w-3 animate-spin" /> Running…</> : <><Play className="h-3 w-3" /> {tc.runStatus ? "Re-run" : "Run"}</>}
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Done actions */}
            {allDone && (
              <div className="flex items-center gap-3 flex-wrap justify-center pt-2">
                <Button onClick={() => router.push(`/dashboard/tests`)}
                  className="gap-2 text-white h-11 px-8 text-sm font-bold"
                  style={{ background: "linear-gradient(135deg,#8b5cf6,#3b82f6)" }}>
                  <Check className="h-4 w-4" />
                  View All Tests ({doneCount} created)
                </Button>
                <Button variant="outline" onClick={() => setPhase("stories")}>
                  ← Back to Stories
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

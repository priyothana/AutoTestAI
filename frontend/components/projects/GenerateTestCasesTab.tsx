"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import {
    FileText, Upload, Loader2, Sparkles, Check, X, AlertCircle,
    ChevronDown, ChevronUp, Zap, BookOpen, GitBranch,
    Database, RefreshCw, Trash2, ListChecks, CheckSquare, Square,
    Layers, Plus, ChevronRight
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { toast } from "sonner"
import { useRouter } from "next/navigation"

const API = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000") + "/api/v1"

// Module selector — replaces Focus Area tags
const CUSTOM_MODULE_SENTINEL = "__custom__"

type JobStatus = "queued" | "running" | "completed" | "failed"

interface JobPollData {
    status: JobStatus
    progress: number
    message: string
    generatedCount: number
    suiteId?: string
    testCaseIds?: string[]
    error?: string
    suiteName: string
    completedAt?: string
}

interface GeneratedTestCase {
    id: string
    name: string
    description: string | null
    priority: string
    steps: unknown[]
    status: string
}

interface Props {
    projectId: string
    projectName: string
    jiraConfigured: boolean
    metadataSynced: boolean
}

export default function GenerateTestCasesTab({ projectId, projectName, jiraConfigured, metadataSynced }: Props) {
    // ── Module selector state ─────────────────────────────────────────────────
    const [modules, setModules] = useState<string[]>([])
    const [modulesLoading, setModulesLoading] = useState(false)
    const [selectedModule, setSelectedModule] = useState<string>("")
    const [dropdownOpen, setDropdownOpen] = useState(false)
    const [customModuleMode, setCustomModuleMode] = useState(false)
    const [customModuleInput, setCustomModuleInput] = useState("")
    const dropdownRef = useRef<HTMLDivElement>(null)

    const [useJira, setUseJira] = useState(false)

    // ── BRD upload ───────────────────────────────────────────────────────────
    const [brdFile, setBrdFile] = useState<File | null>(null)
    const [brdContent, setBrdContent] = useState("")
    const [brdLoading, setBrdLoading] = useState(false)
    const [brdSaving, setBrdSaving] = useState(false)
    const [brdRestoring, setBrdRestoring] = useState(true)  // true until first fetch completes
    const [brdPersistedName, setBrdPersistedName] = useState<string | null>(null)
    const brdRef = useRef<HTMLInputElement>(null)

    // ── Existing tests upload ────────────────────────────────────────────────
    const [testsFile, setTestsFile] = useState<File | null>(null)
    const [testsContent, setTestsContent] = useState("")
    const [testsLoading, setTestsLoading] = useState(false)
    const [testsSaving, setTestsSaving] = useState(false)
    const [testsRestoring, setTestsRestoring] = useState(true)  // true until first fetch completes
    const [testsPersistedName, setTestsPersistedName] = useState<string | null>(null)
    const testsRef = useRef<HTMLInputElement>(null)

    // ── Generation job ───────────────────────────────────────────────────────
    const [generating, setGenerating] = useState(false)
    const [jobId, setJobId] = useState<string | null>(null)
    const [jobData, setJobData] = useState<JobPollData | null>(null)
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

    // ── Review panel ─────────────────────────────────────────────────────────
    const [reviewCases, setReviewCases] = useState<GeneratedTestCase[]>([])
    const [reviewLoading, setReviewLoading] = useState(false)
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
    const [confirming, setConfirming] = useState(false)
    const [generatingSteps, setGeneratingSteps] = useState(false)
    const router = useRouter()

    // ── Auto-fetch modules on mount ───────────────────────────────────────────
    useEffect(() => {
        setModulesLoading(true)
        fetch(`${API}/projects/${projectId}/generate-modules`)
            .then(r => r.ok ? r.json() : Promise.reject())
            .then(data => { if (Array.isArray(data.modules)) setModules(data.modules) })
            .catch(() => setModules([]))
            .finally(() => setModulesLoading(false))
    }, [projectId])

    // ── Close dropdown on outside click ──────────────────────────────────────
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node))
                setDropdownOpen(false)
        }
        document.addEventListener("mousedown", handler)
        return () => document.removeEventListener("mousedown", handler)
    }, [])

    // ── Jira preview ─────────────────────────────────────────────────────────
    const [jiraStories, setJiraStories] = useState<{ key: string; summary: string }[]>([])
    const [jiraLoading, setJiraLoading] = useState(false)
    const [jiraExpanded, setJiraExpanded] = useState(false)

    // ── Load persisted BRD on mount ──────────────────────────────────────────
    useEffect(() => {
        const controller = new AbortController()
        setBrdRestoring(true)
        console.log('[BRD-MOUNT] Fetching persisted BRD for project:', projectId)
        ;(async () => {
            try {
                const res = await fetch(`${API}/projects/${projectId}/brd`, { signal: controller.signal })
                console.log('[BRD-MOUNT] GET /brd status:', res.status)
                if (!res.ok) { console.warn('[BRD-MOUNT] GET /brd not OK'); return }
                const data = await res.json()
                console.log('[BRD-MOUNT] GET /brd response:', { attached: data.attached, filename: data.filename, hasContent: !!data.content, bytes: data.bytes })
                if (data.attached && data.filename && data.content) {
                    setBrdPersistedName(data.filename)
                    setBrdContent(data.content)
                    console.log('[BRD-MOUNT] Restored BRD:', data.filename)
                } else {
                    console.log('[BRD-MOUNT] No BRD attached')
                }
            } catch (e: any) {
                if (e?.name === 'AbortError') { console.log('[BRD-MOUNT] Aborted (StrictMode unmount)'); return }
                console.error('[BRD-MOUNT] Fetch error:', e)
            } finally {
                setBrdRestoring(false)
            }
        })()
        return () => controller.abort()
    }, [projectId])

    // ── Load persisted Existing Tests on mount ────────────────────────────────
    useEffect(() => {
        const controller = new AbortController()
        setTestsRestoring(true)
        ;(async () => {
            try {
                const res = await fetch(`${API}/projects/${projectId}/existing-tests`, { signal: controller.signal })
                if (!res.ok) return
                const data = await res.json()
                if (data.attached && data.filename && data.content) {
                    setTestsPersistedName(data.filename)
                    setTestsContent(data.content)
                }
            } catch (e: any) {
                if (e?.name === 'AbortError') return  // unmounted — ignore
            } finally {
                setTestsRestoring(false)
            }
        })()
        return () => controller.abort()
    }, [projectId])

    // ── Cleanup ──────────────────────────────────────────────────────────────
    useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

    // ── File reader helper ───────────────────────────────────────────────────
    // Reads plain-text formats (txt, csv, json, md) as UTF-8 text.
    // Rejects binary formats (.docx, .pdf, .xlsx) with a descriptive error—
    // these are ZIP/binary containers that produce garbage when read as text.
    const readDocumentAsText = (file: File): Promise<string> => {
        const name = file.name.toLowerCase()
        const isBinary = name.endsWith('.docx') || name.endsWith('.doc') ||
                         name.endsWith('.pdf')  || name.endsWith('.xlsx') ||
                         name.endsWith('.xls')
        if (isBinary) {
            return Promise.reject(
                new Error(
                    `".${name.split('.').pop()}" files are binary and cannot be read as text. ` +
                    `Please save as .txt or .md and re-upload.`
                )
            )
        }
        return new Promise((res, rej) => {
            const r = new FileReader()
            r.onload = () => res(r.result as string)
            r.onerror = rej
            r.readAsText(file)
        })
    }

    const handleBrdFile = async (file: File) => {
        // Pre-check: warn if file is too large (5 MB soft warning)
        const MB5 = 5 * 1024 * 1024
        if (file.size > MB5) {
            toast.warning(`File is ${(file.size / 1024 / 1024).toFixed(1)} MB — only the first ~200 KB will be stored.`)
        }

        console.log('[BRD] handleBrdFile called:', file.name, file.size, 'bytes')
        setBrdFile(file); setBrdLoading(true)
        try {
            const rawText = await readDocumentAsText(file)
            // Sanitize: strip null bytes and non-printable chars (protection against renamed binary files)
            const text = rawText.replace(/\0/g, '').replace(/[\x01-\x08\x0E-\x1F]/g, '')
            console.log('[BRD] File read OK, text length:', text.length, 'raw length:', rawText.length)
            
            if (text.length < 10) {
                toast.error("BRD file appears empty or contains only binary data.")
                setBrdFile(null)
                setBrdLoading(false)
                return
            }
            
            setBrdContent(text)
            setBrdPersistedName(null)
            setBrdSaving(true)
            try {
                const url = `${API}/projects/${projectId}/brd`
                console.log('[BRD] POST to:', url)
                let bodyStr: string
                try {
                    bodyStr = JSON.stringify({ filename: file.name, content: text })
                } catch (jsonErr: any) {
                    console.error('[BRD] JSON.stringify failed:', jsonErr)
                    toast.error(`BRD content cannot be serialized: ${jsonErr?.message ?? 'encoding error'}`)
                    setBrdSaving(false)
                    setBrdLoading(false)
                    return
                }
                console.log('[BRD] Request body size:', bodyStr.length, 'bytes')
                const res = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: bodyStr,
                })
                console.log('[BRD] POST response:', res.status, res.statusText)
                if (res.ok) {
                    setBrdPersistedName(file.name)
                    toast.success("BRD saved — it will persist across sessions.")
                } else {
                    const errBody = await res.json().catch(() => ({}))
                    const detail = errBody?.detail ?? errBody?.message ?? `HTTP ${res.status}`
                    console.error('[BRD] POST failed:', res.status, detail)
                    toast.error(`BRD could not be saved: ${detail}`)
                }
            } catch (e: any) {
                console.error('[BRD] POST fetch error:', e)
                toast.error(`BRD save failed: ${e?.message ?? "network error"}`)
            } finally {
                setBrdSaving(false)
            }
        } catch (e: any) {
            console.error('[BRD] File read error:', e)
            toast.error(e?.message ?? "Could not read BRD file")
            setBrdFile(null)
        }
        finally { setBrdLoading(false) }
    }

    const handleRemoveBrd = async () => {
        setBrdFile(null)
        setBrdContent("")
        setBrdPersistedName(null)
        try {
            await fetch(`${API}/projects/${projectId}/brd`, { method: "DELETE" })
        } catch { /* silent */ }
    }

    const handleTestsFile = async (file: File) => {
        const MB5 = 5 * 1024 * 1024
        if (file.size > MB5) {
            toast.warning(`File is ${(file.size / 1024 / 1024).toFixed(1)} MB — only the first ~200 KB will be stored.`)
        }

        console.log('[TESTS] handleTestsFile called:', file.name, file.size, 'bytes')
        setTestsFile(file); setTestsLoading(true)
        try {
            const rawText = await readDocumentAsText(file)
            const text = rawText.replace(/\0/g, '').replace(/[\x01-\x08\x0E-\x1F]/g, '')
            console.log('[TESTS] File read OK, text length:', text.length)

            if (text.length < 10) {
                toast.error("Tests file appears empty or contains only binary data.")
                setTestsFile(null)
                setTestsLoading(false)
                return
            }

            setTestsContent(text)
            setTestsPersistedName(null)
            setTestsSaving(true)
            try {
                let bodyStr: string
                try {
                    bodyStr = JSON.stringify({ filename: file.name, content: text })
                } catch (jsonErr: any) {
                    console.error('[TESTS] JSON.stringify failed:', jsonErr)
                    toast.error(`Tests content cannot be serialized: ${jsonErr?.message ?? 'encoding error'}`)
                    setTestsSaving(false)
                    setTestsLoading(false)
                    return
                }
                const res = await fetch(`${API}/projects/${projectId}/existing-tests`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: bodyStr,
                })
                console.log('[TESTS] POST response:', res.status, res.statusText)
                if (res.ok) {
                    setTestsPersistedName(file.name)
                    toast.success("Existing tests doc saved — it will persist across sessions.")
                } else {
                    const errBody = await res.json().catch(() => ({}))
                    const detail = errBody?.detail ?? errBody?.message ?? `HTTP ${res.status}`
                    toast.error(`Tests doc could not be saved: ${detail}`)
                }
            } catch (e: any) {
                console.error('[TESTS] POST fetch error:', e)
                toast.error(`Tests doc save failed: ${e?.message ?? "network error"}`)
            } finally {
                setTestsSaving(false)
            }
        } catch (e: any) {
            console.error('[TESTS] File read error:', e)
            toast.error(e?.message ?? "Could not read file")
            setTestsFile(null)
        }
        finally { setTestsLoading(false) }
    }

    const handleRemoveTests = async () => {
        setTestsFile(null)
        setTestsContent("")
        setTestsPersistedName(null)
        try {
            await fetch(`${API}/projects/${projectId}/existing-tests`, { method: "DELETE" })
        } catch { /* silent */ }
    }

    const fetchJiraPreview = async () => {
        if (!jiraConfigured) return
        setJiraLoading(true)
        try {
            const res = await fetch(`${API}/projects/${projectId}/jira/stories-for-generation`)
            if (res.ok) {
                const data = await res.json()
                setJiraStories((data.stories ?? []).slice(0, 10))
                setJiraExpanded(true)
            }
        } catch { /* silent */ }
        finally { setJiraLoading(false) }
    }

    // Module selection helpers
    const handleSelectModule = (mod: string) => {
        if (mod === CUSTOM_MODULE_SENTINEL) {
            setCustomModuleMode(true)
            setDropdownOpen(false)
        } else {
            setSelectedModule(mod)
            setCustomModuleMode(false)
            setDropdownOpen(false)
        }
    }
    const handleConfirmCustomModule = () => {
        const name = customModuleInput.trim()
        if (name) {
            setSelectedModule(name)
            if (!modules.includes(name)) setModules(prev => [name, ...prev])
        }
        setCustomModuleMode(false)
        setCustomModuleInput("")
    }

    // ── Fetch generated test cases for review ────────────────────────────────
    const fetchReviewCases = useCallback(async (ids: string[]) => {
        setReviewLoading(true)
        try {
            const res = await fetch(`${API}/tests/bulk-fetch`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ids }),
            })
            if (res.ok) {
                const data: GeneratedTestCase[] = await res.json()
                setReviewCases(data)
                setSelectedIds(new Set(data.map(tc => tc.id)))
            }
        } catch { toast.error("Could not load generated test cases") }
        finally { setReviewLoading(false) }
    }, [])

    // ── Start polling ────────────────────────────────────────────────────────
    const startPolling = (id: string) => {
        if (pollRef.current) clearInterval(pollRef.current)
        pollRef.current = setInterval(async () => {
            try {
                const res = await fetch(`${API}/projects/${projectId}/generate-test-cases/status/${id}`)
                if (!res.ok) return
                const data: JobPollData = await res.json()
                setJobData(data)
                if (data.status === "completed") {
                    clearInterval(pollRef.current!); pollRef.current = null
                    setGenerating(false)
                    toast.success(`🎉 Generated ${data.generatedCount} test cases!`)
                    if (data.testCaseIds?.length) fetchReviewCases(data.testCaseIds)
                } else if (data.status === "failed") {
                    clearInterval(pollRef.current!); pollRef.current = null
                    setGenerating(false)
                    toast.error(`Generation failed: ${data.error}`)
                }
            } catch { /* ignore */ }
        }, 2500)
        setTimeout(() => {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; setGenerating(false) }
        }, 10 * 60 * 1000)
    }

    // ── Review selection helpers ──────────────────────────────────────────────
    const allSelected = reviewCases.length > 0 && selectedIds.size === reviewCases.length
    const toggleAll = () => setSelectedIds(allSelected ? new Set() : new Set(reviewCases.map(tc => tc.id)))
    const toggleOne = (id: string) => setSelectedIds(prev => {
        const next = new Set(prev)
        next.has(id) ? next.delete(id) : next.add(id)
        return next
    })

    // ── Add selected to Tests: delete unselected, generate steps, then navigate ─
    const handleAddSelected = async () => {
        if (selectedIds.size === 0) { toast.error("Select at least one test case"); return }
        setConfirming(true)
        try {
            // 1. Delete unselected test cases
            const toDelete = reviewCases.map(tc => tc.id).filter(id => !selectedIds.has(id))
            if (toDelete.length > 0) {
                await fetch(`${API}/tests/bulk-delete`, {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ids: toDelete }),
                })
            }

            // 2. Generate steps for the selected test cases
            setGeneratingSteps(true)
            toast.info(`⚙️ Generating test steps for ${selectedIds.size} test case${selectedIds.size !== 1 ? "s" : ""}…`)
            const stepsRes = await fetch(`${API}/projects/${projectId}/generate-steps-for-selected`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ testCaseIds: Array.from(selectedIds), selectedModule: selectedModule || undefined }),
            })
            if (stepsRes.ok) {
                const stepsData = await stepsRes.json()
                toast.success(`✅ ${stepsData.generated} test case${stepsData.generated !== 1 ? "s" : ""} with steps added to Tests!`)
                if (stepsData.failed > 0) {
                    toast.warning(`⚠️ ${stepsData.failed} test case${stepsData.failed !== 1 ? "s" : ""} could not get steps generated.`)
                }
            } else {
                toast.success(`✅ ${selectedIds.size} test case${selectedIds.size !== 1 ? "s" : ""} added to Tests!`)
            }

            // 3. Navigate to Tests tab
            router.push(`/dashboard/tests?project=${projectId}`)
        } catch { toast.error("Failed to confirm selection") }
        finally { setConfirming(false); setGeneratingSteps(false) }
    }

    // ── Trigger generation ───────────────────────────────────────────────────
    const handleGenerate = async () => {
        if (!selectedModule) { toast.error("Please select a module first"); return }
        setGenerating(true); setJobData(null); setJobId(null)
        try {
            const res = await fetch(`${API}/projects/${projectId}/generate-test-cases`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    selectedModule,
                    useJira,
                    brdContent: brdContent || undefined,
                    existingTestsContent: testsContent || undefined,
                }),
            })
            const data = await res.json()
            if (!res.ok) { toast.error(data.detail || "Failed to start generation"); setGenerating(false); return }
            setJobId(data.jobId)
            setJobData({ status: "queued", progress: 0, message: "Queued…", generatedCount: 0, suiteName: data.suiteName })
            startPolling(data.jobId)
            toast.success(`Generating test cases for "${selectedModule}"…`)
        } catch { toast.error("Network error — is the API running?"); setGenerating(false) }
    }

    const sourcesActive = (brdContent ? 1 : 0) + (testsContent ? 1 : 0) + (useJira && jiraConfigured ? 1 : 0) + (metadataSynced ? 1 : 0)
    const isAddingSelected = confirming || generatingSteps
    const activeModuleLabel = selectedModule || ""

    // ── Display helpers ────────────────────────────────────────────────────────
    const brdDisplayName   = brdFile?.name ?? brdPersistedName
    const brdAttached      = Boolean(brdContent)
    const testsDisplayName = testsFile?.name ?? testsPersistedName
    const testsAttached    = Boolean(testsContent)

    // ── Render ───────────────────────────────────────────────────────────────
    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-start justify-between">
                <div>
                    <h3 className="text-xl font-semibold flex items-center gap-2">
                        <Sparkles className="h-5 w-5 text-violet-500" />
                        AI Test Case Generation
                    </h3>
                    <p className="text-sm text-muted-foreground mt-1">
                        Combine project metadata, Jira stories, and documents to generate executable test cases instantly.
                    </p>
                </div>
                <Badge
                    variant="outline"
                    className={sourcesActive >= 2
                        ? "border-emerald-400 text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30"
                        : "border-amber-400 text-amber-600 bg-amber-50 dark:bg-amber-950/30"}
                >
                    {sourcesActive} source{sourcesActive !== 1 ? "s" : ""} active
                </Badge>
            </div>

            {/* Source grid */}
            <div className="grid gap-4 md:grid-cols-2">
                {/* Source 4 — Metadata (always on) */}
                <SourceCard
                    icon={<Database className="h-4 w-4 text-blue-500" />}
                    title="Project Metadata"
                    badge={metadataSynced ? "Connected" : "No sync yet"}
                    badgeColor={metadataSynced ? "green" : "amber"}
                    description={metadataSynced
                        ? "RAG embeddings ready — fields, pages & values will be injected automatically."
                        : "Sync metadata first from the Integration tab for best results."}
                    alwaysOn
                />

                {/* Source 3 — Jira */}
                <SourceCard
                    icon={<GitBranch className="h-4 w-4 text-purple-500" />}
                    title="Jira User Stories"
                    badge={jiraConfigured ? "Configured" : "Not connected"}
                    badgeColor={jiraConfigured ? "purple" : "gray"}
                    description={jiraConfigured
                        ? "Acceptance criteria from your board will be used to derive test scenarios."
                        : "Connect Jira from the Jira Integration tab."}
                    action={jiraConfigured && (
                        <div className="space-y-3 mt-3">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox" checked={useJira}
                                    onChange={e => { setUseJira(e.target.checked); if (e.target.checked) fetchJiraPreview() }}
                                    className="h-4 w-4 rounded accent-purple-600"
                                />
                                <span className="text-sm font-medium">Include Jira stories in generation</span>
                            </label>
                            {useJira && (
                                <Button variant="ghost" size="sm" onClick={fetchJiraPreview} disabled={jiraLoading}
                                    className="text-purple-600 hover:text-purple-700 h-7 px-2">
                                    {jiraLoading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                                    Preview stories
                                </Button>
                            )}
                            {jiraStories.length > 0 && (
                                <div className="space-y-1">
                                    <button onClick={() => setJiraExpanded(v => !v)}
                                        className="text-xs text-muted-foreground flex items-center gap-1 hover:text-foreground">
                                        {jiraExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                                        {jiraStories.length} stories found
                                    </button>
                                    {jiraExpanded && (
                                        <div className="max-h-36 overflow-y-auto space-y-1 rounded-md border border-purple-200 dark:border-purple-900 p-2">
                                            {jiraStories.map(s => (
                                                <div key={s.key} className="text-xs flex gap-1.5">
                                                    <span className="font-mono text-purple-500 shrink-0">{s.key}</span>
                                                    <span className="text-muted-foreground truncate">{s.summary}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                />

                {/* Source 1 — BRD */}
                <SourceCard
                    icon={<BookOpen className="h-4 w-4 text-orange-500" />}
                    title="BRD / Functional Specification"
                    badge={brdRestoring ? "Loading…" : brdAttached ? brdPersistedName ? "Saved" : "Loaded" : "Optional"}
                    badgeColor={brdRestoring ? "gray" : brdAttached ? "orange" : "gray"}
                    description="Upload a requirements document (TXT, MD, CSV) to inform test coverage. Binary formats like PDF/DOCX must be converted to .txt first."
                    action={
                        <div className="mt-3 space-y-2">
                            <input ref={brdRef} type="file" accept=".txt,.md,.csv"
                                className="hidden" onChange={e => { if (e.target.files?.[0]) handleBrdFile(e.target.files[0]) }} />
                            {brdRestoring ? (
                                <div className="flex items-center gap-2 text-sm text-muted-foreground px-1 py-2">
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    <span>Restoring saved document…</span>
                                </div>
                            ) : !brdAttached ? (
                                <button onClick={() => brdRef.current?.click()}
                                    className="flex items-center gap-2 text-sm border-2 border-dashed border-orange-300 dark:border-orange-800 rounded-lg px-4 py-3 w-full hover:border-orange-400 hover:bg-orange-50 dark:hover:bg-orange-950/20 transition-colors text-orange-600 dark:text-orange-400">
                                    <Upload className="h-4 w-4" /> Click to upload document
                                </button>
                            ) : (
                                <div className="flex items-center gap-2 text-sm bg-orange-50 dark:bg-orange-950/20 border border-orange-200 dark:border-orange-900 rounded-lg px-3 py-2">
                                    {(brdLoading || brdSaving) ? <Loader2 className="h-4 w-4 animate-spin text-orange-500" /> : <Check className="h-4 w-4 text-orange-600" />}
                                    <span className="truncate flex-1 text-orange-700 dark:text-orange-300">{brdDisplayName}</span>
                                    {brdPersistedName && !brdSaving && (
                                        <span className="text-xs text-orange-500 shrink-0">● persisted</span>
                                    )}
                                    <button onClick={handleRemoveBrd} className="text-muted-foreground hover:text-red-500">
                                        <X className="h-4 w-4" />
                                    </button>
                                </div>
                            )}
                        </div>
                    }
                />

                {/* Source 2 — Existing tests */}
                <SourceCard
                    icon={<FileText className="h-4 w-4 text-teal-500" />}
                    title="Existing Test Cases"
                    badge={testsRestoring ? "Loading…" : testsAttached ? testsPersistedName ? "Saved" : "Loaded" : "Optional"}
                    badgeColor={testsRestoring ? "gray" : testsAttached ? "teal" : "gray"}
                    description="Upload existing tests (TXT, CSV, JSON, MD) to complement coverage and match style."
                    action={
                        <div className="mt-3 space-y-2">
                            <input ref={testsRef} type="file" accept=".txt,.csv,.json,.md"
                                className="hidden" onChange={e => { if (e.target.files?.[0]) handleTestsFile(e.target.files[0]) }} />
                            {testsRestoring ? (
                                <div className="flex items-center gap-2 text-sm text-muted-foreground px-1 py-2">
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    <span>Restoring saved document…</span>
                                </div>
                            ) : !testsAttached ? (
                                <button onClick={() => testsRef.current?.click()}
                                    className="flex items-center gap-2 text-sm border-2 border-dashed border-teal-300 dark:border-teal-800 rounded-lg px-4 py-3 w-full hover:border-teal-400 hover:bg-teal-50 dark:hover:bg-teal-950/20 transition-colors text-teal-600 dark:text-teal-400">
                                    <Upload className="h-4 w-4" /> Click to upload test cases
                                </button>
                            ) : (
                                <div className="flex items-center gap-2 text-sm bg-teal-50 dark:bg-teal-950/20 border border-teal-200 dark:border-teal-900 rounded-lg px-3 py-2">
                                    {(testsLoading || testsSaving) ? <Loader2 className="h-4 w-4 animate-spin text-teal-500" /> : <Check className="h-4 w-4 text-teal-600" />}
                                    <span className="truncate flex-1 text-teal-700 dark:text-teal-300">{testsDisplayName}</span>
                                    {testsPersistedName && !testsSaving && (
                                        <span className="text-xs text-teal-500 shrink-0">● persisted</span>
                                    )}
                                    <button onClick={handleRemoveTests} className="text-muted-foreground hover:text-red-500">
                                        <X className="h-4 w-4" />
                                    </button>
                                </div>
                            )}
                        </div>
                    }
                />
            </div>

            {/* ── Module Selector ─────────────────────────────────────────── */}
            <div className="rounded-xl border-2 border-violet-200 dark:border-violet-800 bg-gradient-to-br from-violet-50/60 to-purple-50/40 dark:from-violet-950/20 dark:to-purple-950/10 p-5 space-y-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Layers className="h-4 w-4 text-violet-500" />
                        <span className="text-sm font-semibold text-violet-800 dark:text-violet-200">Select Module</span>
                        <span className="text-xs text-muted-foreground">(required — test cases will focus on this area)</span>
                    </div>
                    {modulesLoading && <span className="flex items-center gap-1 text-xs text-violet-500"><Loader2 className="h-3 w-3 animate-spin" />Generating modules…</span>}
                </div>

                {/* Dropdown trigger */}
                {!customModuleMode ? (
                    <div className="relative" ref={dropdownRef}>
                        <button
                            onClick={() => setDropdownOpen(v => !v)}
                            className={`w-full flex items-center justify-between px-4 py-3 rounded-lg border-2 transition-all duration-150 text-left ${
                                selectedModule
                                    ? "border-violet-500 bg-white dark:bg-violet-950/30 shadow-sm shadow-violet-100 dark:shadow-violet-900/20"
                                    : "border-dashed border-violet-300 dark:border-violet-700 bg-white/60 dark:bg-black/10 hover:border-violet-400"
                            }`}>
                            <span className={`flex items-center gap-2 text-sm font-medium ${
                                selectedModule ? "text-violet-700 dark:text-violet-200" : "text-muted-foreground"
                            }`}>
                                {selectedModule
                                    ? <><ChevronRight className="h-4 w-4 text-violet-500" />{selectedModule}</>
                                    : "— Choose a module —"}
                            </span>
                            <ChevronDown className={`h-4 w-4 text-violet-400 transition-transform duration-200 ${dropdownOpen ? "rotate-180" : ""}`} />
                        </button>

                        {dropdownOpen && (
                            <div className="mt-2 w-full bg-white dark:bg-gray-900 border border-violet-200 dark:border-violet-800 rounded-xl shadow-sm overflow-hidden">
                                <div className="max-h-64 overflow-y-auto">
                                    {modulesLoading ? (
                                        <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground text-sm">
                                            <Loader2 className="h-4 w-4 animate-spin" /> Generating module list…
                                        </div>
                                    ) : modules.length === 0 ? (
                                        <div className="py-4 text-center text-sm text-muted-foreground">No modules found — add a custom one below</div>
                                    ) : (
                                        modules.map((mod, i) => (
                                            <button key={i} onClick={() => handleSelectModule(mod)}
                                                className={`w-full text-left px-4 py-2.5 text-sm transition-colors flex items-center gap-2 ${
                                                    selectedModule === mod
                                                        ? "bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-200 font-medium"
                                                        : "hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300"
                                                }`}>
                                                {selectedModule === mod && <Check className="h-3.5 w-3.5 text-violet-500 shrink-0" />}
                                                <span className={selectedModule === mod ? "" : "pl-5"}>{mod}</span>
                                            </button>
                                        ))
                                    )}
                                </div>
                                {/* Add Custom Module */}
                                <div className="border-t border-violet-100 dark:border-violet-800">
                                    <button onClick={() => handleSelectModule(CUSTOM_MODULE_SENTINEL)}
                                        className="w-full text-left px-4 py-2.5 text-sm text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/20 flex items-center gap-2 font-medium">
                                        <Plus className="h-3.5 w-3.5" /> Add Custom Module
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                ) : (
                    /* Custom module input */
                    <div className="flex gap-2">
                        <input
                            autoFocus
                            type="text"
                            placeholder="e.g. Invoice Approval Workflow, Payment Gateway Integration…"
                            value={customModuleInput}
                            onChange={e => setCustomModuleInput(e.target.value)}
                            onKeyDown={e => { if (e.key === "Enter") handleConfirmCustomModule(); if (e.key === "Escape") { setCustomModuleMode(false); setCustomModuleInput("") } }}
                            className="flex-1 px-3 py-2 text-sm border-2 border-violet-300 dark:border-violet-700 rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
                        />
                        <Button size="sm" onClick={handleConfirmCustomModule} disabled={!customModuleInput.trim()}
                            className="bg-violet-600 hover:bg-violet-700 shrink-0">
                            <Check className="h-4 w-4 mr-1" /> Use
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => { setCustomModuleMode(false); setCustomModuleInput("") }}>
                            <X className="h-4 w-4" />
                        </Button>
                    </div>
                )}

                {/* Selected module preview chip */}
                {selectedModule && !customModuleMode && (
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Generating for:</span>
                        <span className="inline-flex items-center gap-1.5 bg-violet-600 text-white text-xs font-medium px-3 py-1 rounded-full">
                            <Layers className="h-3 w-3" />{selectedModule}
                            <button onClick={() => setSelectedModule("")} className="ml-1 hover:text-violet-200"><X className="h-3 w-3" /></button>
                        </span>
                    </div>
                )}
            </div>

            {/* CTA */}
            <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="text-sm text-muted-foreground space-y-0.5">
                    <p>Using <span className="font-semibold text-violet-600">{sourcesActive}</span> input source{sourcesActive !== 1 ? "s" : ""} as context</p>
                    {activeModuleLabel && <p className="text-xs">Focused on: <span className="font-semibold text-violet-600">{activeModuleLabel}</span></p>}
                </div>
                <Button
                    size="lg"
                    disabled={generating || !selectedModule}
                    onClick={handleGenerate}
                    className="bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 text-white shadow-lg shadow-violet-200 dark:shadow-violet-900/30 px-8 disabled:opacity-50"
                >
                    {generating
                        ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Generating…</>
                        : <><Zap className="mr-2 h-4 w-4" />{selectedModule ? `Generate for "${selectedModule.slice(0,22)}${selectedModule.length>22?'…':''}"` : "Select a Module First"}</>}
                </Button>
            </div>

            {/* Progress / Results */}
            {jobData && (
                <JobStatusPanel
                    jobData={jobData}
                    reviewLoading={reviewLoading}
                    reviewCases={reviewCases}
                    selectedIds={selectedIds}
                    allSelected={allSelected}
                    confirming={confirming}
                    onToggleAll={toggleAll}
                    onToggleOne={toggleOne}
                    onAddSelected={handleAddSelected}
                    isAddingSelected={isAddingSelected}
                    generatingSteps={generatingSteps}
                />
            )}
        </div>
    )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SourceCard({ icon, title, badge, badgeColor, description, action, alwaysOn }: {
    icon: React.ReactNode
    title: string
    badge: string
    badgeColor: "green" | "amber" | "purple" | "orange" | "gray" | "teal"
    description: string
    action?: React.ReactNode | false
    alwaysOn?: boolean
}) {
    const colors: Record<string, string> = {
        green: "bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-900",
        amber: "bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900",
        purple: "bg-purple-50 dark:bg-purple-950/20 border-purple-200 dark:border-purple-900",
        orange: "bg-orange-50 dark:bg-orange-950/20 border-orange-200 dark:border-orange-900",
        teal: "bg-teal-50 dark:bg-teal-950/20 border-teal-200 dark:border-teal-900",
        gray: "bg-gray-50 dark:bg-gray-900/20 border-gray-200 dark:border-gray-800",
    }
    const badgeColors: Record<string, string> = {
        green: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
        amber: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
        purple: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
        orange: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
        teal: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
        gray: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
    }
    return (
        <div className={`rounded-xl border p-4 ${colors[badgeColor]}`}>
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 font-medium text-sm">{icon}{title}</div>
                <div className="flex items-center gap-1.5">
                    {alwaysOn && <span className="text-xs text-muted-foreground">Always on</span>}
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${badgeColors[badgeColor]}`}>{badge}</span>
                </div>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
            {action}
        </div>
    )
}

interface ReviewPanelProps {
    jobData: JobPollData
    reviewLoading: boolean
    reviewCases: GeneratedTestCase[]
    selectedIds: Set<string>
    allSelected: boolean
    confirming: boolean
    isAddingSelected: boolean
    generatingSteps: boolean
    onToggleAll: () => void
    onToggleOne: (id: string) => void
    onAddSelected: () => void
}

const PRIORITY_COLORS: Record<string, string> = {
    high: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    low: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
}

function JobStatusPanel({
    jobData, reviewLoading, reviewCases, selectedIds, allSelected,
    confirming, isAddingSelected, generatingSteps, onToggleAll, onToggleOne, onAddSelected,
}: ReviewPanelProps) {
    const isRunning = jobData.status === "queued" || jobData.status === "running"
    const isDone = jobData.status === "completed"
    const isFailed = jobData.status === "failed"

    return (
        <div className="space-y-4">
            {/* Status card */}
            <Card className={`border-2 transition-colors duration-500 ${
                isDone ? "border-emerald-400 dark:border-emerald-700"
                : isFailed ? "border-red-400 dark:border-red-700"
                : "border-violet-300 dark:border-violet-800"}`}>
                <CardHeader className="pb-3">
                    <div className="flex items-center gap-3">
                        {isRunning && <Loader2 className="h-5 w-5 animate-spin text-violet-500" />}
                        {isDone && <Check className="h-5 w-5 text-emerald-500" />}
                        {isFailed && <AlertCircle className="h-5 w-5 text-red-500" />}
                        <div className="flex-1">
                            <CardTitle className="text-base">
                                {isRunning ? "Generating Test Cases…" : isDone ? "Generation Complete!" : "Generation Failed"}
                            </CardTitle>
                            <CardDescription className="mt-0.5">{jobData.message}</CardDescription>
                        </div>
                        {isDone && (
                            <div className="text-right">
                                <div className="text-2xl font-bold text-emerald-600">{jobData.generatedCount}</div>
                                <div className="text-xs text-muted-foreground">test cases</div>
                            </div>
                        )}
                    </div>
                </CardHeader>
                <CardContent>
                    {isRunning && (
                        <div className="w-full h-2.5 bg-violet-100 dark:bg-violet-900/30 rounded-full overflow-hidden">
                            <div className="h-full bg-gradient-to-r from-violet-500 to-purple-500 rounded-full transition-all duration-700 ease-out"
                                style={{ width: `${jobData.progress}%` }} />
                        </div>
                    )}
                    {isDone && (
                        <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900 p-3">
                            <p className="text-sm text-emerald-700 dark:text-emerald-300">
                                ✅ Suite: <span className="font-semibold">{jobData.suiteName}</span>
                                <span className="text-xs ml-2 text-emerald-600 dark:text-emerald-400">
                                    — Review below, select what you want, then add to Tests.
                                </span>
                            </p>
                        </div>
                    )}
                    {isFailed && jobData.error && (
                        <div className="rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 p-3">
                            <p className="text-sm text-red-700 dark:text-red-300">{jobData.error}</p>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Review panel — shown when generation completed */}
            {isDone && (
                <Card className="border-violet-200 dark:border-violet-900">
                    <CardHeader className="pb-0">
                        <div className="flex items-center justify-between flex-wrap gap-3">
                            <div className="flex items-center gap-2">
                                <ListChecks className="h-5 w-5 text-violet-500" />
                                <CardTitle className="text-base">Review Generated Test Cases</CardTitle>
                                {!reviewLoading && (
                                    <span className="text-xs bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 px-2 py-0.5 rounded-full font-medium">
                                        {selectedIds.size} / {reviewCases.length} selected
                                    </span>
                                )}
                            </div>
                            {/* Action buttons */}
                            {!reviewLoading && reviewCases.length > 0 && (
                                <div className="flex items-center gap-2">
                                    <Button size="sm" variant="outline" onClick={onToggleAll}
                                        className="h-8 text-xs gap-1.5">
                                        {allSelected
                                            ? <><Square className="h-3.5 w-3.5" />Deselect All</>
                                            : <><CheckSquare className="h-3.5 w-3.5" />Select All</>}
                                    </Button>
                                    <Button size="sm" onClick={onAddSelected}
                                        disabled={isAddingSelected || selectedIds.size === 0}
                                        className="h-8 text-xs gap-1.5 bg-violet-600 hover:bg-violet-700">
                                        {generatingSteps
                                            ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Generating Steps…</>
                                            : confirming
                                            ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Adding…</>
                                            : <><Check className="h-3.5 w-3.5" />Add Selected to Tests</>}
                                    </Button>
                                </div>
                            )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-2 pb-3">
                            Review each generated test case. Uncheck any you don&apos;t want — they will be discarded when you click <strong>Add Selected to Tests</strong>.
                        </p>
                    </CardHeader>
                    <CardContent className="pt-0">
                        {reviewLoading ? (
                            <div className="flex items-center justify-center py-10 gap-2 text-muted-foreground">
                                <Loader2 className="h-5 w-5 animate-spin" />
                                <span className="text-sm">Loading generated test cases…</span>
                            </div>
                        ) : reviewCases.length === 0 ? (
                            <p className="text-sm text-muted-foreground text-center py-8">No test cases found.</p>
                        ) : (
                            <div className="space-y-2 max-h-[520px] overflow-y-auto pr-1">
                                {reviewCases.map((tc, idx) => {
                                    const checked = selectedIds.has(tc.id)
                                    const steps = Array.isArray(tc.steps) ? tc.steps : []
                                    return (
                                        <div key={tc.id}
                                            onClick={() => onToggleOne(tc.id)}
                                            className={`group flex items-start gap-3 rounded-lg border p-3.5 cursor-pointer transition-all duration-150 ${
                                                checked
                                                    ? "bg-violet-50 dark:bg-violet-950/30 border-violet-300 dark:border-violet-700"
                                                    : "bg-white dark:bg-black/10 border-gray-200 dark:border-gray-800 opacity-60 hover:opacity-80"
                                            }`}>
                                            {/* Checkbox */}
                                            <div className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                                                checked
                                                    ? "bg-violet-600 border-violet-600"
                                                    : "border-gray-300 dark:border-gray-600"
                                            }`}>
                                                {checked && <Check className="h-3 w-3 text-white" />}
                                            </div>

                                            {/* Content */}
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className="text-xs text-muted-foreground font-mono shrink-0">#{idx + 1}</span>
                                                    <span className="font-medium text-sm truncate">{tc.name}</span>
                                                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${
                                                        PRIORITY_COLORS[tc.priority] ?? PRIORITY_COLORS.medium
                                                    }`}>{tc.priority}</span>
                                                </div>
                                                {tc.description && (
                                                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                                                        {tc.description}
                                                    </p>
                                                )}
                                            </div>

                                            {/* Discard badge on unchecked */}
                                            {!checked && (
                                                <div className="flex-shrink-0 flex items-center gap-1 text-xs text-red-400 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    <Trash2 className="h-3.5 w-3.5" /> discard
                                                </div>
                                            )}
                                        </div>
                                    )
                                })}
                            </div>
                        )}

                        {/* Bottom action bar */}
                        {!reviewLoading && reviewCases.length > 0 && (
                            <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-100 dark:border-gray-800">
                                <p className="text-xs text-muted-foreground">
                                    <span className="font-semibold text-violet-600">{selectedIds.size}</span> selected,&nbsp;
                                    <span className="text-red-500">{reviewCases.length - selectedIds.size} will be discarded</span>
                                    {generatingSteps && <span className="ml-2 text-violet-600 animate-pulse"> — generating steps…</span>}
                                </p>
                                <Button size="sm" onClick={onAddSelected}
                                    disabled={isAddingSelected || selectedIds.size === 0}
                                    className="gap-1.5 bg-violet-600 hover:bg-violet-700">
                                    {generatingSteps
                                        ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Generating Steps…</>
                                        : confirming
                                        ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Adding…</>
                                        : <><Check className="h-3.5 w-3.5" />Add Selected to Tests</>}
                                </Button>
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}
        </div>
    )
}

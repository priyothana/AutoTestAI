"use client"

import { useState, useEffect, use, useRef } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
    Play,
    Save,
    Wand2,
    Plus,
    Trash2,
    GripVertical,
    AlertCircle,
    Loader2,
    FileText,
    ArrowDown,
    Sparkles,
    BookOpen,
    Code2,
    MonitorPlay,
    CheckCircle,
    SkipForward
} from "lucide-react"
import { format } from "date-fns"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
    CardAction
} from "@/components/ui/card"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import JiraImportPanel from "@/components/projects/JiraImportPanel"
import AiFixAssistant from "@/components/tests/AiFixAssistant"

// Step Type
type TestStep = {
    id: string
    action: string
    target: string
    value: string
}

type Project = {
    id: string
    name: string
}

export default function TestEditorPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params)
    const router = useRouter()

    // Internal state for ID and mode
    const [currentId, setCurrentId] = useState(id)
    const [isInternalNew, setIsInternalNew] = useState(id === "create" || id === "new")

    const [testName, setTestName] = useState(isInternalNew ? "New Test Case" : "Loading...")
    const [description, setDescription] = useState("")
    const [prompt, setPrompt] = useState("")
    const [isGenerating, setIsGenerating] = useState(false)
    const [isSaving, setIsSaving] = useState(false)
    const [isRunning, setIsRunning] = useState(false)
    const isRunningRef = useRef(false)
    const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // HITL interactive state
    const [isPaused, setIsPaused] = useState(false)
    const [pausedStepIndex, setPausedStepIndex] = useState<number | null>(null)
    const [activeRunId, setActiveRunId] = useState<string | null>(null)
    const [isResumingPause, setIsResumingPause] = useState(false)
    const [projects, setProjects] = useState<Project[]>([])
    const [selectedProjectId, setSelectedProjectId] = useState<string>("")
    const [priority, setPriority] = useState("medium")
    const [selectedProvider, setSelectedProvider] = useState("claude")

    const [steps, setSteps] = useState<TestStep[]>([])
    const [testStatus, setTestStatus] = useState<string>("draft")
    const [projectError, setProjectError] = useState(false)
    const [hasMounted, setHasMounted] = useState(false)
    const [testSource, setTestSource] = useState<'manual' | 'jira' | null>(null)
    const [jiraConfigured, setJiraConfigured] = useState<boolean | null>(null) // null = loading

    // Readable view state — default to readable
    interface ReadableStep {
        test_step: string
        test_data: string
        expected_result: string
        actual_result: string
        status: string
        comments: string
    }
    const [readableSteps, setReadableSteps] = useState<ReadableStep[]>([])
    const [isHumanizing, setIsHumanizing] = useState(false)
    const [showReadableView, setShowReadableView] = useState(true)

    useEffect(() => {
        setHasMounted(true)
    }, [])

    const fetchProjects = async () => {
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/`)
            if (response.ok) {
                const data = await response.json()
                const projectsList = Array.isArray(data) ? data : (data.items || [])
                setProjects(projectsList)
            }
        } catch (error) {
            console.error("Failed to fetch projects:", error)
        }
    }

    const fetchTestCase = async () => {
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/tests/${currentId}`)
            if (response.ok) {
                const data = await response.json()
                setTestName(data.name)
                setDescription(data.description || "")
                const loadedSteps = data.steps || []
                setSteps(loadedSteps)
                setSelectedProjectId(data.project_id)
                setPriority(data.priority || "medium")

                // Fetch last run result for this test (to pre-fill execution columns)
                let lastRunLogs: any[] = []
                try {
                    const runsRes = await fetch(
                        `${process.env.NEXT_PUBLIC_API_URL}/api/v1/test-runs/?test_case_id=${currentId}&limit=1`
                    )
                    if (runsRes.ok) {
                        const runsData = await runsRes.json()
                        const runs = Array.isArray(runsData) ? runsData : (runsData.items || [])
                        if (runs.length > 0) {
                            // Fetch full run detail (includes logs)
                            const runDetailRes = await fetch(
                                `${process.env.NEXT_PUBLIC_API_URL}/api/v1/test-runs/${runs[0].id}`
                            )
                            if (runDetailRes.ok) {
                                const runDetail = await runDetailRes.json()
                                setLastRunResult(runDetail)
                                lastRunLogs = runDetail.logs || []
                                // Sync test status badge
                                if (runDetail.status === 'passed') setTestStatus('passed')
                                else if (runDetail.status === 'failed') setTestStatus('failed')
                            }
                        }
                    }
                } catch { /* non-critical */ }

                // Auto-fetch readable steps so Readable View is ready by default
                if (loadedSteps.length > 0) {
                    try {
                        setIsHumanizing(true)
                        const humanRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/tests/humanize-steps`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ steps: loadedSteps, provider: "claude" })
                        })
                        if (humanRes.ok) {
                            const humanData = await humanRes.json()
                            let freshSteps: any[] = humanData.readable_steps || []
                            // Merge last run logs if available
                            if (lastRunLogs.length > 0) {
                                freshSteps = mergeExecutionIntoReadableSteps(freshSteps, lastRunLogs)
                            }
                            setReadableSteps(freshSteps)
                            setShowReadableView(true)
                        }
                    } catch {
                        // Non-critical — fall back to editor view silently
                        setShowReadableView(false)
                    } finally {
                        setIsHumanizing(false)
                    }
                }
            }
        } catch (error) {
            toast.error("Failed to load test case")
        }
    }

    useEffect(() => {
        fetchProjects()
        if (!isInternalNew) {
            fetchTestCase()
        }
    }, [])

    // Check Jira config when project changes
    useEffect(() => {
        if (selectedProjectId) {
            checkJiraConfig(selectedProjectId)
        } else {
            setJiraConfigured(null)
        }
    }, [selectedProjectId])

    const checkJiraConfig = async (projectId: string) => {
        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/jira/projects/${projectId}/config`)
            if (res.ok) {
                const data = await res.json()
                setJiraConfigured(data.configured === true)
            } else {
                setJiraConfigured(false)
            }
        } catch {
            setJiraConfigured(false)
        }
    }

    const handleGenerate = async () => {
        if (!prompt) {
            toast.error("Please enter a test case description or import from Jira first")
            return
        }

        setIsGenerating(true)
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/tests/generate-test-steps`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prompt, provider: selectedProvider, project_id: selectedProjectId || undefined })
            })

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || "Failed to generate steps");
            }

            const data = await response.json()
            toast.success("Test steps generated successfully!")

            if (data.name && isInternalNew) setTestName(data.name)
            if (data.description && !description) setDescription(data.description)
            if (data.priority) setPriority(data.priority)

            const newSteps = (data.steps || []).map((s: any) => ({
                id: s.id || Math.random().toString(),
                action: s.action.toUpperCase(),
                target: s.target || "",
                value: s.value || ""
            }))

            setSteps(newSteps)
            
            if (newSteps.length > 0) {
                try {
                    setIsHumanizing(true)
                    const humanRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/tests/humanize-steps`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ steps: newSteps, provider: selectedProvider })
                    })
                    if (humanRes.ok) {
                        const humanData = await humanRes.json()
                        setReadableSteps(humanData.readable_steps || [])
                        setShowReadableView(true)
                    } else {
                        setShowReadableView(false)
                    }
                } catch {
                    setShowReadableView(false)
                } finally {
                    setIsHumanizing(false)
                }
            } else {
                setShowReadableView(false)
            }
        } catch (error: any) {
            console.error("Generation error:", error)
            toast.error(error.message || "AI generation failed. Please try again.")
        } finally {
            setIsGenerating(false)
        }
    }

    const [lastRunResult, setLastRunResult] = useState<any>(null)

    // ── Helper: stop polling and reset running state ────────────────────
    const stopRunning = (
        toastId: string | number,
        message: string,
        type: "success" | "error" | "warning" | "info" = "warning",
        finalRunId?: string,
    ) => {
        if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null }
        if (pollTimeoutRef.current) { clearTimeout(pollTimeoutRef.current); pollTimeoutRef.current = null }
        setIsRunning(false)
        isRunningRef.current = false
        setIsPaused(false)
        setPausedStepIndex(null)
        if (type === "success") toast.success(message, { id: toastId })
        else if (type === "error") toast.error(message, { id: toastId })
        else if (type === "info") toast.info(message, { id: toastId })
        else toast.warning(message, { id: toastId })

        // On timeout/warning, do one final fetch so the result panel is shown
        // if the test actually finished while we were waiting.
        if (finalRunId) {
            fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/test-runs/${finalRunId}`)
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                    if (data && data.status && !['pending','running','paused'].includes(data.status)) {
                        setLastRunResult(data)
                        if (data.status === 'passed') setTestStatus('passed')
                        else setTestStatus('failed')
                    }
                })
                .catch(() => { /* non-critical */ })
        }
    }

    // ── Shared run launcher (called by both Run Test and Run Interactive) ────
    const launchRun = async (interactive: boolean) => {
        if (!selectedProjectId) {
            toast.error("Please select an environment before running the test")
            setProjectError(true)
            return
        }
        if (isInternalNew) {
            toast.error("Please save the test case before running")
            return
        }

        // Clear any previous intervals
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
        if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current)

        setIsRunning(true)
        isRunningRef.current = true
        setIsPaused(false)
        setPausedStepIndex(null)
        setLastRunResult(null)
        const runToastId = toast.loading("Saving & starting execution...")

        try {
            // ── Auto-save current steps before running ──────────────────
            if (!isInternalNew && currentId) {
                const saveRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/tests/${currentId}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: testName, description, project_id: selectedProjectId, steps, priority }),
                })
                if (!saveRes.ok) throw new Error("Failed to auto-save test steps before running")
            }

            toast.loading(
                interactive ? "🖥️  Opening browser window & running test..." : "Running test...",
                { id: runToastId }
            )

            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/test-runs`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ test_case_id: currentId, interactive })
            })

            if (!response.ok) {
                const errData = await response.json().catch(() => ({ detail: "Failed to start" }))
                throw new Error(errData.detail || "Failed to start test execution")
            }

            const runData = await response.json()
            setActiveRunId(runData.id)
            toast.loading(
                <div className="flex flex-col gap-1">
                    <span>{interactive ? '🖥️  Browser window open — test running...' : 'Test is running in background...'}</span>
                    <Link href="/dashboard/execution" className="text-xs text-blue-500 underline">Check Execution Tab</Link>
                </div>,
                { id: runToastId }
            )

            let consecutivePollErrors = 0
            const MAX_POLL_ERRORS = 5

            pollIntervalRef.current = setInterval(async () => {
                // Guard: if we've already been stopped, clear and exit
                if (!isRunningRef.current) {
                    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
                    return
                }

                try {
                    const pollRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/test-runs/${runData.id}`)
                    if (!pollRes.ok) {
                        consecutivePollErrors++
                        console.warn(`[Poll] HTTP ${pollRes.status} (error ${consecutivePollErrors}/${MAX_POLL_ERRORS})`)
                        if (consecutivePollErrors >= MAX_POLL_ERRORS) {
                            stopRunning(runToastId, "Lost connection to backend. Check Execution tab for results.", "warning")
                        }
                        return
                    }
                    consecutivePollErrors = 0 // reset on success

                    const statusData = await pollRes.json()
                    const status = statusData.status?.toLowerCase()

                    // ── HITL: paused status ───────────────────────────────
                    if (status === 'paused') {
                        // Detect which step is paused from the last log entry
                        const logs = statusData.logs ?? []
                        const lastLog = logs[logs.length - 1]
                        const pausedStep = lastLog?.step ?? null
                        setIsPaused(true)
                        setPausedStepIndex(pausedStep)
                        toast.warning(
                            `⏸ Step ${pausedStep ?? '?'} needs manual help — see banner below`,
                            { id: runToastId, duration: Infinity }
                        )
                        return // keep polling so we can detect resume
                    }

                    // Clear pause state if status moved on
                    if (isPaused && status === 'running') {
                        setIsPaused(false)
                        setPausedStepIndex(null)
                        toast.loading('▶ Continuing from next step...', { id: runToastId })
                        return
                    }

                    if (status !== "running" && status !== "pending" && status !== "paused") {
                        // Clear timeout first so it doesn't fire after we've finished
                        if (pollTimeoutRef.current) { clearTimeout(pollTimeoutRef.current); pollTimeoutRef.current = null }
                        if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null }
                        setIsRunning(false)
                        isRunningRef.current = false
                        setIsPaused(false)
                        setPausedStepIndex(null)
                        setLastRunResult(statusData)
                        // Merge execution results into the readable steps table
                        if (statusData.logs?.length > 0) {
                            setReadableSteps(prev => mergeExecutionIntoReadableSteps(prev, statusData.logs))
                            setShowReadableView(true)
                        }

                        if (status === "passed") {
                            toast.success(`Test Passed! (${statusData.duration?.toFixed(1) || 0}s)`, { id: runToastId })
                            setTestStatus("passed")
                        } else {
                            toast.error(`Test ${status} – View details below`, { id: runToastId })
                            setTestStatus("failed")

                            // Poll for AI healing suggestions (up to 40s)
                            let healAttempts = 0
                            const healPoll = setInterval(async () => {
                                healAttempts++
                                try {
                                    const healRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/test-runs/${runData.id}`)
                                    if (healRes.ok) {
                                        const healData = await healRes.json()
                                        const ai = healData.ai_suggestions
                                        const hasHeal = ai?.corrected_steps?.length > 0 || (Array.isArray(ai) && ai.length > 0)
                                        if (hasHeal) {
                                            clearInterval(healPoll)
                                            setLastRunResult(healData)
                                            toast.info("💡 AI Fix Assistant has suggestions — scroll down!", { duration: 6000 })
                                        } else if (healAttempts >= 10) {
                                            clearInterval(healPoll)
                                        }
                                    }
                                } catch (_) { /* non-critical */ }
                            }, 4000)
                        }
                        fetchTestCase()
                    }
                } catch (pollErr) {
                    consecutivePollErrors++
                    console.error("Polling error:", pollErr)
                    if (consecutivePollErrors >= MAX_POLL_ERRORS) {
                        stopRunning(runToastId, "Polling failed repeatedly. Check Execution tab for results.", "warning")
                    }
                }
            }, 3000)

            // ── Safety timeout: 15 minutes for interactive (user has 10min to resume) ─
            pollTimeoutRef.current = setTimeout(() => {
                if (isRunningRef.current) {
                    stopRunning(
                        runToastId,
                        "Test is taking longer than expected. Results will appear below if the test completed.",
                        "warning",
                        runData.id,
                    )
                }
            }, interactive ? 15 * 60 * 1000 : 5 * 60 * 1000)

        } catch (error: any) {
            console.error("Run error:", error)
            toast.error(error.message || "Failed to start test execution", { id: runToastId })
            setIsRunning(false)
            isRunningRef.current = false
            setIsPaused(false)
            if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null }
            if (pollTimeoutRef.current) { clearTimeout(pollTimeoutRef.current); pollTimeoutRef.current = null }
        }
    }

    const handleRunTest        = () => launchRun(false)
    const handleRunInteractive = () => launchRun(true)

    // ── HITL: Resume or skip the paused step ────────────────────────────
    const handlePauseAction = async (action: 'resume' | 'skip') => {
        if (!activeRunId) return
        setIsResumingPause(true)
        try {
            const res = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/api/v1/test-runs/${activeRunId}/resume`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action }),
                }
            )
            if (!res.ok) {
                const err = await res.json().catch(() => ({ detail: 'Failed' }))
                toast.error(err.detail || 'Failed to resume run')
            } else {
                setIsPaused(false)
                setPausedStepIndex(null)
                toast.success(action === 'resume' ? '▶ Continuing test...' : '⏭ Step skipped — continuing...')
            }
        } catch (e) {
            toast.error('Network error — could not reach backend')
        } finally {
            setIsResumingPause(false)
        }
    }

    const handleSave = async () => {
        if (!testName) {
            toast.error("Test name is required")
            return
        }
        if (!selectedProjectId) {
            toast.error("Please select an environment before saving")
            setProjectError(true)
            return
        }

        setIsSaving(true)
        try {
            const method = isInternalNew ? "POST" : "PUT"
            const url = isInternalNew ? `${process.env.NEXT_PUBLIC_API_URL}/api/v1/tests` : `${process.env.NEXT_PUBLIC_API_URL}/api/v1/tests/${currentId}`

            const response = await fetch(url, {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: testName,
                    description,
                    project_id: selectedProjectId,
                    steps,
                    priority
                })
            })

            if (!response.ok) throw new Error("Failed to save test case")

            const savedData = await response.json()

            toast.success(isInternalNew
                ? "Test case created successfully! You can now run the test."
                : "Test case saved!")

            if (isInternalNew) {
                setCurrentId(savedData.id)
                setIsInternalNew(false)
                window.history.replaceState(null, "", `/dashboard/tests/${savedData.id}`)
            }
        } catch (error) {
            toast.error("Failed to save test case")
        } finally {
            setIsSaving(false)
        }
    }

    const addStep = () => {
        setSteps(prev => [...prev, { id: Math.random().toString(), action: "CLICK", target: "", value: "" }])
    }

    const removeStep = (id: string) => {
        setSteps(prev => prev.filter(s => s.id !== id))
    }

    const updateStep = (id: string, field: keyof TestStep, value: string) => {
        setSteps(prev => prev.map(s => s.id === id ? { ...s, [field]: value } : s))
    }

    // ── Merge execution logs into readable steps ──────────────────────
    // Called after run completes. Maps each log entry (1-based step index)
    // to the corresponding readable step and fills actual_result / status / comments.
    const mergeExecutionIntoReadableSteps = (
        current: ReadableStep[],
        logs: any[]
    ): ReadableStep[] => {
        if (!current.length || !logs.length) return current

        // Build a map: stepIndex (1-based) → log entry
        // A step may have multiple log entries (e.g. retry); use the last one.
        const logMap = new Map<number, any>()
        for (const log of logs) {
            const stepIdx = log.step ?? log.step_order ?? null
            if (stepIdx != null) logMap.set(Number(stepIdx), log)
        }

        return current.map((step, idx) => {
            const stepNum = idx + 1   // readable steps are 0-indexed; logs are 1-based
            const log = logMap.get(stepNum)
            if (!log) return step    // no log for this step — leave as-is

            const isPassed = log.status === 'passed' || log.status === 'success'
            const isFailed = log.status === 'failed' || log.status === 'error' || log.status === 'skipped'

            const actual_result = isPassed
                ? (log.message ? String(log.message) : 'Step completed successfully')
                : (log.error   ? String(log.error)   : log.message ? String(log.message) : 'Step failed')

            const status = isPassed ? 'Pass' : isFailed ? 'Fail' : '—'

            const comments = isFailed
                ? [log.error, log.message].filter(Boolean).join(' — ') || 'Step failed'
                : '—'

            return { ...step, actual_result, status, comments }
        })
    }

    const handleHumanizeSteps = async () => {
        if (steps.length === 0) return

        // Toggle off if already showing readable view
        if (showReadableView) {
            setShowReadableView(false)
            return
        }

        setIsHumanizing(true)
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/tests/humanize-steps`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ steps, provider: selectedProvider })
            })

            if (!response.ok) {
                throw new Error("Failed to convert steps")
            }

            const data = await response.json()
            let freshSteps: ReadableStep[] = data.readable_steps || []

            // If a run result already exists with logs, pre-fill the result columns
            if (lastRunResult?.logs?.length > 0) {
                freshSteps = mergeExecutionIntoReadableSteps(freshSteps, lastRunResult.logs)
            }

            setReadableSteps(freshSteps)
            setShowReadableView(true)
        } catch (error: any) {
            console.error("Humanize error:", error)
            toast.error("Failed to generate readable steps")
        } finally {
            setIsHumanizing(false)
        }
    }

    return (
        <div className="space-y-5 max-w-6xl mx-auto pb-10">
            {/* ── Header ──────────────────────────────────────────────────── */}
            <div className="flex items-center gap-2">
                <Input
                    value={testName}
                    onChange={(e) => setTestName(e.target.value)}
                    className="text-2xl font-bold h-auto border-transparent hover:border-input px-0 w-[400px] focus-visible:ring-0"
                    placeholder="Enter test case name..."
                />
                <p className="text-muted-foreground text-sm ml-4 self-end pb-0.5">
                    {isInternalNew ? "Creating a new automated test" : `Editing test ID: ${currentId}`}
                </p>
            </div>

            {/* ── HITL Pause Banner ────────────────────────────────────────── */}
            {isPaused && (
                <div className="flex items-start gap-4 p-4 rounded-xl border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-600 shadow-md animate-pulse">
                    <div className="flex-shrink-0 bg-amber-100 dark:bg-amber-900/40 p-2 rounded-full">
                        <AlertCircle className="h-6 w-6 text-amber-600 dark:text-amber-400" />
                    </div>
                    <div className="flex-1">
                        <p className="font-semibold text-amber-800 dark:text-amber-200 text-sm">
                            ⏸ Step {pausedStepIndex ?? '?'} is stuck — manual intervention needed
                        </p>
                        <p className="text-amber-700 dark:text-amber-300 text-xs mt-1">
                            The browser window is open and waiting. Complete the action manually in the Chrome window,
                            then click <strong>Resume</strong> below. Or click <strong>Skip</strong> to skip this step and continue.
                        </p>
                        <p className="text-amber-600 dark:text-amber-400 text-xs mt-0.5 font-mono">
                            ⚠️  Step editing is locked while paused. You have up to 10 minutes.
                        </p>
                    </div>
                    <div className="flex flex-col gap-2 flex-shrink-0">
                        <Button
                            size="sm"
                            className="bg-green-600 hover:bg-green-700 text-white gap-1"
                            onClick={() => handlePauseAction('resume')}
                            disabled={isResumingPause}
                        >
                            {isResumingPause ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
                            Resume (I completed it)
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            className="border-amber-400 text-amber-700 hover:bg-amber-100 gap-1"
                            onClick={() => handlePauseAction('skip')}
                            disabled={isResumingPause}
                        >
                            <SkipForward className="h-3 w-3" />
                            Skip this step
                        </Button>
                    </div>
                </div>
            )}

            {/* ══════════════════════════════════════════════════════════════
                SECTION 1 — Environment Mapping
               ══════════════════════════════════════════════════════════════ */}
            <Card className="border-blue-100 dark:border-blue-900 shadow-sm">
                <CardHeader className="px-4 py-1 space-y-0 border-b bg-gray-50/50 dark:bg-gray-900/50 min-h-0 flex items-center justify-start">
                    <CardTitle className="text-[13px] font-semibold text-gray-800 dark:text-gray-200 leading-none m-0">Environment Mapping</CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-3 pt-1.5">
                    <div className="max-w-md space-y-1.5">
                        <label className="text-xs font-medium text-gray-700 dark:text-gray-300 leading-none">
                            Select Environment <span className="text-red-500">*</span>
                        </label>
                        <Select value={selectedProjectId} onValueChange={(val) => { setSelectedProjectId(val); setProjectError(false) }}>
                            <SelectTrigger className={projectError ? "border-red-500 ring-1 ring-red-500" : ""}>
                                <SelectValue placeholder="Select an environment..." />
                            </SelectTrigger>
                            <SelectContent>
                                {projects.map((project) => (
                                    <SelectItem key={project.id} value={project.id}>
                                        {project.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </CardContent>
            </Card>

            {/* ══════════════════════════════════════════════════════════════
                SECTION 2 — Test Case Source
               ══════════════════════════════════════════════════════════════ */}
            <div className="space-y-3">
                <div>
                    <h3 className="text-lg font-semibold flex items-center gap-2">
                        <FileText className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                        Test Case Source
                    </h3>
                    <p className="text-sm text-muted-foreground mt-0.5">
                        Choose how to provide your test case.
                    </p>
                </div>

                {/* Source Selector Cards */}
                <div className="grid gap-4 md:grid-cols-2">
                    {/* Option 1 — Manual */}
                    <button
                        type="button"
                        onClick={() => setTestSource('manual')}
                        className={`text-left p-4 rounded-lg border-2 transition-all duration-200 ${testSource === 'manual'
                                ? 'border-blue-500 bg-blue-50/80 dark:bg-blue-950/20 shadow-md ring-2 ring-blue-200 dark:ring-blue-800'
                                : 'border-gray-200 dark:border-gray-800 hover:border-blue-300 dark:hover:border-blue-700 hover:bg-blue-50/40 dark:hover:bg-blue-950/10'
                            }`}
                    >
                        <div className="flex items-center gap-3 mb-2">
                            <div className={`p-2 rounded-lg ${testSource === 'manual' ? 'bg-blue-100 dark:bg-blue-900/40' : 'bg-gray-100 dark:bg-gray-800'}`}>
                                <FileText className={`h-5 w-5 ${testSource === 'manual' ? 'text-blue-600' : 'text-gray-500'}`} />
                            </div>
                            <div>
                                <h4 className="font-semibold text-sm">Manual Test Case</h4>
                                <p className="text-xs text-muted-foreground">Enter a test case or user story in plain English</p>
                            </div>
                        </div>
                    </button>

                    {/* Option 2 — Import from Jira */}
                    <button
                        type="button"
                        onClick={() => {
                            if (jiraConfigured) setTestSource('jira')
                        }}
                        disabled={!jiraConfigured}
                        className={`text-left p-4 rounded-lg border-2 transition-all duration-200 ${!jiraConfigured
                                ? 'border-gray-200 dark:border-gray-800 opacity-60 cursor-not-allowed'
                                : testSource === 'jira'
                                    ? 'border-purple-500 bg-purple-50/80 dark:bg-purple-950/20 shadow-md ring-2 ring-purple-200 dark:ring-purple-800'
                                    : 'border-gray-200 dark:border-gray-800 hover:border-purple-300 dark:hover:border-purple-700 hover:bg-purple-50/40 dark:hover:bg-purple-950/10'
                            }`}
                    >
                        <div className="flex items-center gap-3 mb-2">
                            <div className={`p-2 rounded-lg ${testSource === 'jira' ? 'bg-purple-100 dark:bg-purple-900/40' : 'bg-gray-100 dark:bg-gray-800'}`}>
                                <svg className={`h-5 w-5 ${testSource === 'jira' ? 'text-purple-600' : 'text-gray-500'}`} viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53zM6.77 6.8a4.36 4.36 0 0 0 4.34 4.34h1.8v1.72a4.36 4.36 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.83-.83H6.77zM2 11.6a4.35 4.35 0 0 0 4.34 4.34h1.8v1.72A4.35 4.35 0 0 0 12.48 22v-9.57a.84.84 0 0 0-.84-.84H2z" />
                                </svg>
                            </div>
                            <div>
                                <h4 className="font-semibold text-sm">Import from Jira</h4>
                                <p className="text-xs text-muted-foreground">
                                    {!selectedProjectId
                                        ? 'Select an environment first'
                                        : jiraConfigured === null
                                            ? 'Checking Jira config...'
                                            : jiraConfigured
                                                ? 'Import user stories from your connected Jira board'
                                                : 'Jira not configured for this environment. Configure in Environment Settings.'}
                                </p>
                            </div>
                        </div>
                    </button>
                </div>

                {/* Conditional Content based on selection */}
                {testSource === 'manual' && (
                    <Card className="bg-gradient-to-br from-blue-50/80 to-indigo-50/60 dark:from-blue-950/20 dark:to-indigo-950/15 border-blue-200/70 dark:border-blue-900">
                        <CardHeader className="pb-2 pt-4 px-4">
                            <CardTitle className="flex items-center gap-2 text-blue-700 dark:text-blue-300 text-base">
                                <FileText className="h-4 w-4" />
                                Manual Test Case
                            </CardTitle>
                            <CardDescription>
                                Enter a test case or user story in plain English.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="px-4 pb-4 pt-0">
                            <Textarea
                                placeholder={`e.g., "Navigate to Accounts tab and create a new Account record"\n\nOr describe a full user story with multiple steps...`}
                                className="min-h-[120px] resize-none bg-white/70 dark:bg-black/20 focus-visible:ring-indigo-400"
                                value={prompt}
                                onChange={(e) => setPrompt(e.target.value)}
                            />
                        </CardContent>
                    </Card>
                )}

                {testSource === 'jira' && selectedProjectId && (
                    <JiraImportPanel
                        projectId={selectedProjectId}
                        onImport={(stories) => {
                            setPrompt((prev) => {
                                const newContent = stories.join("\n\n")
                                return prev ? prev + "\n\n" + newContent : newContent
                            })
                            // Automatically switch back to manual source to show the populated input and generator
                            setTestSource('manual')
                        }}
                    />
                )}
            </div>

            {/* ── Flow Arrow ──────────────────────────────────────────────── */}
            {testSource === 'manual' && (
                <div className="flex justify-center -my-1">
                    <div className="flex flex-col items-center gap-0.5 text-muted-foreground">
                        <ArrowDown className="h-4 w-4 animate-bounce" />
                    </div>
                </div>
            )}

            {/* ══════════════════════════════════════════════════════════════
                SECTION 3 — AI Test Step Generator
               ══════════════════════════════════════════════════════════════ */}
            {testSource === 'manual' && (
                <Card className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/20 dark:to-indigo-950/20 border-blue-200 dark:border-blue-900">
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-blue-700 dark:text-blue-400">
                            <Sparkles className="h-5 w-5" />
                            AI Test Step Generator
                        </CardTitle>
                        <CardDescription>
                            Convert the provided test case or imported Jira user story into optimized Playwright test steps.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="flex items-end gap-4">
                            <div className="space-y-2 w-60">
                                <label className="text-sm font-medium text-blue-700 dark:text-blue-400">AI Model</label>
                                <select
                                    value={selectedProvider}
                                    onChange={(e) => setSelectedProvider(e.target.value)}
                                    className="w-full h-9 rounded-md border border-blue-200 dark:border-blue-800 bg-white/50 dark:bg-black/20 px-3 py-1 text-sm shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400 cursor-pointer"
                                >
                                    <option value="openai">🟢 OpenAI (GPT-4o Mini)</option>
                                    <option value="claude">🟣 Claude (Sonnet 4)</option>
                                </select>
                            </div>
                            <Button
                                className="bg-blue-600 hover:bg-blue-700 shadow-md h-9 px-6"
                                onClick={handleGenerate}
                                disabled={isGenerating || !prompt}
                            >
                                {isGenerating ? (
                                    <>
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        Generating...
                                    </>
                                ) : (
                                    <>
                                        <Wand2 className="mr-2 h-4 w-4" />
                                        Generate Test Steps
                                    </>
                                )}
                            </Button>
                            {prompt && (
                                <p className="text-xs text-muted-foreground ml-auto self-center max-w-[200px] truncate">
                                    Input: &quot;{prompt.split("\n")[0]}&quot;
                                </p>
                            )}
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* ── Flow Arrow ──────────────────────────────────────────────── */}
            <div className="flex justify-center -my-1">
                <div className="flex flex-col items-center gap-0.5 text-muted-foreground">
                    <ArrowDown className="h-4 w-4 animate-bounce" />
                </div>
            </div>

            {/* ══════════════════════════════════════════════════════════════
                SECTION 4 — Test Steps
               ══════════════════════════════════════════════════════════════ */}
            <Card>
                    <CardHeader className="border-b flex flex-row items-center justify-between">
                        <CardTitle className="text-base flex items-center gap-2">
                            Test Steps ({steps.length})
                            <Badge
                                variant={testStatus === "passed" ? "default" : testStatus === "failed" ? "destructive" : "outline"}
                                className={testStatus === "passed" ? "bg-green-600 hover:bg-green-600" : ""}
                            >
                                {isInternalNew ? "Draft" : testStatus.toUpperCase()}
                            </Badge>
                        </CardTitle>
                        <CardAction>
                            <div className="flex items-center gap-2">
                                <Button
                                    variant={showReadableView ? "ghost" : "default"}
                                    size="sm"
                                    onClick={handleHumanizeSteps}
                                    disabled={steps.length === 0 || isHumanizing}
                                    className={showReadableView
                                        ? "text-gray-600 hover:text-gray-800 hover:bg-gray-100"
                                        : "bg-indigo-600 hover:bg-indigo-700 text-white"}
                                >
                                    {isHumanizing ? (
                                        <>
                                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                            Loading...
                                        </>
                                    ) : showReadableView ? (
                                        <>
                                            <Code2 className="mr-2 h-4 w-4" />
                                            Editor View
                                        </>
                                    ) : (
                                        <>
                                            <BookOpen className="mr-2 h-4 w-4" />
                                            Readable View
                                        </>
                                    )}
                                </Button>

                                {/* Divider */}
                                <div className="w-px h-5 bg-gray-200 dark:bg-gray-700" />

                                <Button variant="ghost" size="sm" onClick={addStep} className="text-blue-600 hover:text-blue-700 hover:bg-blue-50">
                                    <Plus className="mr-2 h-4 w-4" />
                                    Add Step
                                </Button>

                                {/* Save button */}
                                <Button variant="outline" size="sm" onClick={handleSave} disabled={isSaving}>
                                    {isSaving ? (
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    ) : (
                                        <Save className="mr-2 h-4 w-4" />
                                    )}
                                    Save
                                </Button>

                                {/* Run Test / Running… / Stop */}
                                {isRunning ? (
                                    <>
                                        <Button
                                            size="sm"
                                            className="bg-green-600 hover:bg-green-700"
                                            disabled
                                        >
                                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                            {isPaused ? 'Paused...' : 'Running...'}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700"
                                            onClick={() => stopRunning("run-stop", "Test run stopped manually. Check Execution tab for results.", "warning")}
                                        >
                                            Stop
                                        </Button>
                                    </>
                                ) : (
                                    <>
                                        <Button
                                            size="sm"
                                            className="hidden bg-green-600 hover:bg-green-700"
                                            onClick={handleRunTest}
                                            disabled={steps.length === 0 || isInternalNew || isSaving}
                                        >
                                            <Play className="mr-2 h-4 w-4" />
                                            Auto Run Test
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="border-indigo-400 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 gap-1"
                                            onClick={handleRunInteractive}
                                            disabled={steps.length === 0 || isInternalNew || isSaving}
                                            title="Opens a real browser window. If a step fails, you can complete it manually and click Resume."
                                        >
                                            <MonitorPlay className="h-4 w-4" />
                                            Run Test
                                        </Button>
                                    </>
                                )}
                            </div>
                        </CardAction>
                    </CardHeader>
                    <CardContent className="pt-4">
                        {showReadableView && readableSteps.length > 0 ? (
                            /* ── Readable View — Structured Table ── */
                            <div className="space-y-3">
                                <div className="flex items-center gap-2 mb-1">
                                    <BookOpen className="h-4 w-4 text-indigo-500" />
                                    <span className="text-sm font-medium text-indigo-600 dark:text-indigo-400">AI-Generated Readable Steps</span>
                                </div>
                                <div className="overflow-x-auto rounded-lg border border-indigo-100 dark:border-indigo-900/50">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="bg-gradient-to-r from-indigo-50 to-blue-50 dark:from-indigo-950/40 dark:to-blue-950/30 border-b border-indigo-100 dark:border-indigo-900/50">
                                                <th className="px-3 py-2.5 text-left font-semibold text-indigo-700 dark:text-indigo-300 w-8">#</th>
                                                <th className="px-3 py-2.5 text-left font-semibold text-indigo-700 dark:text-indigo-300 min-w-[200px]">Test Steps</th>
                                                <th className="px-3 py-2.5 text-left font-semibold text-indigo-700 dark:text-indigo-300 min-w-[120px]">Test Data</th>
                                                <th className="px-3 py-2.5 text-left font-semibold text-indigo-700 dark:text-indigo-300 min-w-[160px]">Expected Result</th>
                                                <th className="px-3 py-2.5 text-left font-semibold text-indigo-700 dark:text-indigo-300 min-w-[140px]">Actual Result</th>
                                                <th className="px-3 py-2.5 text-center font-semibold text-indigo-700 dark:text-indigo-300 w-20">Status</th>
                                                <th className="px-3 py-2.5 text-left font-semibold text-indigo-700 dark:text-indigo-300 min-w-[120px]">Comments / Defects</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {readableSteps.map((step, index) => (
                                                <tr
                                                    key={index}
                                                    className={`border-b border-indigo-50 dark:border-indigo-900/30 transition-colors duration-150 hover:bg-indigo-50/40 dark:hover:bg-indigo-950/20 ${
                                                        index % 2 === 0 ? 'bg-white dark:bg-gray-950/20' : 'bg-indigo-50/20 dark:bg-indigo-950/10'
                                                    }`}
                                                >
                                                    <td className="px-3 py-2.5 align-top">
                                                        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 text-xs font-bold">
                                                            {index + 1}
                                                        </span>
                                                    </td>
                                                    <td className="px-3 py-2.5 align-top text-gray-800 dark:text-gray-200 leading-relaxed">
                                                        {step.test_step}
                                                    </td>
                                                    <td className="px-3 py-2.5 align-top text-gray-600 dark:text-gray-400 font-mono text-xs leading-relaxed">
                                                        {step.test_data}
                                                    </td>
                                                    <td className="px-3 py-2.5 align-top text-gray-700 dark:text-gray-300 leading-relaxed">
                                                        {step.expected_result}
                                                    </td>
                                                    <td className="px-3 py-2.5 align-top text-gray-500 dark:text-gray-400 italic leading-relaxed">
                                                        {step.actual_result}
                                                    </td>
                                                    <td className="px-3 py-2.5 align-top text-center">
                                                        {step.status === 'Pass' ? (
                                                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                                                                ✓ Pass
                                                            </span>
                                                        ) : step.status === 'Fail' ? (
                                                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                                                                ✗ Fail
                                                            </span>
                                                        ) : (
                                                            <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
                                                        )}
                                                    </td>
                                                    <td className="px-3 py-2.5 align-top text-gray-500 dark:text-gray-400 text-xs leading-relaxed">
                                                        {step.comments}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        ) : (
                            /* ── Editor View (original, untouched) ── */
                            <>
                                <div className="space-y-3">
                                    {steps.map((step, index) => (
                                        <Card key={step.id} className={`group transition-all duration-200 ${
                                            isPaused && pausedStepIndex === index + 1
                                                ? 'border-amber-400 bg-amber-50/40 dark:bg-amber-950/10 ring-2 ring-amber-300'
                                                : 'hover:border-blue-400'
                                        }`}>
                                            <CardContent className="p-4 flex items-start gap-4">
                                                <div className="mt-2 text-muted-foreground cursor-grab active:cursor-grabbing">
                                                    <GripVertical className="h-4 w-4" />
                                                </div>
                                                <div className="flex-1 grid grid-cols-12 gap-3">
                                                    <div className="col-span-1 pt-2 font-mono text-sm text-muted-foreground">
                                                        #{index + 1}
                                                        {isPaused && pausedStepIndex === index + 1 && (
                                                            <span className="block text-[9px] text-amber-600 font-bold leading-none mt-0.5">PAUSED</span>
                                                        )}
                                                    </div>
                                                    <div className="col-span-3">
                                                        <Select
                                                            value={step.action}
                                                            onValueChange={(val) => updateStep(step.id, "action", val)}
                                                            disabled={isPaused}
                                                        >
                                                            <SelectTrigger className="h-9" disabled={isPaused}>
                                                                <SelectValue />
                                                            </SelectTrigger>
                                                            <SelectContent>
                                                                <SelectItem value="NAVIGATE">Navigate</SelectItem>
                                                                <SelectItem value="CLICK">Click</SelectItem>
                                                                <SelectItem value="TYPE">Type</SelectItem>
                                                                <SelectItem value="ASSERT_TEXT">Assert Text</SelectItem>
                                                                <SelectItem value="WAIT">Wait</SelectItem>
                                                            </SelectContent>
                                                        </Select>
                                                    </div>
                                                    <div className="col-span-4">
                                                        <Input
                                                            placeholder="Target (e.g. #id)"
                                                            value={step.target}
                                                            onChange={(e) => updateStep(step.id, "target", e.target.value)}
                                                            className="h-9 font-mono text-xs focus-visible:ring-blue-400"
                                                            disabled={isPaused}
                                                        />
                                                    </div>
                                                    <div className="col-span-4">
                                                        <Input
                                                            placeholder="Value"
                                                            value={step.value}
                                                            onChange={(e) => updateStep(step.id, "value", e.target.value)}
                                                            className="h-9 focus-visible:ring-blue-400"
                                                            disabled={isPaused}
                                                        />
                                                    </div>
                                                </div>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="opacity-0 group-hover:opacity-100 transition-opacity text-red-500 hover:text-red-600 hover:bg-red-50"
                                                    onClick={() => removeStep(step.id)}
                                                    disabled={isPaused}
                                                >
                                                    <Trash2 className="h-4 w-4" />
                                                </Button>
                                            </CardContent>
                                        </Card>
                                    ))}

                                </div>

                                {steps.length === 0 && (
                                    <div className="flex flex-col items-center justify-center p-12 border-2 border-dashed rounded-xl text-muted-foreground bg-gray-50/50">
                                        <div className="bg-white p-3 rounded-full shadow-sm mb-4">
                                            <AlertCircle className="h-8 w-8 text-blue-400" />
                                        </div>
                                        <p className="font-medium text-gray-900">No steps defined</p>
                                        <p className="text-sm max-w-[280px] text-center mt-1">
                                            Enter a test case above and use the AI Generator to create steps, or add a step manually.
                                        </p>
                                        <Button variant="outline" size="sm" onClick={addStep} className="mt-4">
                                            <Plus className="mr-2 h-4 w-4" />
                                            Manual Step
                                        </Button>
                                    </div>
                                )}
                            </>
                        )}
                    </CardContent>
                </Card>

            {/* ── Run Results Section ─────────────────────────────────────── */}
            {lastRunResult && (
                <Card className="mt-8 border-2 border-blue-100 dark:border-blue-900 overflow-hidden">
                    <CardHeader className="bg-blue-50/50 dark:bg-blue-950/20 border-b border-blue-100 dark:border-blue-900">
                        <div className="flex items-center justify-between">
                            <div>
                                <CardTitle className="text-xl flex items-center gap-2">
                                    Last Run Results
                                    <Badge
                                        variant={lastRunResult.status === "passed" ? "default" : "destructive"}
                                        className={lastRunResult.status === "passed" ? "bg-green-600" : ""}
                                    >
                                        {lastRunResult.status.toUpperCase()}
                                    </Badge>
                                </CardTitle>
                                <CardDescription>
                                    Executed at {format(new Date(lastRunResult.created_at), "MMM d, HH:mm:ss")}
                                </CardDescription>
                            </div>
                            <div className="text-right">
                                <div className="text-sm font-medium">Duration</div>
                                <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                                    {lastRunResult.duration?.toFixed(2)}s
                                </div>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent className="p-0">
                        <div className="grid md:grid-cols-2 divide-x divide-gray-100 dark:divide-gray-800">
                            {/* Logs */}
                            <div className="p-6">
                                <h3 className="font-semibold mb-4">Execution Logs</h3>
                                <div className="space-y-3">
                                    {lastRunResult.logs?.map((log: any, idx: number) => (
                                        <div key={idx} className="flex items-start gap-3 text-sm border-b border-gray-50 dark:border-gray-900 pb-2 last:border-0">
                                            <span className="font-mono text-muted-foreground w-6">#{log.step ?? log.step_order ?? (idx + 1)}</span>
                                            <div className="flex-1">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <Badge variant="outline" className="text-[10px] uppercase font-bold px-1 h-4">{log.action}</Badge>
                                                    <Badge
                                                        variant={log.status === 'passed' || log.status === 'success' ? 'default' : 'destructive'}
                                                        className={`${log.status === 'passed' || log.status === 'success' ? 'bg-green-500' : ''} text-[10px] px-1 h-4`}
                                                    >
                                                        {log.status}
                                                    </Badge>
                                                </div>
                                                <div className="text-xs font-medium text-gray-700 dark:text-gray-300">
                                                    {log.target && <span className="text-blue-600 dark:text-blue-400 font-mono mr-1">{log.target}</span>}
                                                    {log.value && <span className="text-gray-500 italic">&quot;{log.value}&quot;</span>}
                                                    {log.message && !log.error && <span className="text-gray-400 italic ml-1">{log.message}</span>}
                                                </div>
                                                {log.error && <p className="text-red-500 text-xs mt-1 font-medium">{log.error}</p>}
                                                {log.duration_ms != null && (
                                                    <p className="text-gray-400 text-[10px] mt-0.5">{log.duration_ms}ms</p>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                    {(!lastRunResult.logs || lastRunResult.logs.length === 0) && (
                                        <p className="text-sm text-muted-foreground italic">No logs available.</p>
                                    )}
                                </div>
                            </div>

                            {/* Screenshot */}
                            <div className="p-6 bg-gray-50/30 dark:bg-black/10">
                                <h3 className="font-semibold mb-4">Final Screenshot</h3>
                                {lastRunResult.screenshot_path ? (
                                    <div className="rounded-lg border bg-white dark:bg-black overflow-hidden shadow-sm group relative">
                                            <img
                                                src={lastRunResult.screenshot_path.startsWith('http') ? lastRunResult.screenshot_path : `${process.env.NEXT_PUBLIC_API_URL}${lastRunResult.screenshot_path.startsWith('/') ? '' : '/'}${lastRunResult.screenshot_path}`}
                                                alt="Test Run Screenshot"
                                                className="w-full h-auto object-contain max-h-[400px]"
                                            />
                                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                                <Button variant="secondary" size="sm" asChild>
                                                    <a href={lastRunResult.screenshot_path.startsWith('http') ? lastRunResult.screenshot_path : `${process.env.NEXT_PUBLIC_API_URL}${lastRunResult.screenshot_path.startsWith('/') ? '' : '/'}${lastRunResult.screenshot_path}`} target="_blank" rel="noreferrer">
                                                        View Full Size
                                                    </a>
                                                </Button>
                                            </div>
                                    </div>
                                ) : (
                                    <div className="h-[200px] border-2 border-dashed rounded-lg flex flex-col items-center justify-center text-muted-foreground bg-gray-50/50">
                                        <p className="text-sm">No screenshot captured</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* ── AI Fix Assistant ──────────────────────────────────────── */}
            {lastRunResult &&
              lastRunResult.status === "failed" &&
              lastRunResult.ai_suggestions != null &&
              (
                // New format: {analysis, corrected_steps}
                lastRunResult.ai_suggestions?.corrected_steps?.length > 0 ||
                // Legacy format: plain array
                (Array.isArray(lastRunResult.ai_suggestions) && lastRunResult.ai_suggestions.length > 0)
              ) && (
                <AiFixAssistant
                  runId={lastRunResult.id}
                  suggestions={lastRunResult.ai_suggestions}
                  steps={steps}
                  onApplyFixes={(updatedSteps) => setSteps(updatedSteps)}
                  onSave={async (updatedSteps) => {
                    // Save the fresh steps directly — avoids stale React state closure
                    if (!testName || !selectedProjectId) return
                    const url = isInternalNew
                      ? `${process.env.NEXT_PUBLIC_API_URL}/api/v1/tests`
                      : `${process.env.NEXT_PUBLIC_API_URL}/api/v1/tests/${currentId}`
                    await fetch(url, {
                      method: isInternalNew ? "POST" : "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        name: testName,
                        description,
                        project_id: selectedProjectId,
                        steps: updatedSteps,
                        priority,
                      }),
                    })
                  }}
                />
              )}
        </div>
    )
}

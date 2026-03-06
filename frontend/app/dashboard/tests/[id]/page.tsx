"use client"

import { useState, useEffect, use } from "react"
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
    Sparkles
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
    const [projects, setProjects] = useState<Project[]>([])
    const [selectedProjectId, setSelectedProjectId] = useState<string>("")
    const [priority, setPriority] = useState("medium")
    const [selectedProvider, setSelectedProvider] = useState("openai")

    const [steps, setSteps] = useState<TestStep[]>([])
    const [testStatus, setTestStatus] = useState<string>("draft")
    const [projectError, setProjectError] = useState(false)
    const [hasMounted, setHasMounted] = useState(false)

    useEffect(() => {
        setHasMounted(true)
    }, [])

    const fetchProjects = async () => {
        try {
            const response = await fetch("http://localhost:8000/api/v1/projects/")
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
            const response = await fetch(`http://localhost:8000/api/v1/tests/${currentId}`)
            if (response.ok) {
                const data = await response.json()
                setTestName(data.name)
                setDescription(data.description || "")
                setSteps(data.steps || [])
                setSelectedProjectId(data.project_id)
                setPriority(data.priority || "medium")
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

    const handleGenerate = async () => {
        if (!prompt) {
            toast.error("Please enter a test case description or import from Jira first")
            return
        }

        setIsGenerating(true)
        try {
            const response = await fetch("http://localhost:8000/api/v1/tests/generate-test-steps", {
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
        } catch (error: any) {
            console.error("Generation error:", error)
            toast.error(error.message || "AI generation failed. Please try again.")
        } finally {
            setIsGenerating(false)
        }
    }

    const [lastRunResult, setLastRunResult] = useState<any>(null)

    const handleRunTest = async () => {
        if (!selectedProjectId) {
            toast.error("Please select a project before running the test")
            setProjectError(true)
            return
        }
        if (isInternalNew) {
            toast.error("Please save the test case before running")
            return
        }

        setIsRunning(true)
        setLastRunResult(null)
        const runToastId = toast.loading("Starting execution flow...")

        try {
            const response = await fetch("http://localhost:8000/api/v1/test-runs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ test_case_id: currentId })
            })

            if (!response.ok) {
                const errData = await response.json().catch(() => ({ detail: "Failed to start" }))
                throw new Error(errData.detail || "Failed to start test execution")
            }

            const runData = await response.json()
            toast.loading(
                <div className="flex flex-col gap-1">
                    <span>Test is running in background...</span>
                    <Link href="/dashboard/execution" className="text-xs text-blue-500 underline">Check Execution Tab</Link>
                </div>,
                { id: runToastId }
            )

            const interval = setInterval(async () => {
                try {
                    const pollRes = await fetch(`http://localhost:8000/api/v1/test-runs/${runData.id}`)
                    if (pollRes.ok) {
                        const statusData = await pollRes.json()
                        const status = statusData.status?.toLowerCase()

                        if (status !== "running" && status !== "pending") {
                            clearInterval(interval)
                            setIsRunning(false)
                            setLastRunResult(statusData)

                            if (status === "passed") {
                                toast.success(`Test Passed! (${statusData.duration?.toFixed(1) || 0}s)`, { id: runToastId })
                                setTestStatus("passed")
                            } else {
                                toast.error(`Test ${status} – View details below`, { id: runToastId })
                                setTestStatus("failed")
                            }
                            fetchTestCase()
                        }
                    }
                } catch (pollErr) {
                    console.error("Polling error:", pollErr)
                }
            }, 3000)

            setTimeout(() => {
                clearInterval(interval)
                if (isRunning) {
                    setIsRunning(false)
                    toast.warning("Polling timed out. Check results in Execution tab.", { id: runToastId })
                }
            }, 600000)

        } catch (error: any) {
            console.error("Run error:", error)
            toast.error(error.message || "Failed to start test execution", { id: runToastId })
            setIsRunning(false)
        }
    }

    const handleSave = async () => {
        if (!testName) {
            toast.error("Test name is required")
            return
        }
        if (!selectedProjectId) {
            toast.error("Please select a project before saving")
            setProjectError(true)
            return
        }

        setIsSaving(true)
        try {
            const method = isInternalNew ? "POST" : "PUT"
            const url = isInternalNew ? "http://localhost:8000/api/v1/tests" : `http://localhost:8000/api/v1/tests/${currentId}`

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

    return (
        <div className="space-y-5 max-w-6xl mx-auto pb-10">
            {/* ── Header ──────────────────────────────────────────────────── */}
            <div className="flex items-center justify-between">
                <div className="space-y-1">
                    <div className="flex items-center gap-2">
                        <Input
                            value={testName}
                            onChange={(e) => setTestName(e.target.value)}
                            className="text-2xl font-bold h-auto border-transparent hover:border-input px-0 w-[400px] focus-visible:ring-0"
                            placeholder="Enter test case name..."
                        />
                        <Badge
                            variant={testStatus === "passed" ? "default" : testStatus === "failed" ? "destructive" : "outline"}
                            className={testStatus === "passed" ? "bg-green-600 hover:bg-green-600" : ""}
                        >
                            {isInternalNew ? "Draft" : testStatus.toUpperCase()}
                        </Badge>
                    </div>
                    <p className="text-muted-foreground text-sm">
                        {isInternalNew ? "Creating a new automated test" : `Editing test ID: ${currentId}`}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" onClick={handleSave} disabled={isSaving}>
                        {isSaving ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                            <Save className="mr-2 h-4 w-4" />
                        )}
                        Save
                    </Button>
                    <Button
                        className="bg-green-600 hover:bg-green-700"
                        onClick={handleRunTest}
                        disabled={steps.length === 0 || isInternalNew || isRunning || isSaving}
                    >
                        {isRunning ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                            <Play className="mr-2 h-4 w-4" />
                        )}
                        {isRunning ? "Running..." : "Run Test"}
                    </Button>
                </div>
            </div>

            {/* ══════════════════════════════════════════════════════════════
                SECTION 1 — Test Case Source
               ══════════════════════════════════════════════════════════════ */}
            <div className="space-y-3">
                <div>
                    <h3 className="text-lg font-semibold flex items-center gap-2">
                        <FileText className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                        Test Case Source
                    </h3>
                    <p className="text-sm text-muted-foreground mt-0.5">
                        Provide a test case via manual input or import user stories from Jira.
                    </p>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                    {/* Card 1 — Manual Test Case Input */}
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

                    {/* Card 2 — Import from Jira */}
                    <JiraImportPanel
                        onImport={(stories) => {
                            setPrompt((prev) => {
                                const newContent = stories.join("\n")
                                return prev ? prev + "\n" + newContent : newContent
                            })
                        }}
                    />
                </div>
            </div>

            {/* ── Flow Arrow ──────────────────────────────────────────────── */}
            <div className="flex justify-center -my-1">
                <div className="flex flex-col items-center gap-0.5 text-muted-foreground">
                    <ArrowDown className="h-4 w-4 animate-bounce" />
                </div>
            </div>

            {/* ══════════════════════════════════════════════════════════════
                SECTION 2 — AI Test Step Generator
               ══════════════════════════════════════════════════════════════ */}
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

            {/* ── Flow Arrow ──────────────────────────────────────────────── */}
            <div className="flex justify-center -my-1">
                <div className="flex flex-col items-center gap-0.5 text-muted-foreground">
                    <ArrowDown className="h-4 w-4 animate-bounce" />
                </div>
            </div>

            {/* ══════════════════════════════════════════════════════════════
                SECTION 3 — Configuration + Test Steps (side by side)
               ══════════════════════════════════════════════════════════════ */}
            <div className="grid gap-5 md:grid-cols-3 items-start">
                {/* Left — Configuration */}
                <Card>
                    <CardHeader className="border-b">
                        <CardTitle className="text-base">Configuration</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4 pt-4">
                        <div className="space-y-2">
                            <span className="text-sm font-medium">Project Mapping</span>
                            <Select value={selectedProjectId} onValueChange={(val) => { setSelectedProjectId(val); setProjectError(false) }}>
                                <SelectTrigger className={projectError ? "border-red-500 ring-1 ring-red-500" : ""}>
                                    <SelectValue placeholder="Select a project *" />
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
                        <div className="space-y-2">
                            <span className="text-sm font-medium">Priority</span>
                            <Select value={priority} onValueChange={setPriority}>
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="low">Low</SelectItem>
                                    <SelectItem value="medium">Medium</SelectItem>
                                    <SelectItem value="high">High</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-2">
                            <span className="text-sm font-medium">Description</span>
                            <Textarea
                                className="text-xs h-[80px]"
                                placeholder="Brief description..."
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                            />
                        </div>
                    </CardContent>
                </Card>

                {/* Right — Test Steps */}
                <Card className="md:col-span-2">
                    <CardHeader className="border-b">
                        <CardTitle className="text-base">Test Steps ({steps.length})</CardTitle>
                        <CardAction>
                            <Button variant="ghost" size="sm" onClick={addStep} className="text-blue-600 hover:text-blue-700 hover:bg-blue-50">
                                <Plus className="mr-2 h-4 w-4" />
                                Add Step
                            </Button>
                        </CardAction>
                    </CardHeader>
                    <CardContent className="pt-4">
                        <div className="space-y-3">
                            {steps.map((step, index) => (
                                <Card key={step.id} className="group hover:border-blue-400 transition-all duration-200">
                                    <CardContent className="p-4 flex items-start gap-4">
                                        <div className="mt-2 text-muted-foreground cursor-grab active:cursor-grabbing">
                                            <GripVertical className="h-4 w-4" />
                                        </div>
                                        <div className="flex-1 grid grid-cols-12 gap-3">
                                            <div className="col-span-1 pt-2 font-mono text-sm text-muted-foreground">
                                                #{index + 1}
                                            </div>
                                            <div className="col-span-3">
                                                <Select
                                                    value={step.action}
                                                    onValueChange={(val) => updateStep(step.id, "action", val)}
                                                >
                                                    <SelectTrigger className="h-9">
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
                                                />
                                            </div>
                                            <div className="col-span-4">
                                                <Input
                                                    placeholder="Value"
                                                    value={step.value}
                                                    onChange={(e) => updateStep(step.id, "value", e.target.value)}
                                                    className="h-9 focus-visible:ring-blue-400"
                                                />
                                            </div>
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="opacity-0 group-hover:opacity-100 transition-opacity text-red-500 hover:text-red-600 hover:bg-red-50"
                                            onClick={() => removeStep(step.id)}
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
                    </CardContent>
                </Card>
            </div>

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
                                            <span className="font-mono text-muted-foreground w-6">#{log.step_order}</span>
                                            <div className="flex-1">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <Badge variant="outline" className="text-[10px] uppercase font-bold px-1 h-4">{log.action}</Badge>
                                                    <Badge variant={log.status === 'success' ? 'default' : 'destructive'} className={`${log.status === 'success' ? 'bg-green-500' : ''} text-[10px] px-1 h-4`}>
                                                        {log.status}
                                                    </Badge>
                                                </div>
                                                <div className="text-xs font-medium text-gray-700 dark:text-gray-300">
                                                    {log.target && <span className="text-blue-600 dark:text-blue-400 font-mono mr-1">{log.target}</span>}
                                                    {log.value && <span className="text-gray-500 italic">&quot;{log.value}&quot;</span>}
                                                </div>
                                                {log.error && <p className="text-red-500 text-xs mt-1 font-medium">{log.error}</p>}
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
                                            src={`http://localhost:8000${lastRunResult.screenshot_path}`}
                                            alt="Test Run Screenshot"
                                            className="w-full h-auto object-contain max-h-[400px]"
                                        />
                                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                            <Button variant="secondary" size="sm" asChild>
                                                <a href={`http://localhost:8000${lastRunResult.screenshot_path}`} target="_blank" rel="noreferrer">
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
        </div>
    )
}

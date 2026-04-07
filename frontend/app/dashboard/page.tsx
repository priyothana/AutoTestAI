"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Activity, CheckCircle2, Play, Users, AlertCircle, Sparkles, Save, Loader2, FileText, BarChart2, BookOpen, Code2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from "recharts"
import { formatDistanceToNow } from "date-fns"

export default function DashboardPage() {
    // AI Generator State
    const [prompt, setPrompt] = useState("")
    const [isLoading, setIsLoading] = useState(false)
    const [generatedTest, setGeneratedTest] = useState<any>(null)
    const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null)
    const [selectedProvider, setSelectedProvider] = useState("claude")

    // Analytics State
    const [stats, setStats] = useState({ total_projects: 0, total_test_cases: 0, total_executions: 0, pass_rate: 0 })
    const [distribution, setDistribution] = useState<{ name: string, value: number, color: string }[]>([])
    const [recentRuns, setRecentRuns] = useState<any[]>([])
    const [isLoadingData, setIsLoadingData] = useState(true)
    const [projects, setProjects] = useState<any[]>([])

    // Readable view state for dashboard
    const [dashReadableSteps, setDashReadableSteps] = useState<string[]>([])
    const [isDashHumanizing, setIsDashHumanizing] = useState(false)
    const [showDashReadable, setShowDashReadable] = useState(false)

    useEffect(() => {
        const safeFetch = async (url: string): Promise<Response | null> => {
            try {
                const controller = new AbortController()
                const timeout = setTimeout(() => controller.abort(), 5000)
                const res = await fetch(url, { signal: controller.signal })
                clearTimeout(timeout)
                return res
            } catch {
                return null
            }
        }

        const fetchDashboardData = async () => {
            setIsLoadingData(true)
            try {
                const [statsRes, distRes, runsRes] = await Promise.all([
                    safeFetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/analytics/dashboard-stats`),
                    safeFetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/analytics/execution-distribution`),
                    safeFetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/test-runs/?limit=10`)
                ])

                if (statsRes?.ok) setStats(await statsRes.json())

                if (distRes?.ok) {
                    const distData = await distRes.json()
                    const formattedDist = distData.map((d: any) => ({
                        name: d.result.charAt(0).toUpperCase() + d.result.slice(1),
                        value: d.count,
                        // Updated to brand palette colors
                        color: d.result === 'passed' ? '#22c55e' : d.result === 'error' || d.result === 'failed' ? '#ef4444' : d.result === 'running' ? '#6b6bff' : '#f59e0b'
                    }))
                    setDistribution(formattedDist)
                }

                if (runsRes?.ok) setRecentRuns(await runsRes.json())

            } catch (error) {
                console.error("Failed to fetch dashboard data:", error)
            } finally {
                setIsLoadingData(false)
            }
        }

        fetchDashboardData()

        // Fetch projects for save
        const fetchProjects = async () => {
            try {
                const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/`)
                if (res?.ok) setProjects(await res.json())
            } catch { }
        }
        fetchProjects()
    }, [])

    const handleGenerate = async () => {
        if (!prompt.trim()) return

        setIsLoading(true)
        setStatusMessage(null)
        setGeneratedTest(null)

        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/tests/generate-test-steps`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ prompt, provider: selectedProvider, project_id: projects.length > 0 ? projects[0].id : undefined }),
            })

            const data = await response.json()

            if (!response.ok) {
                throw new Error(data.detail || "Failed to generate test case")
            }

            setGeneratedTest(data)
            setStatusMessage({ type: 'success', text: "Test case generated successfully!" })
        } catch (error: any) {
            console.error("Generate error:", error)
            setStatusMessage({ type: 'error', text: error.message || "Failed to generate test case." })
        } finally {
            setIsLoading(false)
        }
    }

    const handleSave = async () => {
        if (!generatedTest) return

        setIsLoading(true)
        setStatusMessage(null)

        try {
            console.log("Saving test...", generatedTest)

            const projectId = projects.length > 0 ? projects[0].id : null
            if (!projectId) {
                setStatusMessage({ type: 'error', text: "No environments available. Please create an environment first." })
                setIsLoading(false)
                return
            }

            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/tests`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    name: generatedTest.name,
                    project_id: projectId,
                    steps: generatedTest.steps,
                    description: generatedTest.description,
                    priority: generatedTest.priority
                }),
            })

            const data = await response.json()
            console.log("Save response details:", response.status, data)

            if (!response.ok) {
                throw new Error(data.detail || "Failed to save test")
            }

            // Update generated test with ID from backend if needed, or just notify
            setGeneratedTest({ ...generatedTest, id: data.id })
            setStatusMessage({ type: 'success', text: `Test saved successfully! ID: ${data.id}` })
            // alert(`Test saved successfully with ID: ${data.id}`)
        } catch (error: any) {
            console.error("Save error:", error)
            setStatusMessage({ type: 'error', text: error.message || "Error saving test" })
        } finally {
            setIsLoading(false)
        }
    }

    const handleDashHumanize = async () => {
        if (!generatedTest?.steps?.length) return
        if (showDashReadable) { setShowDashReadable(false); return }

        setIsDashHumanizing(true)
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/tests/humanize-steps`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ steps: generatedTest.steps, provider: selectedProvider })
            })
            if (!response.ok) throw new Error("Failed")
            const data = await response.json()
            setDashReadableSteps(data.readable_steps || [])
            setShowDashReadable(true)
        } catch {
            // silently fail
        } finally {
            setIsDashHumanizing(false)
        }
    }

    const handleRun = async () => {
        if (!generatedTest) return

        setIsLoading(true)
        setStatusMessage(null)

        try {
            console.log("Running test...", generatedTest)
            // Use ID if saved, otherwise maybe full object? Requirement says "test_case_id: generatedTest.id (or full test object if no ID yet)"
            // Assuming API supports just ID for now based on typical patterns, but passing object if ID missing might be needed if API assumes it.
            // Requirement: "{ test_case_id: generatedTest.id (or full test object if no ID yet) }"

            const payload = generatedTest.id
                ? { test_case_id: generatedTest.id, environment: "default" }
                : { test_case: generatedTest, environment: "default" } // Fallback if API supports ad-hoc run

            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/test-runs`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(payload),
            })

            const data = await response.json()
            console.log("Run response details:", response.status, data)

            if (!response.ok) {
                throw new Error(data.detail || "Failed to start execution")
            }

            setStatusMessage({ type: 'success', text: `Test execution started! ID: ${data.id}` })
            // alert(`Test execution started with ID: ${data.id}`)
        } catch (error: any) {
            console.error("Run error:", error)
            setStatusMessage({ type: 'error', text: error.message || "Error running test" })
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <div className="space-y-8">
            <div>
                <h2 className="page-title">Dashboard</h2>
                <p className="page-subtitle">Overview of your testing activity and reports.</p>
            </div>

            {/* AI Generator Section */}
            <Card style={{ borderColor: 'var(--color-brand)', backgroundColor: 'var(--color-brand-light)', borderLeftWidth: '3px', borderLeftStyle: 'solid', borderLeftColor: 'var(--color-brand)' }}>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Sparkles className="h-5 w-5" style={{ color: 'var(--color-brand)' }} />
                        AI Test Generator
                    </CardTitle>
                    <CardDescription>
                        Describe your test scenario using natural language and let AI generate the steps for you.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <Textarea
                            placeholder="e.g., Verify that a user can login with valid credentials and sees the dashboard..."
                            className="min-h-[100px] bg-background"
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                        />
                        <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2">
                                <label htmlFor="model-select" className="text-sm font-medium text-muted-foreground whitespace-nowrap">AI Model:</label>
                                <select
                                    id="model-select"
                                    value={selectedProvider}
                                    onChange={(e) => setSelectedProvider(e.target.value)}
                                    className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer"
                                >
                                    <option value="openai">🟢 OpenAI (GPT-4o Mini)</option>
                                    <option value="claude">🟣 Claude (Sonnet 4)</option>
                                </select>
                            </div>
                            <Button onClick={handleGenerate} disabled={isLoading || !prompt.trim()}>
                                {isLoading ? (
                                    <>
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        Generating...
                                    </>
                                ) : (
                                    <>
                                        <Sparkles className="mr-2 h-4 w-4" />
                                        Generate Test
                                    </>
                                )}
                            </Button>
                        </div>
                    </div>

                    {statusMessage && (
                        <div
                            className="p-4 rounded-[var(--radius-token-md)] flex items-center gap-2 text-sm"
                            style={statusMessage.type === 'success' ? {
                                backgroundColor: 'var(--color-success-light)',
                                color: 'var(--color-success)',
                                borderLeft: '3px solid var(--color-success)',
                            } : {
                                backgroundColor: 'var(--color-danger-light)',
                                color: 'var(--color-danger)',
                                borderLeft: '3px solid var(--color-danger)',
                            }}
                        >
                            {statusMessage.type === 'success' ?
                                <CheckCircle2 className="h-4 w-4" /> :
                                <AlertCircle className="h-4 w-4" />
                            }
                            {statusMessage.text}
                        </div>
                    )}

                    {generatedTest && (
                        <div className="mt-4 border rounded-md p-4 bg-background animate-in fade-in slide-in-from-top-4">
                            <div className="flex items-start justify-between mb-4">
                                <div>
                                    <h3 className="font-semibold text-lg">{generatedTest.name}</h3>
                                    <Badge variant="outline" className="mt-1">{generatedTest.priority}</Badge>
                                </div>
                                <div className="flex gap-2">
                                    <Button variant="outline" size="sm" onClick={handleSave} disabled={isLoading}>
                                        <Save className="mr-2 h-4 w-4" />
                                        Save
                                    </Button>
                                    <Button size="sm" onClick={handleRun} disabled={isLoading}>
                                        <Play className="mr-2 h-4 w-4" />
                                        Run Test
                                    </Button>
                                </div>
                            </div>
                            <div className="space-y-2">
                                <p className="text-sm font-medium text-muted-foreground">Description:</p>
                                <p className="text-sm">{generatedTest.description}</p>
                            </div>

                            {generatedTest.preconditions && generatedTest.preconditions.length > 0 && (
                                <div className="space-y-2">
                                    <p className="text-sm font-medium text-muted-foreground">Preconditions:</p>
                                    <ul className="list-disc list-inside space-y-1 text-sm bg-muted/30 p-3 rounded-md">
                                        {generatedTest.preconditions.map((pre: string, index: number) => (
                                            <li key={index}>{pre}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <p className="text-sm font-medium text-muted-foreground">Test Steps:</p>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={handleDashHumanize}
                                        disabled={isDashHumanizing}
                                        className={showDashReadable
                                            ? "text-indigo-600 hover:text-indigo-700 h-7 text-xs"
                                            : "text-indigo-600 hover:text-indigo-700 h-7 text-xs"}
                                    >
                                        {isDashHumanizing ? (
                                            <><Loader2 className="mr-1 h-3 w-3 animate-spin" />Converting...</>
                                        ) : showDashReadable ? (
                                            <><Code2 className="mr-1 h-3 w-3" />Technical View</>
                                        ) : (
                                            <><BookOpen className="mr-1 h-3 w-3" />AI Readable</>
                                        )}
                                    </Button>
                                </div>
                                {showDashReadable && dashReadableSteps.length > 0 ? (
                                    <ol className="list-decimal list-inside space-y-1 text-sm bg-indigo-50/50 dark:bg-indigo-950/20 p-3 rounded-md">
                                        {dashReadableSteps.map((text, index) => (
                                            <li key={index} className="text-gray-800 dark:text-gray-200">{text}</li>
                                        ))}
                                    </ol>
                                ) : (
                                    <ul className="list-decimal list-inside space-y-1 text-sm bg-muted/50 p-3 rounded-md">
                                        {generatedTest.steps.map((step: any, index: number) => (
                                            <li key={index}>
                                                <span className="font-semibold">{step.action}</span>
                                                {step.target && <span className="mx-1 text-muted-foreground">on {step.target}</span>}
                                                {step.value && <span className="mx-1 text-blue-600">"{step.value}"</span>}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>

                            <div className="space-y-2">
                                <p className="text-sm font-medium text-muted-foreground">Expected Outcome:</p>
                                <p className="text-sm bg-green-50 p-2 rounded-md text-green-900 border border-green-100">{generatedTest.expected_outcome}</p>
                            </div>
                        </div>
                    )}
                </CardContent>
            </Card>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                {/* Total Projects — brand accent */}
                <Card style={{ borderLeft: '3px solid var(--color-brand)', paddingLeft: '0' }}>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle style={{ fontSize: '13px', color: 'var(--color-text-muted)', fontWeight: 400 }}>Total Environments</CardTitle>
                        <div className="p-2 rounded-full" style={{ backgroundColor: 'var(--color-brand-light)' }}>
                            <FolderIcon className="h-4 w-4" style={{ color: 'var(--color-brand)' }} />
                        </div>
                    </CardHeader>
                    <CardContent>
                        <div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.03em', lineHeight: 1 }}>
                            {isLoadingData ? <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--color-text-muted)' }} /> : stats.total_projects}
                        </div>
                    </CardContent>
                </Card>

                {/* Total Test Cases — brand accent */}
                <Card style={{ borderLeft: '3px solid var(--color-brand)', paddingLeft: '0' }}>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle style={{ fontSize: '13px', color: 'var(--color-text-muted)', fontWeight: 400 }}>Total Test Cases</CardTitle>
                        <div className="p-2 rounded-full" style={{ backgroundColor: 'var(--color-brand-light)' }}>
                            <FileText className="h-4 w-4" style={{ color: 'var(--color-brand)' }} />
                        </div>
                    </CardHeader>
                    <CardContent>
                        <div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.03em', lineHeight: 1 }}>
                            {isLoadingData ? <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--color-text-muted)' }} /> : stats.total_test_cases}
                        </div>
                    </CardContent>
                </Card>

                {/* Total Executions — info accent */}
                <Card style={{ borderLeft: '3px solid var(--color-info)', paddingLeft: '0' }}>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle style={{ fontSize: '13px', color: 'var(--color-text-muted)', fontWeight: 400 }}>Total Executions</CardTitle>
                        <div className="p-2 rounded-full" style={{ backgroundColor: 'var(--color-info-light)' }}>
                            <Play className="h-4 w-4" style={{ color: 'var(--color-info)' }} />
                        </div>
                    </CardHeader>
                    <CardContent>
                        <div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.03em', lineHeight: 1 }}>
                            {isLoadingData ? <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--color-text-muted)' }} /> : stats.total_executions}
                        </div>
                    </CardContent>
                </Card>

                {/* Pass Rate — success accent */}
                <Card style={{ borderLeft: '3px solid var(--color-success)', paddingLeft: '0' }}>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle style={{ fontSize: '13px', color: 'var(--color-text-muted)', fontWeight: 400 }}>Pass Rate</CardTitle>
                        <div className="p-2 rounded-full" style={{ backgroundColor: 'var(--color-success-light)' }}>
                            <CheckCircle2 className="h-4 w-4" style={{ color: 'var(--color-success)' }} />
                        </div>
                    </CardHeader>
                    <CardContent>
                        <div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.03em', lineHeight: 1 }}>
                            {isLoadingData ? <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--color-text-muted)' }} /> : `${stats.pass_rate}%`}
                        </div>
                    </CardContent>
                </Card>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
                <Card className="col-span-4" style={{ overflow: 'hidden' }}>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <BarChart2 className="h-5 w-5" style={{ color: 'var(--color-text-muted)' }} />
                            Execution Status
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="h-[250px] flex items-center justify-center">
                            {isLoadingData ? (
                                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                            ) : distribution.length > 0 ? (
                                <ResponsiveContainer width="100%" height="100%">
                                    <PieChart>
                                        <Pie
                                            data={distribution}
                                            cx="50%"
                                            cy="50%"
                                            innerRadius={60}
                                            outerRadius={90}
                                            paddingAngle={5}
                                            dataKey="value"
                                        >
                                            {distribution.map((entry, index) => (
                                                <Cell key={`cell-${index}`} fill={entry.color} />
                                            ))}
                                        </Pie>
                                        <Tooltip
                                            contentStyle={{
                                                backgroundColor: 'var(--color-bg-elevated)',
                                                border: '1px solid var(--color-border-sem)',
                                                borderRadius: 'var(--radius-token-md)',
                                                boxShadow: 'var(--shadow-md)',
                                                color: 'var(--color-text-primary)',
                                                fontSize: '13px',
                                            }}
                                            itemStyle={{ color: 'var(--color-text-secondary)' }}
                                            labelStyle={{ color: 'var(--color-text-primary)', fontWeight: 600 }}
                                        />
                                        <Legend
                                            verticalAlign="bottom"
                                            height={36}
                                            formatter={(value) => (
                                                <span style={{ color: 'var(--color-text-secondary)', fontSize: '12px' }}>{value}</span>
                                            )}
                                        />
                                    </PieChart>
                                </ResponsiveContainer>
                            ) : (
                                <div className="p-8 rounded-[var(--radius-token-lg)] text-center w-full" style={{ backgroundColor: 'var(--color-bg-overlay)', color: 'var(--color-text-muted)' }}>
                                    <BarChart2 className="h-10 w-10 mx-auto mb-3" style={{ color: 'var(--color-text-muted)', opacity: 0.4 }} />
                                    <p style={{ fontSize: '14px', color: 'var(--color-text-secondary)', fontWeight: 500 }}>No execution data available.</p>
                                    <p className="text-sm mt-1" style={{ color: 'var(--color-text-muted)' }}>Run tests to see distribution.</p>
                                </div>
                            )}
                        </div>
                    </CardContent>
                </Card>
                <Card className="col-span-3">
                    <CardHeader>
                        <CardTitle>Recent Activity</CardTitle>
                        <CardDescription>
                            Latest test runs and executions.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-4 max-h-[250px] overflow-y-auto pr-2">
                            {isLoadingData ? (
                                <div className="flex justify-center p-4"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
                            ) : recentRuns.length === 0 ? (
                                <div className="text-center p-4 text-muted-foreground text-sm">
                                    No recent test runs. 🚀
                                </div>
                            ) : (
                                recentRuns.slice(0, 5).map((run) => {
                                    const isRunning = run.status === 'running'
                                    const isPassed = run.result === 'passed'
                                    const isFailed = !isRunning && !isPassed
                                    const iconBg = isRunning ? 'var(--color-info-light)' : isPassed ? 'var(--color-success-light)' : 'var(--color-danger-light)'
                                    const iconColor = isRunning ? 'var(--color-info)' : isPassed ? 'var(--color-success)' : 'var(--color-danger)'
                                    return (
                                        <div key={run.id} className="flex items-center gap-4 pb-3 last:pb-0" style={{ borderBottom: '1px solid var(--color-border-sem)' }}>
                                            <div
                                                className={`p-2 rounded-full flex-shrink-0${isRunning ? ' animate-pulse' : ''}`}
                                                style={{ backgroundColor: iconBg, color: iconColor }}
                                            >
                                                {isRunning ? <Play className="h-4 w-4" /> :
                                                    isPassed ? <CheckCircle2 className="h-4 w-4" /> :
                                                        <AlertCircle className="h-4 w-4" />}
                                            </div>
                                            <div className="space-y-1 flex-1 min-w-0">
                                                <p className="text-sm font-medium leading-none truncate" style={{ color: 'var(--color-text-primary)' }}>
                                                    {run.test_case_name || "Test Case"}
                                                </p>
                                                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                                                    {formatDistanceToNow(new Date(run.created_at), { addSuffix: true })}
                                                </p>
                                            </div>
                                            <Badge
                                                variant="outline"
                                                className="text-[10px]"
                                                style={{ color: iconColor, borderColor: iconColor, opacity: 0.85 }}
                                            >
                                                {run.result || run.status}
                                            </Badge>
                                        </div>
                                    )
                                })
                            )}
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    )
}

function FolderIcon(props: any) {
    return (
        <svg
            {...props}
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
        </svg>
    )
}

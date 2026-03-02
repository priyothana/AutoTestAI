"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Activity, CheckCircle2, Play, Users, AlertCircle, Sparkles, Save, Loader2, FileText, BarChart2 } from "lucide-react"
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
    const [selectedProvider, setSelectedProvider] = useState("openai")

    // Analytics State
    const [stats, setStats] = useState({ total_projects: 0, total_test_cases: 0, total_executions: 0, pass_rate: 0 })
    const [distribution, setDistribution] = useState<{ name: string, value: number, color: string }[]>([])
    const [recentRuns, setRecentRuns] = useState<any[]>([])
    const [isLoadingData, setIsLoadingData] = useState(true)

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
                    safeFetch("http://localhost:8000/api/v1/analytics/dashboard-stats"),
                    safeFetch("http://localhost:8000/api/v1/analytics/execution-distribution"),
                    safeFetch("http://localhost:8000/api/v1/test-runs/?limit=10")
                ])

                if (statsRes?.ok) setStats(await statsRes.json())

                if (distRes?.ok) {
                    const distData = await distRes.json()
                    const formattedDist = distData.map((d: any) => ({
                        name: d.result.charAt(0).toUpperCase() + d.result.slice(1),
                        value: d.count,
                        color: d.result === 'passed' ? '#22C55E' : d.result === 'error' || d.result === 'failed' ? '#EF4444' : '#F59E0B'
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
    }, [])

    const handleGenerate = async () => {
        if (!prompt.trim()) return

        setIsLoading(true)
        setStatusMessage(null)
        setGeneratedTest(null)

        try {
            const response = await fetch("http://localhost:8000/api/v1/tests/generate-test-steps", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ prompt, provider: selectedProvider }),
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
            const response = await fetch("http://localhost:8000/api/tests", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    name: generatedTest.name,
                    project_id: 1, // Hardcoded as requested
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

            const response = await fetch("http://localhost:8000/api/executions", {
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
                <h2 className="text-3xl font-bold tracking-tight">Dashboard</h2>
                <p className="text-muted-foreground">Overview of your testing activity and reports.</p>
            </div>

            {/* AI Generator Section */}
            <Card className="border-primary/20 bg-primary/5">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Sparkles className="h-5 w-5 text-primary" />
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
                        <div className={`p-4 rounded-md flex items-center gap-2 text-sm ${statusMessage.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
                            }`}>
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
                                <p className="text-sm font-medium text-muted-foreground">Test Steps:</p>
                                <ul className="list-decimal list-inside space-y-1 text-sm bg-muted/50 p-3 rounded-md">
                                    {generatedTest.steps.map((step: any, index: number) => (
                                        <li key={index}>
                                            <span className="font-semibold">{step.action}</span>
                                            {step.target && <span className="mx-1 text-muted-foreground">on {step.target}</span>}
                                            {step.value && <span className="mx-1 text-blue-600">"{step.value}"</span>}
                                        </li>
                                    ))}
                                </ul>
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
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Total Projects</CardTitle>
                        <FolderIcon className="h-4 w-4 text-primary" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">
                            {isLoadingData ? <Loader2 className="h-5 w-5 animate-spin" /> : stats.total_projects}
                        </div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Total Test Cases</CardTitle>
                        <FileText className="h-4 w-4 text-blue-500" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">
                            {isLoadingData ? <Loader2 className="h-5 w-5 animate-spin" /> : stats.total_test_cases}
                        </div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Total Executions</CardTitle>
                        <Play className="h-4 w-4 text-indigo-500" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">
                            {isLoadingData ? <Loader2 className="h-5 w-5 animate-spin" /> : stats.total_executions}
                        </div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Pass Rate</CardTitle>
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">
                            {isLoadingData ? <Loader2 className="h-5 w-5 animate-spin" /> : `${stats.pass_rate}%`}
                        </div>
                    </CardContent>
                </Card>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
                <Card className="col-span-4">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <BarChart2 className="h-5 w-5 text-muted-foreground" />
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
                                        <Tooltip />
                                        <Legend verticalAlign="bottom" height={36} />
                                    </PieChart>
                                </ResponsiveContainer>
                            ) : (
                                <div className="text-muted-foreground bg-muted/30 p-8 rounded-lg text-center w-full">
                                    <p>No execution data available.</p>
                                    <p className="text-sm mt-1">Run tests to see distribution.</p>
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
                                recentRuns.slice(0, 5).map((run) => (
                                    <div key={run.id} className="flex items-center gap-4 border-b border-border/50 pb-3 last:border-0 last:pb-0">
                                        <div className={`p-2 rounded-full ${run.status === 'running' ? 'bg-blue-100 text-blue-600 animate-pulse' :
                                            run.result === 'passed' ? 'bg-green-100 text-green-600' :
                                                'bg-red-100 text-red-600'
                                            }`}>
                                            {run.status === 'running' ? <Play className="h-4 w-4" /> :
                                                run.result === 'passed' ? <CheckCircle2 className="h-4 w-4" /> :
                                                    <AlertCircle className="h-4 w-4" />}
                                        </div>
                                        <div className="space-y-1 flex-1 min-w-0">
                                            <p className="text-sm font-medium leading-none truncate">
                                                {run.test_case_name || "Test Case"}
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                {formatDistanceToNow(new Date(run.created_at), { addSuffix: true })}
                                            </p>
                                        </div>
                                        <Badge variant="outline" className={`text-[10px] ${run.status === 'running' ? 'border-blue-200 text-blue-600' :
                                            run.result === 'passed' ? 'border-green-200 text-green-600' :
                                                'border-red-200 text-red-600'
                                            }`}>
                                            {run.result || run.status}
                                        </Badge>
                                    </div>
                                ))
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

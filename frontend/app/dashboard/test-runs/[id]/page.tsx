"use client"

import { use, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowLeft, Clock, CheckCircle2, XCircle, Loader2, Info } from "lucide-react"
import { format } from "date-fns"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { toast } from "sonner"

// Types
type TestRun = {
    id: string
    test_case_id: string
    status: string
    result: string
    duration: number
    logs: LogEntry[]
    created_at: string
}

type LogEntry = {
    step: number | string
    action: string
    target?: string
    value?: string
    status: "success" | "failed" | "pending" | "error"
    error?: string
    screenshot?: string
    timestamp: string
}

export default function TestRunDetailsPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params)
    const router = useRouter()

    const [run, setRun] = useState<TestRun | null>(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        fetchRun()

        // Poll for updates if still running
        const interval = setInterval(() => {
            if (run && (run.status === "running" || run.status === "pending")) {
                fetchRun()
            }
        }, 2000)

        return () => clearInterval(interval)
    }, [id, run?.status])

    const fetchRun = async () => {
        try {
            const response = await fetch(`http://localhost:8000/api/v1/test-runs/${id}`)
            if (response.ok) {
                const data = await response.json()
                setRun(data)
            } else {
                toast.error("Failed to load execution details")
            }
        } catch (error) {
            console.error("Fetch error:", error)
        } finally {
            setLoading(false)
        }
    }

    if (loading) {
        return (
            <div className="flex h-[50vh] items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    if (!run) {
        return (
            <div className="flex flex-col items-center justify-center gap-4 py-20">
                <Info className="h-10 w-10 text-muted-foreground" />
                <h3 className="text-xl font-semibold">Test Run Not Found</h3>
                <Button variant="outline" onClick={() => router.back()}>
                    Go Back
                </Button>
            </div>
        )
    }

    return (
        <div className="space-y-6 max-w-5xl mx-auto pb-10">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <Button variant="ghost" size="icon" onClick={() => router.back()}>
                        <ArrowLeft className="h-4 w-4" />
                    </Button>
                    <div>
                        <h2 className="text-2xl font-bold tracking-tight flex items-center gap-3">
                            Test Execution #{run.id.slice(0, 8)}
                            <StatusBadge status={run.status} result={run.result} />
                        </h2>
                        <p className="text-muted-foreground flex items-center gap-2 mt-1">
                            <Clock className="h-3 w-3" />
                            {format(new Date(run.created_at), "PPP p")}
                            {run.duration && <span className="text-xs bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-full ml-2">{run.duration.toFixed(2)}s</span>}
                        </p>
                    </div>
                </div>
                <Button variant="outline" onClick={fetchRun}>
                    Refresh
                </Button>
            </div>

            {/* Logs & Steps */}
            <Card>
                <CardHeader>
                    <CardTitle>Execution Logs</CardTitle>
                    <CardDescription>Detailed step-by-step execution report.</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                    <ScrollArea className="h-[600px]">
                        <div className="divide-y">
                            {run.logs.map((log, index) => (
                                <div key={index} className={`p-4 flex gap-4 ${log.status === 'failed' || log.status === 'error' ? 'bg-red-50 dark:bg-red-950/20' : ''}`}>
                                    <div className="mt-1">
                                        {log.status === "success" && <CheckCircle2 className="h-5 w-5 text-green-500" />}
                                        {(log.status === "failed" || log.status === "error") && <XCircle className="h-5 w-5 text-red-500" />}
                                        {log.status === "pending" && <Loader2 className="h-5 w-5 animate-spin text-blue-500" />}
                                    </div>
                                    <div className="flex-1 space-y-1">
                                        <div className="flex items-center justify-between">
                                            <span className="font-semibold text-sm">
                                                Step {log.step}: {log.action}
                                            </span>
                                            <span className="text-xs text-muted-foreground font-mono">
                                                {format(new Date(log.timestamp), "HH:mm:ss.SSS")}
                                            </span>
                                        </div>

                                        {(log.target || log.value) && (
                                            <div className="text-xs font-mono text-muted-foreground bg-slate-50 dark:bg-slate-900 p-2 rounded border mt-1">
                                                {log.target && <div>Target: {log.target}</div>}
                                                {log.value && <div>Value: {log.value}</div>}
                                            </div>
                                        )}

                                        {log.error && (
                                            <div className="text-sm text-red-600 dark:text-red-400 mt-1 font-medium bg-red-100 dark:bg-red-900/30 p-2 rounded">
                                                Error: {log.error}
                                            </div>
                                        )}

                                        {log.screenshot && (
                                            <div className="mt-2">
                                                <img
                                                    src={`http://localhost:8000/${log.screenshot}`}
                                                    alt="Failure Screenshot"
                                                    className="rounded border shadow-sm max-w-sm"
                                                />
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                            {run.logs.length === 0 && (
                                <div className="p-8 text-center text-muted-foreground">
                                    No logs available yet. Execution might be starting...
                                </div>
                            )}
                        </div>
                    </ScrollArea>
                </CardContent>
            </Card>
        </div>
    )
}

function StatusBadge({ status, result }: { status: string, result: string }) {
    if (status === "running") return <Badge variant="secondary" className="animate-pulse bg-blue-100 text-blue-700">Running</Badge>
    if (status === "pending") return <Badge variant="secondary">Pending</Badge>
    if (result === "passed") return <Badge className="bg-green-600 hover:bg-green-700">Passed</Badge>
    if (result === "failed") return <Badge variant="destructive">Failed</Badge>
    if (result === "error") return <Badge variant="destructive">Error</Badge>
    return <Badge variant="outline">{status}</Badge>
}

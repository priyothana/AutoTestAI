"use client"

import { useState, useEffect, use } from "react"
import { format } from "date-fns"
import {
    CheckCircle2,
    XCircle,
    Clock,
    ArrowLeft,
    Loader2,
    Calendar,
    ExternalLink,
    Image as ImageIcon
} from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card"
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"

type LogEntry = {
    step_order: number
    action: string
    target?: string
    value?: string
    status: string
    started_at: string
    ended_at?: string
    duration_ms?: number
    error?: string
    screenshot_url?: string
}

type TestRun = {
    id: string
    test_case_id: string
    status: string
    result?: string
    duration?: number
    logs: LogEntry[]
    created_at: string
}

export default function ExecutionDetailsPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params)
    const [run, setRun] = useState<TestRun | null>(null)
    const [isLoading, setIsLoading] = useState(true)

    useEffect(() => {
        fetchRun()

        const interval = setInterval(() => {
            if (run && (run.status === "running" || run.status === "pending")) {
                fetchRun()
            }
        }, 3000)

        return () => clearInterval(interval)
    }, [id, run?.status])

    const fetchRun = async () => {
        try {
            const response = await fetch(`http://localhost:8000/api/v1/test-runs/${id}`)
            if (response.ok) {
                const data = await response.json()
                setRun(data)
            } else if (response.status === 404) {
                console.warn("Run not found")
            }
        } catch (error) {
            console.error("Failed to fetch run details:", error)
        } finally {
            setIsLoading(false)
        }
    }

    if (isLoading) {
        return (
            <div className="flex h-[400px] items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    if (!run) {
        return (
            <div className="text-center py-20">
                <h2 className="text-xl font-semibold">Run not found</h2>
                <Button variant="link" asChild>
                    <Link href="/dashboard/execution">Go back to executions</Link>
                </Button>
            </div>
        )
    }

    const isPassed = run.result === "passed"
    const isFailed = run.result === "failed"

    return (
        <div className="space-y-6 max-w-6xl mx-auto">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <Button variant="ghost" size="icon" asChild>
                        <Link href="/dashboard/execution">
                            <ArrowLeft className="h-5 w-5" />
                        </Link>
                    </Button>
                    <div>
                        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                            Run Details: <span className="font-mono text-lg text-muted-foreground">{run.id.substring(0, 8)}</span>
                        </h1>
                        <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
                            <span className="flex items-center gap-1">
                                <Calendar className="h-3 w-3" />
                                {format(new Date(run.created_at), "MMM d, yyyy HH:mm:ss")}
                            </span>
                            <span className="flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {run.duration ? `${run.duration.toFixed(2)}s` : "--"}
                            </span>
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {run.status === "running" ? (
                        <Badge variant="secondary" className="bg-blue-100 text-blue-700">
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Running
                        </Badge>
                    ) : isPassed ? (
                        <Badge className="bg-green-500 hover:bg-green-600 text-white">
                            <CheckCircle2 className="mr-1 h-3 w-3" /> Passed
                        </Badge>
                    ) : (
                        <Badge variant="destructive">
                            <XCircle className="mr-1 h-3 w-3" /> Failed
                        </Badge>
                    )}

                    {run.status !== "running" && (
                        <Button variant="outline" size="sm" asChild>
                            <a href={`http://localhost:8000/screenshots/trace-${run.id}.zip`} download>
                                <ExternalLink className="mr-2 h-4 w-4" />
                                Download Trace
                            </a>
                        </Button>
                    )}
                </div>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>Execution Steps</CardTitle>
                    <CardDescription>Detailed logs for each action taken during this run.</CardDescription>
                </CardHeader>
                <CardContent>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="w-[80px]">Order</TableHead>
                                <TableHead>Action</TableHead>
                                <TableHead>Target/Value</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead>Duration</TableHead>
                                <TableHead className="text-right">Evidence</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {run.logs.map((log, index) => (
                                <TableRow key={index} className={log.status === 'failed' ? 'bg-red-50/50 dark:bg-red-950/10' : ''}>
                                    <TableCell className="font-mono text-muted-foreground">#{log.step_order}</TableCell>
                                    <TableCell>
                                        <Badge variant="outline" className="capitalize">{log.action}</Badge>
                                    </TableCell>
                                    <TableCell>
                                        <div className="max-w-[300px] truncate group border-none bg-transparent">
                                            <div className="text-xs font-mono text-muted-foreground truncate">{log.target}</div>
                                            <div className="text-sm truncate">{log.value}</div>
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        {log.status === "success" ? (
                                            <span className="flex items-center text-green-600 text-sm font-medium">
                                                <CheckCircle2 className="mr-1 h-4 w-4" /> Success
                                            </span>
                                        ) : log.status === "failed" ? (
                                            <div className="flex flex-col gap-1">
                                                <span className="flex items-center text-red-600 text-sm font-medium">
                                                    <XCircle className="mr-1 h-4 w-4" /> Failed
                                                </span>
                                                {log.error && (
                                                    <span className="text-[10px] text-red-500 leading-tight break-words max-w-[200px]">
                                                        {log.error}
                                                    </span>
                                                )}
                                            </div>
                                        ) : (
                                            <span className="text-sm text-muted-foreground italic flex items-center">
                                                <Loader2 className="mr-1 h-3 w-3 animate-spin" /> {log.status}
                                            </span>
                                        )}
                                    </TableCell>
                                    <TableCell className="text-sm text-muted-foreground">
                                        {log.duration_ms ? `${(log.duration_ms / 1000).toFixed(2)}s` : "--"}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        {log.screenshot_url && (
                                            <Button variant="outline" size="sm" asChild>
                                                <a href={`http://localhost:8000${log.screenshot_url}`} target="_blank" rel="noreferrer">
                                                    <ImageIcon className="mr-2 h-4 w-4" />
                                                    Screenshot
                                                </a>
                                            </Button>
                                        )}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    )
}

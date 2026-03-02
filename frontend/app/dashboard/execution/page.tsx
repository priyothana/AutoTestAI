"use client"

import { useState, useEffect, Fragment } from "react"
import { format } from "date-fns"
import {
    PlayCircle,
    CheckCircle2,
    XCircle,
    Clock,
    ExternalLink,
    Loader2,
    Search,
    Filter,
    ChevronRight,
    AlertCircle,
    Trash2,
    Eye
} from "lucide-react"
import Link from "next/link"

import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card"

// Update type
type LogEntry = {
    step_order: number
    action: string
    target?: string
    value?: string
    status: string
    error?: string
}

type TestRun = {
    id: string
    test_case_id: string
    test_case_name?: string
    status: string
    result?: string
    duration?: number
    created_at: string
    logs?: LogEntry[]
    screenshot_path?: string
}

export default function ExecutionPage() {
    const [runs, setRuns] = useState<TestRun[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [searchTerm, setSearchTerm] = useState("")
    const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({})
    const [deletingId, setDeletingId] = useState<string | null>(null)
    const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null)

    const toggleRow = (id: string, e?: React.MouseEvent) => {
        if (e) e.stopPropagation();
        setExpandedRows(prev => ({ ...prev, [id]: !prev[id] }))
    }

    const safeFetch = async (url: string, options?: RequestInit): Promise<Response | null> => {
        try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 5000)
            const res = await fetch(url, { ...options, signal: controller.signal })
            clearTimeout(timeout)
            return res
        } catch {
            return null
        }
    }

    const handleDelete = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setDeletingId(id);
        try {
            const response = await safeFetch(`http://localhost:8000/api/v1/test-runs/${id}`, {
                method: 'DELETE',
            });

            if (!response?.ok) {
                throw new Error('Failed to delete test run');
            }

            setRuns(prev => prev.filter(run => run.id !== id));
            setShowDeleteConfirm(null);
        } catch (error) {
            console.error("Error deleting run:", error);
        } finally {
            setDeletingId(null);
        }
    }


    useEffect(() => {
        fetchRuns(true)
        const interval = setInterval(() => {
            if (document.visibilityState === 'visible') {
                fetchRuns(false)
            }
        }, 5000)
        return () => clearInterval(interval)
    }, [])


    const fetchRuns = async (showLoading = false) => {
        if (showLoading) setIsLoading(true)
        try {
            const response = await safeFetch("http://localhost:8000/api/v1/test-runs")
            if (!response) {
                // Network error - silently fail, keep existing data
                return
            }
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || `Failed to fetch runs (${response.status})`);
            }
            const data = await response.json()
            setRuns(Array.isArray(data) ? data : [])
        } catch (error: any) {
            console.error("Failed to fetch runs:", error)
        } finally {
            if (showLoading) setIsLoading(false)
        }
    }

    const getStatusBadge = (status: string, result?: string) => {
        const displayStatus = result || status
        switch (displayStatus.toLowerCase()) {
            case "passed":
                return <Badge className="bg-green-500 hover:bg-green-600"><CheckCircle2 className="mr-1 h-3 w-3" /> Passed</Badge>
            case "failed":
                return <Badge variant="destructive"><XCircle className="mr-1 h-3 w-3" /> Failed</Badge>
            case "running":
                return <Badge variant="secondary" className="bg-blue-100 text-blue-700 animate-pulse"><Loader2 className="mr-1 h-3 w-3 animate-spin" /> Running</Badge>
            case "error":
                return <Badge variant="outline" className="text-orange-500 border-orange-500"><AlertCircle className="mr-1 h-3 w-3" /> Error</Badge>
            default:
                return <Badge variant="outline">{displayStatus}</Badge>
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Execution History</h1>
                    <p className="text-muted-foreground">
                        Monitor and review all automated test executions.
                    </p>
                </div>
                <Button variant="outline" onClick={() => fetchRuns(true)} disabled={isLoading}>
                    {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PlayCircle className="mr-2 h-4 w-4" />}
                    Refresh
                </Button>
            </div>

            <Card>
                <CardHeader className="pb-3">
                    <div className="flex items-center gap-4">
                        <div className="relative flex-1">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                                placeholder="Search by test case..."
                                className="pl-9"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                            />
                        </div>
                        <Button variant="outline" size="icon">
                            <Filter className="h-4 w-4" />
                        </Button>
                    </div>
                </CardHeader>
                <CardContent>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Run ID</TableHead>
                                <TableHead>Test Case</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead>Duration</TableHead>
                                <TableHead>Executed At</TableHead>
                                <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading && runs.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={6} className="text-center py-10">
                                        <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
                                    </TableCell>
                                </TableRow>
                            ) : runs.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
                                        No executions found. Run a test to see it here.
                                    </TableCell>
                                </TableRow>
                            ) : runs.filter(run => (run.test_case_name || "").toLowerCase().includes(searchTerm.toLowerCase())).map((run) => (
                                <Fragment key={run.id}>
                                    <TableRow
                                        className="cursor-pointer hover:bg-muted/50"
                                        onClick={() => toggleRow(run.id)}
                                    >
                                        <TableCell className="font-mono text-xs text-muted-foreground">
                                            <div className="flex items-center gap-2">
                                                <div className={`transition-transform duration-200 ${expandedRows[run.id] ? 'rotate-90' : ''}`}>
                                                    <ChevronRight className="h-4 w-4" />
                                                </div>
                                                {run.id.substring(0, 8)}...
                                            </div>
                                        </TableCell>
                                        <TableCell className="font-medium">
                                            {run.test_case_name || "Untitled Test"}
                                        </TableCell>
                                        <TableCell>
                                            {getStatusBadge(run.status, run.result)}
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex items-center text-sm text-muted-foreground">
                                                <Clock className="mr-1 h-3 w-3" />
                                                {run.duration ? `${run.duration.toFixed(1)}s` : "--"}
                                            </div>
                                        </TableCell>
                                        <TableCell className="text-sm">
                                            {format(new Date(run.created_at), "MMM d, HH:mm:ss")}
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <div className="flex items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                                                <Button variant="ghost" size="sm" onClick={(e) => toggleRow(run.id, e)} className={expandedRows[run.id] ? "bg-muted" : ""}>
                                                    <Eye className="mr-2 h-4 w-4" />
                                                    View
                                                </Button>

                                                {showDeleteConfirm === run.id ? (
                                                    <div className="flex items-center gap-1 bg-red-50 dark:bg-red-900/20 p-1 rounded-md border border-red-200 dark:border-red-800">
                                                        <span className="text-xs text-red-600 dark:text-red-400 font-medium px-2">Sure?</span>
                                                        <Button size="sm" variant="destructive" className="h-7 px-2" onClick={(e) => handleDelete(run.id, e)} disabled={deletingId === run.id}>
                                                            {deletingId === run.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Yes"}
                                                        </Button>
                                                        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(null); }}>
                                                            No
                                                        </Button>
                                                    </div>
                                                ) : (
                                                    <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(run.id); }}>
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button>
                                                )}

                                                <Button variant="ghost" size="icon" asChild>
                                                    <Link href={`/dashboard/execution/${run.id}`}>
                                                        <ExternalLink className="h-4 w-4" />
                                                    </Link>
                                                </Button>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                    {expandedRows[run.id] && (
                                        <TableRow className="bg-muted/30">
                                            <TableCell colSpan={6} className="p-0">
                                                <div className="p-4 border-l-4 border-blue-500 bg-white dark:bg-black/20 m-2 rounded shadow-sm">
                                                    <div className="grid md:grid-cols-2 gap-6">
                                                        <div>
                                                            <h4 className="text-sm font-semibold mb-2 text-blue-700 dark:text-blue-400">Execution Logs</h4>
                                                            {run.logs && run.logs.length > 0 ? (
                                                                <div className="space-y-2 max-h-[300px] overflow-y-auto pr-2">
                                                                    {run.logs.map((log, idx) => (
                                                                        <div key={idx} className="flex items-start gap-3 text-xs border-b border-gray-100 dark:border-gray-800 pb-2 last:border-0 last:pb-0">
                                                                            <span className="font-mono text-muted-foreground w-6">#{log.step_order}</span>
                                                                            <Badge variant="outline" className="text-[10px] h-4 px-1">{log.action}</Badge>
                                                                            <div className="flex-1 min-w-0">
                                                                                <div className="font-medium truncate">{log.target || log.value || "SYSTEM INFO"}</div>
                                                                                {log.error && <p className="text-red-500 mt-1 break-words font-medium">{log.error}</p>}
                                                                            </div>
                                                                            <Badge variant={log.status === 'success' ? 'default' : 'destructive'} className={`${log.status === 'success' ? 'bg-green-500' : ''} text-[10px] h-4 px-1`}>
                                                                                {log.status}
                                                                            </Badge>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            ) : (
                                                                <p className="text-xs text-muted-foreground italic">No logs available for this run yet.</p>
                                                            )}
                                                        </div>
                                                        <div className="border-l border-gray-100 dark:border-gray-800 pl-6">
                                                            <h4 className="text-sm font-semibold mb-2 text-blue-700 dark:text-blue-400">Final Screenshot</h4>
                                                            {run.screenshot_path ? (
                                                                <div className="rounded-md border bg-gray-50 dark:bg-black overflow-hidden group relative max-w-[300px]">
                                                                    <img
                                                                        src={`http://localhost:8000${run.screenshot_path}`}
                                                                        alt="Execution Screenshot"
                                                                        className="w-full h-auto object-contain cursor-zoom-in"
                                                                        onClick={() => window.open(`http://localhost:8000${run.screenshot_path}`, '_blank')}
                                                                    />
                                                                    <div className="absolute bottom-0 inset-x-0 bg-black/60 text-white text-[10px] p-1 text-center opacity-0 group-hover:opacity-100 transition-opacity">
                                                                        Click to enlarge
                                                                    </div>
                                                                </div>
                                                            ) : (
                                                                <div className="h-[150px] max-w-[300px] border-2 border-dashed rounded-md flex flex-col items-center justify-center text-muted-foreground bg-gray-50/50">
                                                                    <p className="text-[10px]">No screenshot available</p>
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    )}
                                </Fragment>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    )
}


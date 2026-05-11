"use client"

import Link from "next/link"
import { Plus, Search, Play, Edit, MoreVertical, FileText, Loader2, Trash2, ChevronUp, ChevronDown, ChevronsUpDown, X, Filter, Sparkles } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { useEffect, useState, useMemo, useCallback } from "react"
import { format } from "date-fns"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu"
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useRouter } from "next/navigation"

interface TestCase {
    id: string
    name: string
    project_id: string
    project_name: string
    description: string
    steps: any[]
    priority: string
    created_at: string
}

type SortField = "created_at" | null
type SortDir = "asc" | "desc"

const priorityStyles: Record<string, string> = {
    high: "bg-red-50 text-red-700 border border-red-200",
    medium: "bg-amber-50 text-amber-700 border border-amber-200",
    low: "bg-green-50 text-green-700 border border-green-200",
}

const PRIORITY_OPTIONS = ["all", "high", "medium", "low"]

function SortIcon({ field, sortField, sortDir }: { field: SortField; sortField: SortField; sortDir: SortDir }) {
    if (sortField !== field) return <ChevronsUpDown className="inline h-3 w-3 ml-1 opacity-40" />
    return sortDir === "asc"
        ? <ChevronUp className="inline h-3 w-3 ml-1 text-primary" />
        : <ChevronDown className="inline h-3 w-3 ml-1 text-primary" />
}

export default function TestsPage() {
    const [tests, setTests] = useState<TestCase[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [selectedTests, setSelectedTests] = useState<Set<string>>(new Set())
    const [isDeletingBulk, setIsDeletingBulk] = useState(false)
    const [searchQuery, setSearchQuery] = useState("")

    const [newTestIds, setNewTestIds] = useState<Set<string>>(new Set())
    const [skeletonCount, setSkeletonCount] = useState(0)

    // Filters
    const [filterEnvironment, setFilterEnvironment] = useState("all")
    const [filterPriority, setFilterPriority] = useState("all")

    // Sort
    const [sortField, setSortField] = useState<SortField>(null)
    const [sortDir, setSortDir] = useState<SortDir>("desc")

    const router = useRouter()

    const fetchTests = async () => {
        setIsLoading(true)
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/tests`)
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}))
                throw new Error(errorData.detail || `Failed to fetch tests (${response.status})`)
            }
            const data = await response.json()
            setTests(Array.isArray(data) ? data : [])
        } catch (error: any) {
            console.error("Failed to fetch tests:", error)
            toast.error(error.message || "Connection error: Could not reach the backend server.")
        } finally {
            setIsLoading(false)
        }
    }

    useEffect(() => { fetchTests() }, [])

    // Called after wizard completes (passed via query params on return)
    useEffect(() => {
        const params = new URLSearchParams(window.location.search)
        const newIds = params.get("new_ids")
        if (newIds) {
            const ids = newIds.split(",").filter(Boolean)
            setNewTestIds(new Set(ids))
            fetchTests().then(() => setTimeout(() => setNewTestIds(new Set()), 6000))
            // Clean URL
            window.history.replaceState({}, "", window.location.pathname)
        }
    }, [])

    // Derive unique environment values from loaded tests
    const environmentOptions = useMemo(() => {
        const envs = Array.from(new Set(tests.map(t => t.project_name).filter(Boolean)))
        return ["all", ...envs]
    }, [tests])

    // Apply filter + sort
    const displayedTests = useMemo(() => {
        let result = [...tests]

        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase()
            result = result.filter(t =>
                t.name?.toLowerCase().includes(q) ||
                t.project_name?.toLowerCase().includes(q)
            )
        }

        if (filterEnvironment !== "all") {
            result = result.filter(t => t.project_name === filterEnvironment)
        }

        if (filterPriority !== "all") {
            result = result.filter(t => t.priority?.toLowerCase() === filterPriority)
        }

        if (sortField === "created_at") {
            result.sort((a, b) => {
                const diff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
                return sortDir === "asc" ? diff : -diff
            })
        }

        return result
    }, [tests, searchQuery, filterEnvironment, filterPriority, sortField, sortDir])

    const handleSort = (field: SortField) => {
        if (sortField === field) {
            setSortDir(prev => prev === "asc" ? "desc" : "asc")
        } else {
            setSortField(field)
            setSortDir("desc")
        }
    }

    const hasActiveFilters = filterEnvironment !== "all" || filterPriority !== "all" || sortField !== null

    const clearFilters = () => {
        setFilterEnvironment("all")
        setFilterPriority("all")
        setSortField(null)
        setSortDir("desc")
    }

    const handleRunTest = async (testId: string) => {
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/test-runs`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ test_case_id: testId })
            })
            if (!response.ok) throw new Error("Failed to start test execution")
            toast.success("Test execution started!")
        } catch (error) {
            console.error("Run error:", error)
            toast.error("Failed to start test execution")
        }
    }

    const handleDeleteTest = async (e: React.MouseEvent, testId: string) => {
        e.stopPropagation()
        if (!window.confirm("Are you sure you want to delete this test case? This action cannot be undone.")) return
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/tests/${testId}`, { method: "DELETE" })
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}))
                throw new Error(errorData.detail || `Failed to delete test (${response.status})`)
            }
            setTests(prev => prev.filter(t => t.id !== testId))
            toast.success("Test case deleted successfully.")
        } catch (error: any) {
            console.error("Delete error:", error)
            toast.error(error.message || "Failed to delete test case.")
        }
    }

    const handleBulkDelete = async () => {
        if (selectedTests.size === 0) return
        if (!window.confirm(`Are you sure you want to delete ${selectedTests.size} test cases? This action cannot be undone.`)) return

        setIsDeletingBulk(true)
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/tests/bulk-delete`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ids: Array.from(selectedTests) }),
            })
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}))
                throw new Error(errorData.detail || `Failed to delete tests (${response.status})`)
            }
            setTests(prev => prev.filter(t => !selectedTests.has(t.id)))
            setSelectedTests(new Set())
            toast.success(`Successfully deleted ${selectedTests.size} test cases.`)
        } catch (error: any) {
            console.error("Bulk delete error:", error)
            toast.error(error.message || "Failed to delete test cases.")
        } finally {
            setIsDeletingBulk(false)
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="page-title">Test Cases</h2>
                    <p className="page-subtitle">Manage and execute your automated test scenarios.</p>
                </div>
                <Button
                    id="create-test-btn"
                    asChild
                    className="bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 text-white shadow-md shadow-violet-200 dark:shadow-violet-900/30 transition-all duration-200 hover:scale-[1.02]"
                >
                    <Link href="/dashboard/tests/create">
                        <Plus className="mr-2 h-4 w-4" />
                        Create Test
                    </Link>
                </Button>
            </div>

            {/* Toolbar */}
            <div className="flex items-center gap-2 flex-wrap">
                <div className="relative flex-1 max-w-sm">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4" style={{ color: 'var(--color-text-muted)' }} />
                    <Input
                        type="search"
                        placeholder="Search tests..."
                        className="pl-8"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                    />
                </div>

                {/* Environment Filter */}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="outline"
                            size="sm"
                            className={filterEnvironment !== "all" ? "border-primary text-primary" : ""}
                        >
                            <Filter className="h-3.5 w-3.5 mr-1.5" />
                            Environment
                            {filterEnvironment !== "all" && (
                                <Badge className="ml-1.5 h-4 px-1 text-[10px]">{filterEnvironment}</Badge>
                            )}
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-48">
                        <DropdownMenuLabel>Filter by Environment</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuRadioGroup value={filterEnvironment} onValueChange={setFilterEnvironment}>
                            {environmentOptions.map(env => (
                                <DropdownMenuRadioItem key={env} value={env} className="capitalize cursor-pointer">
                                    {env === "all" ? "All Environments" : env}
                                </DropdownMenuRadioItem>
                            ))}
                        </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                </DropdownMenu>

                {/* Priority Filter */}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="outline"
                            size="sm"
                            className={filterPriority !== "all" ? "border-primary text-primary" : ""}
                        >
                            <Filter className="h-3.5 w-3.5 mr-1.5" />
                            Priority
                            {filterPriority !== "all" && (
                                <Badge className="ml-1.5 h-4 px-1 text-[10px] capitalize">{filterPriority}</Badge>
                            )}
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-44">
                        <DropdownMenuLabel>Filter by Priority</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuRadioGroup value={filterPriority} onValueChange={setFilterPriority}>
                            {PRIORITY_OPTIONS.map(p => (
                                <DropdownMenuRadioItem key={p} value={p} className="capitalize cursor-pointer">
                                    {p === "all" ? "All Priorities" : p}
                                </DropdownMenuRadioItem>
                            ))}
                        </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                </DropdownMenu>

                {/* Clear Filters */}
                {hasActiveFilters && (
                    <Button variant="ghost" size="sm" onClick={clearFilters} className="text-muted-foreground">
                        <X className="h-3.5 w-3.5 mr-1" />
                        Clear
                    </Button>
                )}

                {/* Bulk Delete */}
                {selectedTests.size > 0 && (
                    <Button
                        variant="destructive"
                        onClick={handleBulkDelete}
                        disabled={isDeletingBulk}
                        className="ml-auto"
                    >
                        {isDeletingBulk ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                        Delete Selected ({selectedTests.size})
                    </Button>
                )}

                {/* Result count */}
                {!isLoading && (
                    <span className="text-xs text-muted-foreground ml-auto">
                        {displayedTests.length} of {tests.length} test{tests.length !== 1 ? "s" : ""}
                    </span>
                )}
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>All Tests</CardTitle>
                    <CardDescription>List of all test cases across environments.</CardDescription>
                </CardHeader>
                <CardContent>
                    <Table className="table-fixed">
                        <TableHeader>
                            <TableRow>
                                <TableHead style={{ width: 40 }} className="pl-4">
                                    <input
                                        type="checkbox"
                                        className="h-4 w-4 rounded border-gray-300 cursor-pointer"
                                        checked={displayedTests.length > 0 && selectedTests.size === displayedTests.length}
                                        onChange={(e) => {
                                            if (e.target.checked) {
                                                setSelectedTests(new Set(displayedTests.map(t => t.id)))
                                            } else {
                                                setSelectedTests(new Set())
                                            }
                                        }}
                                        aria-label="Select all tests"
                                    />
                                </TableHead>
                                <TableHead style={{ width: 55 }} className="text-muted-foreground text-xs">#</TableHead>
                                <TableHead>Test Name</TableHead>
                                {/* Environment — filterable */}
                                <TableHead style={{ width: 140 }}>
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <button className={`flex items-center gap-1 hover:text-foreground transition-colors ${filterEnvironment !== "all" ? "text-primary font-semibold" : ""}`}>
                                                Environment
                                                <Filter className="h-3 w-3 opacity-60" />
                                            </button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="start" className="w-48">
                                            <DropdownMenuLabel>Filter by Environment</DropdownMenuLabel>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuRadioGroup value={filterEnvironment} onValueChange={setFilterEnvironment}>
                                                {environmentOptions.map(env => (
                                                    <DropdownMenuRadioItem key={env} value={env} className="capitalize cursor-pointer">
                                                        {env === "all" ? "All Environments" : env}
                                                    </DropdownMenuRadioItem>
                                                ))}
                                            </DropdownMenuRadioGroup>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </TableHead>
                                <TableHead style={{ width: 60 }}>Steps</TableHead>
                                {/* Priority — filterable */}
                                <TableHead style={{ width: 110 }}>
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <button className={`flex items-center gap-1 hover:text-foreground transition-colors ${filterPriority !== "all" ? "text-primary font-semibold" : ""}`}>
                                                Priority
                                                <Filter className="h-3 w-3 opacity-60" />
                                            </button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="start" className="w-44">
                                            <DropdownMenuLabel>Filter by Priority</DropdownMenuLabel>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuRadioGroup value={filterPriority} onValueChange={setFilterPriority}>
                                                {PRIORITY_OPTIONS.map(p => (
                                                    <DropdownMenuRadioItem key={p} value={p} className="capitalize cursor-pointer">
                                                        {p === "all" ? "All Priorities" : p}
                                                    </DropdownMenuRadioItem>
                                                ))}
                                            </DropdownMenuRadioGroup>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </TableHead>
                                {/* Created — sortable */}
                                <TableHead style={{ width: 140 }}>
                                    <button
                                        onClick={() => handleSort("created_at")}
                                        className={`flex items-center gap-1 hover:text-foreground transition-colors ${sortField === "created_at" ? "text-primary font-semibold" : ""}`}
                                    >
                                        Created
                                        <SortIcon field="created_at" sortField={sortField} sortDir={sortDir} />
                                    </button>
                                </TableHead>
                                <TableHead style={{ width: 170 }} className="text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading ? (
                                <TableRow>
                                    <TableCell colSpan={8} className="text-center py-10">
                                        <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
                                    </TableCell>
                                </TableRow>
                            ) : displayedTests.length === 0 && skeletonCount === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={8} className="text-center p-0">
                                        {tests.length === 0 ? (
                                            /* ── Magic Empty State (Phase 1) ── */
                                            <div className="py-16 px-8 flex flex-col items-center gap-5">
                                                <div className="relative">
                                                    <div className="absolute inset-0 rounded-full bg-violet-400/20 blur-2xl scale-150" />
                                                    <div className="relative p-5 rounded-2xl bg-gradient-to-br from-violet-50 to-purple-50 dark:from-violet-950/40 dark:to-purple-950/30 border border-violet-200 dark:border-violet-800 shadow-lg">
                                                        <Sparkles className="h-10 w-10 text-violet-500" />
                                                    </div>
                                                </div>
                                                <div className="space-y-1 text-center">
                                                    <p className="text-base font-semibold">No test cases yet</p>
                                                    <p className="text-sm text-muted-foreground max-w-xs">Let AI write your entire test suite in seconds — just pick a project and module.</p>
                                                </div>
                                                <div className="flex items-center gap-3">
                                                    <Button
                                                        id="empty-state-generate-btn"
                                                        asChild
                                                        className="bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 text-white shadow-lg shadow-violet-200 dark:shadow-violet-900/30"
                                                    >
                                                        <Link href="/dashboard/tests/create">
                                                            <Sparkles className="mr-2 h-4 w-4" />
                                                            Create Test Suite
                                                        </Link>
                                                    </Button>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="empty-state">
                                                <FileText className="empty-state-icon" />
                                                <p className="empty-state-title">No tests match the current filters</p>
                                                <p className="empty-state-message">Try adjusting your filters or search query.</p>
                                                <Button variant="outline" size="sm" className="mt-4" onClick={clearFilters}>Clear Filters</Button>
                                            </div>
                                        )}
                                    </TableCell>
                                </TableRow>
                            ) : (
                                <>
                                {/* ── Skeleton Rows (Phase 3 - during generation) ── */}
                                {skeletonCount > 0 && Array.from({ length: skeletonCount }).map((_, i) => (
                                    <TableRow key={`skeleton-${i}`} className="animate-pulse">
                                        <TableCell className="pl-4"><div className="h-4 w-4 rounded bg-muted" /></TableCell>
                                        <TableCell><div className="h-3 w-5 rounded bg-muted" /></TableCell>
                                        <TableCell>
                                            <div className="flex items-center gap-2">
                                                <div className="h-4 w-4 rounded bg-muted shrink-0" />
                                                <div className="h-3 rounded bg-muted" style={{ width: `${140 + (i * 37) % 80}px` }} />
                                            </div>
                                        </TableCell>
                                        <TableCell><div className="h-3 w-20 rounded bg-muted" /></TableCell>
                                        <TableCell><div className="h-3 w-6 rounded bg-muted" /></TableCell>
                                        <TableCell><div className="h-5 w-14 rounded-full bg-muted" /></TableCell>
                                        <TableCell><div className="h-3 w-20 rounded bg-muted" /></TableCell>
                                        <TableCell><div className="h-7 w-16 rounded bg-muted ml-auto" /></TableCell>
                                    </TableRow>
                                ))}
                                {/* ── Test Rows ── */}
                                {displayedTests.map((test, index) => (
                                <TableRow
                                    key={test.id}
                                    className="group hover:bg-muted/50 cursor-pointer transition-colors"
                                    onClick={() => router.push(`/dashboard/tests/${test.id}`)}
                                >
                                    <TableCell className="pl-4" onClick={(e) => e.stopPropagation()}>
                                        <input
                                            type="checkbox"
                                            className="h-4 w-4 rounded border-gray-300 cursor-pointer"
                                            checked={selectedTests.has(test.id)}
                                            onChange={(e) => {
                                                const newSet = new Set(selectedTests)
                                                if (e.target.checked) newSet.add(test.id)
                                                else newSet.delete(test.id)
                                                setSelectedTests(newSet)
                                            }}
                                            aria-label={`Select test ${test.name}`}
                                        />
                                    </TableCell>
                                    <TableCell className="text-muted-foreground font-mono text-sm">
                                        {index + 1}
                                    </TableCell>
                                    <TableCell className="font-medium max-w-[300px]">
                                        <TooltipProvider>
                                            <Tooltip delayDuration={300}>
                                                <TooltipTrigger asChild>
                                                    <div className="flex items-center gap-2 min-w-0">
                                                        <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                                                        <span className="truncate">{test.name}</span>
                                                        {newTestIds.has(test.id) && (
                                                            <span className="shrink-0 inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-violet-600 text-white animate-pulse">
                                                                NEW
                                                            </span>
                                                        )}
                                                    </div>
                                                </TooltipTrigger>
                                                <TooltipContent side="right" className="max-w-[400px] text-sm break-words">
                                                    {test.name}
                                                </TooltipContent>
                                            </Tooltip>
                                        </TooltipProvider>
                                    </TableCell>
                                    <TableCell className="truncate">{test.project_name}</TableCell>
                                    <TableCell>{test.steps?.length || 0}</TableCell>
                                    <TableCell>
                                        <Badge
                                            variant="outline"
                                            className={`capitalize ${priorityStyles[test.priority?.toLowerCase()] ?? ""}`}
                                        >
                                            {test.priority}
                                        </Badge>
                                    </TableCell>
                                    <TableCell className="text-muted-foreground text-sm">
                                        {format(new Date(test.created_at), "MMM d, yyyy")}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <div className="flex items-center justify-end gap-2">
                                            <Button
                                                variant="destructive"
                                                size="sm"
                                                className="opacity-0 group-hover:opacity-100 transition-opacity duration-150 h-8"
                                                onClick={(e) => handleDeleteTest(e, test.id)}
                                            >
                                                <Trash2 />
                                                Delete
                                            </Button>
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <Button
                                                        variant="ghost"
                                                        className="h-8 w-8 p-0"
                                                        onClick={(e) => e.stopPropagation()}
                                                    >
                                                        <span className="sr-only">Open menu</span>
                                                        <MoreVertical className="h-4 w-4" />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end">
                                                    <DropdownMenuLabel>Actions</DropdownMenuLabel>
                                                    <DropdownMenuItem asChild>
                                                        <Link href={`/dashboard/tests/${test.id}`} className="cursor-pointer">
                                                            <Edit className="mr-2 h-4 w-4" /> Edit
                                                        </Link>
                                                    </DropdownMenuItem>
                                                    <DropdownMenuItem onClick={() => handleRunTest(test.id)}>
                                                        <Play className="mr-2 h-4 w-4" /> Run
                                                    </DropdownMenuItem>
                                                    <DropdownMenuSeparator />
                                                    <DropdownMenuItem
                                                        className="text-red-500 cursor-pointer"
                                                        onClick={(e) => handleDeleteTest(e as any, test.id)}
                                                    >
                                                        <Trash2 className="mr-2 h-4 w-4" /> Delete
                                                    </DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        </div>
                                    </TableCell>
                                </TableRow>
                                ))}
                                </>
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    )
}
